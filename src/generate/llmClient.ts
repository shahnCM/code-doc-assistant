import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { Content } from '@google/genai';
import type { Result } from '../shared/types.js';

export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

export interface GenChunk {
  text: string;
  finishReason: string | null;
}

export interface GenError {
  /**
   * 'rate-limit' / 'daily-quota' mirror EmbedError's discriminator. 'aborted' is a normal
   * outcome (a caller-cancelled request), not a service failure — callers must not retry it
   * the way they would 'rate-limit'.
   */
  kind: 'rate-limit' | 'daily-quota' | 'aborted' | 'other';
  message: string;
  retryAfterMs?: number;
}

export interface GenStreamParams {
  systemInstruction: string;
  contents: Content[];
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export interface GenClient {
  stream(params: GenStreamParams): AsyncGenerator<Result<GenChunk, GenError>, void, undefined>;
}

interface RawGenChunk {
  text?: string | undefined;
  candidates?: Array<{ finishReason?: string }>;
}

export interface GenAILike {
  models: {
    generateContentStream(args: {
      model: string;
      contents: Content[];
      config: {
        systemInstruction?: string;
        temperature?: number;
        maxOutputTokens?: number;
        thinkingConfig?: { thinkingLevel?: ThinkingLevel };
        abortSignal?: AbortSignal;
      };
    }): Promise<AsyncGenerator<RawGenChunk>>;
  };
}

function parseRetryAfterMs(message: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  const seconds = match?.[1];
  if (!seconds) return undefined;
  return Math.ceil(Number(seconds) * 1000);
}

function classifyGenError(error: unknown): GenError {
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'aborted', message: error.message };
  }

  const message = error instanceof Error ? error.message : String(error);
  const isResourceExhausted = /429|RESOURCE_EXHAUSTED/i.test(message);
  if (!isResourceExhausted) return { kind: 'other', message };

  // Gemini's quotaId distinguishes the exhausted window; a daily cap won't clear for hours,
  // so it must not be retried the same way a per-minute cap is (mirrors classifyEmbedError).
  if (/PerDay/i.test(message)) {
    return { kind: 'daily-quota', message };
  }

  const retryAfterMs = parseRetryAfterMs(message);
  return { kind: 'rate-limit', message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

async function startStream(
  ai: GenAILike,
  model: string,
  params: GenStreamParams,
): Promise<Result<AsyncGenerator<RawGenChunk>, GenError>> {
  try {
    const raw = await ai.models.generateContentStream({
      model,
      contents: params.contents,
      config: {
        systemInstruction: params.systemInstruction,
        maxOutputTokens: params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        // gemini-3.6-flash rejects thinkingBudget: 0 and charges thought tokens against
        // maxOutputTokens; MINIMAL is the only setting verified to spend none (CLAUDE.md).
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.abortSignal !== undefined ? { abortSignal: params.abortSignal } : {}),
      },
    });
    return { ok: true, value: raw };
  } catch (error) {
    return { ok: false, error: classifyGenError(error) };
  }
}

export function createGeminiGenClient(ai: GenAILike, model: string): GenClient {
  return {
    async *stream(params) {
      const started = await startStream(ai, model, params);
      if (!started.ok) {
        yield { ok: false, error: started.error };
        return;
      }

      let accumulatedText = '';
      let lastFinishReason: string | null = null;

      try {
        for await (const chunk of started.value) {
          const text = chunk.text ?? '';
          const finishReason = chunk.candidates?.[0]?.finishReason ?? null;
          accumulatedText += text;
          if (finishReason) lastFinishReason = finishReason;
          yield { ok: true, value: { text, finishReason } };
        }
      } catch (error) {
        yield { ok: false, error: classifyGenError(error) };
        return;
      }

      // A tight maxOutputTokens is silently eaten by thinking tokens on this model: the stream
      // ends cleanly with STOP-shaped chunks but no text at all. That is a failure, not an
      // empty-but-successful answer (verified against the live API — see CLAUDE.md).
      if (lastFinishReason === 'MAX_TOKENS' && accumulatedText === '') {
        yield {
          ok: false,
          error: {
            kind: 'other',
            message: 'generateContentStream finished with MAX_TOKENS and no text output',
          },
        };
      }
    },
  };
}

export function realGenClient(model: string): GenClient {
  return createGeminiGenClient(new GoogleGenAI({}), model);
}
