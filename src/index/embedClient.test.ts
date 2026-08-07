import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIM } from './constants.js';
import { createGeminiEmbedClient, type GenAILike } from './embedClient.js';

interface CapturedCall {
  model: string;
  contents: Array<{ parts: Array<{ text: string }> }>;
  config: { outputDimensionality: number; abortSignal?: AbortSignal };
}

function fakeGenAI(
  respond: (call: CapturedCall) => { embeddings: Array<{ values: number[] }> },
): { ai: GenAILike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const ai: GenAILike = {
    models: {
      async embedContent(args) {
        calls.push(args);
        return respond(args);
      },
    },
  };
  return { ai, calls };
}

describe('createGeminiEmbedClient', () => {
  it('[REQ] wraps every text as { parts: [{ text }] }, never a raw string array, and sets outputDimensionality on every call', async () => {
    const { ai, calls } = fakeGenAI(() => ({
      embeddings: [{ values: [0] }, { values: [0] }, { values: [0] }],
    }));
    const client = createGeminiEmbedClient(ai, 'gemini-embedding-2');

    await client.embedBatch(['a', 'b', 'c']);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.contents).toEqual([{ parts: [{ text: 'a' }] }, { parts: [{ text: 'b' }] }, { parts: [{ text: 'c' }] }]);
    expect(call?.config.outputDimensionality).toBe(EMBEDDING_DIM);
    expect(call?.model).toBe('gemini-embedding-2');
  });

  it('[REQ] reads res.embeddings[i].values (not res.embedding.values) and preserves input order', async () => {
    const { ai } = fakeGenAI((call) => ({
      embeddings: call.contents.map((c, i) => ({ values: [i, c.parts[0]?.text.length ?? 0] })),
    }));
    const client = createGeminiEmbedClient(ai, 'gemini-embedding-2');

    const result = await client.embedBatch(['x', 'yy', 'zzz']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('classifies a rate-limit error distinctly from other errors', async () => {
    const ai: GenAILike = {
      models: {
        async embedContent() {
          throw new Error('429 RESOURCE_EXHAUSTED: quota');
        },
      },
    };
    const client = createGeminiEmbedClient(ai, 'gemini-embedding-2');

    const result = await client.embedBatch(['a']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate-limit');
  });

  it('classifies a non-rate-limit error as other', async () => {
    const ai: GenAILike = {
      models: {
        async embedContent() {
          throw new Error('400 invalid request');
        },
      },
    };
    const client = createGeminiEmbedClient(ai, 'gemini-embedding-2');

    const result = await client.embedBatch(['a']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('other');
  });

  it('parses retryAfterMs (in ms) from a real Gemini 429 response body', async () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota... Please retry in 51.711186859s.',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '51s' }],
      },
    });
    const ai: GenAILike = {
      models: {
        async embedContent() {
          throw new Error(body);
        },
      },
    };
    const client = createGeminiEmbedClient(ai, 'gemini-embedding-2');

    const result = await client.embedBatch(['a']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate-limit');
    expect(result.error.retryAfterMs).toBe(51_000);
  });

  it('leaves retryAfterMs undefined when the rate-limit error has no parseable retryDelay', async () => {
    const ai: GenAILike = {
      models: {
        async embedContent() {
          throw new Error('429 RESOURCE_EXHAUSTED: quota, no structured detail');
        },
      },
    };
    const client = createGeminiEmbedClient(ai, 'gemini-embedding-2');

    const result = await client.embedBatch(['a']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryAfterMs).toBeUndefined();
  });

  it("[REQ] classifies a daily-quota-exhausted error distinctly from a per-minute 429, so it won't be retried into a wall that won't clear for hours", async () => {
    const dailyQuotaBody = JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota... Please retry in 59.698796327s.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              {
                quotaMetric: 'generativelanguage.googleapis.com/embed_content_free_tier_requests',
                quotaId: 'EmbedContentRequestsPerDayPerProjectPerModel-FreeTier',
                quotaDimensions: { model: 'gemini-embedding-2', location: 'global' },
              },
            ],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '59s' },
        ],
      },
    });
    const ai: GenAILike = {
      models: {
        async embedContent() {
          throw new Error(dailyQuotaBody);
        },
      },
    };
    const client = createGeminiEmbedClient(ai, 'gemini-embedding-2');

    const result = await client.embedBatch(['a']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('daily-quota');
  });

  it('still classifies a per-minute 429 as rate-limit, not daily-quota', async () => {
    const perMinuteBody = JSON.stringify({
      error: {
        code: 429,
        message: 'You exceeded your current quota... Please retry in 21.575377394s.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              {
                quotaMetric: 'generativelanguage.googleapis.com/embed_content_free_tier_requests',
                quotaId: 'EmbedContentRequestsPerMinutePerProjectPerModel-FreeTier',
                quotaDimensions: { model: 'gemini-embedding-2', location: 'global' },
              },
            ],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '21s' },
        ],
      },
    });
    const ai: GenAILike = {
      models: {
        async embedContent() {
          throw new Error(perMinuteBody);
        },
      },
    };
    const client = createGeminiEmbedClient(ai, 'gemini-embedding-2');

    const result = await client.embedBatch(['a']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate-limit');
  });

  it('passes an abortSignal through to config.abortSignal when one is given, and omits the key otherwise', async () => {
    const { ai, calls } = fakeGenAI(() => ({ embeddings: [{ values: [0] }] }));
    const client = createGeminiEmbedClient(ai, 'gemini-embedding-2');
    const controller = new AbortController();

    await client.embedBatch(['a'], controller.signal);
    await client.embedBatch(['b']);

    expect(calls[0]?.config).toEqual({ outputDimensionality: EMBEDDING_DIM, abortSignal: controller.signal });
    expect(calls[1]?.config).toEqual({ outputDimensionality: EMBEDDING_DIM });
  });

  it('[REQ] classifies an AbortError as kind aborted, never other — keyed on error.name, since instanceof Error is true for both', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const ai: GenAILike = {
      models: {
        async embedContent() {
          throw abortError;
        },
      },
    };
    const client = createGeminiEmbedClient(ai, 'gemini-embedding-2');

    const result = await client.embedBatch(['a']);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('aborted');
  });
});
