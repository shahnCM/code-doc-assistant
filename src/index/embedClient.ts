import { GoogleGenAI } from '@google/genai';
import type { Result } from '../shared/types.js';
import { EMBEDDING_DIM } from './constants.js';

export interface EmbedError {
  /**
   * 'rate-limit' (per-minute) is worth retrying — the window clears within seconds.
   * 'daily-quota' won't clear for hours; retrying it is a wasted wait, not a transient blip.
   * 'aborted' is a normal outcome (a caller-cancelled request), not a service failure.
   */
  kind: 'rate-limit' | 'daily-quota' | 'aborted' | 'other';
  message: string;
  /** Server-suggested wait, in ms, parsed from a 429's `retryDelay` field when present. */
  retryAfterMs?: number;
}

export interface EmbedClient {
  embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<Result<number[][], EmbedError>>;
}

export interface GenAILike {
  models: {
    embedContent(args: {
      model: string;
      contents: Array<{ parts: Array<{ text: string }> }>;
      config: { outputDimensionality: number; abortSignal?: AbortSignal };
    }): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
  };
}

function parseRetryAfterMs(message: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  const seconds = match?.[1];
  if (!seconds) return undefined;
  return Math.ceil(Number(seconds) * 1000);
}

function classifyEmbedError(error: unknown): EmbedError {
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: 'aborted', message: error.message };
  }

  const message = error instanceof Error ? error.message : String(error);
  const isResourceExhausted = /429|RESOURCE_EXHAUSTED/i.test(message);
  if (!isResourceExhausted) return { kind: 'other', message };

  // Gemini's quotaId distinguishes the exhausted window (e.g. "...PerDay..." vs
  // "...PerMinute..."); a daily cap won't clear for hours, so it must not be retried
  // the same way a per-minute cap is.
  if (/PerDay/i.test(message)) {
    return { kind: 'daily-quota', message };
  }

  const retryAfterMs = parseRetryAfterMs(message);
  return { kind: 'rate-limit', message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

export function createGeminiEmbedClient(ai: GenAILike, model: string): EmbedClient {
  return {
    async embedBatch(texts, signal) {
      try {
        const res = await ai.models.embedContent({
          model,
          contents: texts.map((text) => ({ parts: [{ text }] })),
          config: {
            outputDimensionality: EMBEDDING_DIM,
            ...(signal !== undefined ? { abortSignal: signal } : {}),
          },
        });
        const embeddings = res.embeddings;
        if (!embeddings) {
          return { ok: false, error: { kind: 'other', message: 'embedContent returned no embeddings' } };
        }
        const values: number[][] = [];
        for (const embedding of embeddings) {
          if (!embedding.values) {
            return { ok: false, error: { kind: 'other', message: 'embedContent returned an embedding with no values' } };
          }
          values.push(embedding.values);
        }
        return { ok: true, value: values };
      } catch (error) {
        return { ok: false, error: classifyEmbedError(error) };
      }
    },
  };
}

export function realEmbedClient(model: string): EmbedClient {
  return createGeminiEmbedClient(new GoogleGenAI({}), model);
}
