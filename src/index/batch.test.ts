import { describe, expect, it } from 'vitest';
import type { EmbedClient } from './embedClient.js';
import { embedTexts } from './batch.js';

function fakeEmbedClientWithFailures(failText: string, failCount: number) {
  const callCounts = new Map<string, number>();
  const client: EmbedClient = {
    async embedBatch(texts) {
      const key = texts.join('|');
      const count = (callCounts.get(key) ?? 0) + 1;
      callCounts.set(key, count);
      if (texts.includes(failText) && count <= failCount) {
        return { ok: false, error: { kind: 'rate-limit', message: 'rate limited' } };
      }
      return { ok: true, value: texts.map((t) => [t.length]) };
    },
  };
  return { client, callCounts };
}

describe('embedTexts', () => {
  it('[REQ] batching respects the concurrency cap', async () => {
    let current = 0;
    let maxObserved = 0;
    const client: EmbedClient = {
      async embedBatch(texts) {
        current++;
        maxObserved = Math.max(maxObserved, current);
        await new Promise((resolve) => setTimeout(resolve, 5));
        current--;
        return { ok: true, value: texts.map(() => [0]) };
      },
    };
    const texts = Array.from({ length: 12 }, (_, i) => `t${i}`);

    const result = await embedTexts(texts, client, { batchSize: 1, concurrency: 5 });

    expect(result.ok).toBe(true);
    expect(maxObserved).toBeLessThanOrEqual(5);
    expect(maxObserved).toBeGreaterThan(1);
  });

  it('[REQ] a failed batch retries without corrupting the run', async () => {
    const { client, callCounts } = fakeEmbedClientWithFailures('bb', 2);

    const result = await embedTexts(['a', 'bb', 'ccc', 'dddd'], client, {
      batchSize: 1,
      concurrency: 4,
      baseDelayMs: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([[1], [2], [3], [4]]);
    expect(callCounts.get('a')).toBe(1);
    expect(callCounts.get('bb')).toBe(3);
    expect(callCounts.get('ccc')).toBe(1);
    expect(callCounts.get('dddd')).toBe(1);
  });

  it('a non-retryable error fails fast, after exactly one attempt', async () => {
    let calls = 0;
    const client: EmbedClient = {
      async embedBatch() {
        calls++;
        return { ok: false, error: { kind: 'other', message: 'bad request' } };
      },
    };

    const result = await embedTexts(['a', 'b', 'c'], client, { batchSize: 10, concurrency: 1, maxRetries: 5 });

    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('exhausting retries on a persistent rate-limit error still fails, not looping forever', async () => {
    const { client } = fakeEmbedClientWithFailures('a', Number.POSITIVE_INFINITY);

    const result = await embedTexts(['a'], client, { batchSize: 1, concurrency: 1, maxRetries: 2, baseDelayMs: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate-limit');
  });

  it('preserves original text order across concurrently-processed batches', async () => {
    const client: EmbedClient = {
      async embedBatch(texts) {
        const delay = texts[0] === 't0' ? 20 : 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return { ok: true, value: texts.map((t) => [Number(t.slice(1))]) };
      },
    };
    const texts = Array.from({ length: 6 }, (_, i) => `t${i}`);

    const result = await embedTexts(texts, client, { batchSize: 1, concurrency: 6 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([[0], [1], [2], [3], [4], [5]]);
  });
});
