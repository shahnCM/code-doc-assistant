import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Content, ThinkingLevel } from '@google/genai';
import { describe, expect, it } from 'vitest';
import type { Result } from '../shared/types.js';
import { createGeminiGenClient, type GenAILike, type GenChunk, type GenError } from './llmClient.js';

const LLM_CLIENT_PATH = fileURLToPath(new URL('./llmClient.ts', import.meta.url));

interface FakeChunk {
  text?: string;
  candidates?: Array<{ finishReason?: string }>;
}

interface CapturedCall {
  model: string;
  contents: Content[];
  config: {
    systemInstruction?: string;
    temperature?: number;
    maxOutputTokens?: number;
    thinkingConfig?: { thinkingLevel?: ThinkingLevel };
    abortSignal?: AbortSignal;
  };
}

function fakeStreamingGenAI(chunks: FakeChunk[]): { ai: GenAILike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const ai: GenAILike = {
    models: {
      async generateContentStream(args) {
        calls.push(args);
        async function* generator() {
          for (const chunk of chunks) {
            yield chunk;
          }
        }
        return generator();
      },
    },
  };
  return { ai, calls };
}

async function collect(
  client: ReturnType<typeof createGeminiGenClient>,
  params: Parameters<ReturnType<typeof createGeminiGenClient>['stream']>[0],
): Promise<Array<Result<GenChunk, GenError>>> {
  const results: Array<Result<GenChunk, GenError>> = [];
  for await (const item of client.stream(params)) {
    results.push(item);
  }
  return results;
}

describe('createGeminiGenClient', () => {
  it('[15] calls generateContentStream exactly once with systemInstruction, temperature, maxOutputTokens, thinkingConfig.thinkingLevel MINIMAL and abortSignal inside config, and never references the old SDK shape', async () => {
    const { ai, calls } = fakeStreamingGenAI([{ text: 'hi', candidates: [{ finishReason: 'STOP' }] }]);
    const client = createGeminiGenClient(ai, 'gemini-3.6-flash');
    const controller = new AbortController();
    const contents: Content[] = [{ role: 'user', parts: [{ text: 'hello' }] }];

    await collect(client, {
      systemInstruction: 'system prompt text',
      contents,
      temperature: 0.2,
      maxOutputTokens: 512,
      abortSignal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      model: 'gemini-3.6-flash',
      contents,
      config: {
        systemInstruction: 'system prompt text',
        temperature: 0.2,
        maxOutputTokens: 512,
        thinkingConfig: { thinkingLevel: 'MINIMAL' },
        abortSignal: controller.signal,
      },
    });

    const source = readFileSync(LLM_CLIENT_PATH, 'utf8');
    expect(source).not.toContain('getGenerativeModel');
    expect(source).not.toContain('generationConfig');
  });

  it('[16] yields one GenChunk per SDK chunk, defaulting text to an empty string when the accessor is undefined', async () => {
    const { ai } = fakeStreamingGenAI([
      { candidates: [{}] },
      { text: 'hello', candidates: [{ finishReason: 'STOP' }] },
    ]);
    const client = createGeminiGenClient(ai, 'gemini-3.6-flash');

    const results = await collect(client, { systemInstruction: 's', contents: [] });

    expect(results).toEqual([
      { ok: true, value: { text: '', finishReason: null } },
      { ok: true, value: { text: 'hello', finishReason: 'STOP' } },
    ]);
  });

  it('[17] surfaces finishReason MAX_TOKENS with empty accumulated text as an error, not a successful empty answer', async () => {
    const { ai } = fakeStreamingGenAI([{ candidates: [{ finishReason: 'MAX_TOKENS' }] }]);
    const client = createGeminiGenClient(ai, 'gemini-3.6-flash');

    const results = await collect(client, { systemInstruction: 's', contents: [] });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ ok: true, value: { text: '', finishReason: 'MAX_TOKENS' } });
    const second = results[1];
    expect(second?.ok).toBe(false);
    if (second?.ok !== false) return;
    expect(second.error.kind).toBe('other');
  });

  it('[18] classifies a 429 as rate-limit or daily-quota using the same PerDay discriminator as classifyEmbedError, and parses retryDelay into retryAfterMs', async () => {
    const rateLimitAi: GenAILike = {
      models: {
        async generateContentStream() {
          throw new Error('429 RESOURCE_EXHAUSTED: "retryDelay":"5s"');
        },
      },
    };
    const rateLimitResults = await collect(createGeminiGenClient(rateLimitAi, 'gemini-3.6-flash'), {
      systemInstruction: 's',
      contents: [],
    });
    expect(rateLimitResults).toHaveLength(1);
    const rateLimitResult = rateLimitResults[0];
    expect(rateLimitResult?.ok).toBe(false);
    if (rateLimitResult?.ok !== false) return;
    expect(rateLimitResult.error.kind).toBe('rate-limit');
    expect(rateLimitResult.error.retryAfterMs).toBe(5000);

    const dailyQuotaAi: GenAILike = {
      models: {
        async generateContentStream() {
          throw new Error(
            '429 RESOURCE_EXHAUSTED: quotaId GenerateContentRequestsPerDayPerProjectPerModel-FreeTier',
          );
        },
      },
    };
    const dailyResults = await collect(createGeminiGenClient(dailyQuotaAi, 'gemini-3.6-flash'), {
      systemInstruction: 's',
      contents: [],
    });
    expect(dailyResults).toHaveLength(1);
    const dailyResult = dailyResults[0];
    expect(dailyResult?.ok).toBe(false);
    if (dailyResult?.ok !== false) return;
    expect(dailyResult.error.kind).toBe('daily-quota');
  });

  it('[19][REQ] classifies an AbortError as kind aborted, never other — keyed on error.name, since instanceof Error is true for both', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const ai: GenAILike = {
      models: {
        async generateContentStream() {
          throw abortError;
        },
      },
    };

    const results = await collect(createGeminiGenClient(ai, 'gemini-3.6-flash'), {
      systemInstruction: 's',
      contents: [],
    });

    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) return;
    expect(result.error.kind).toBe('aborted');
  });
});
