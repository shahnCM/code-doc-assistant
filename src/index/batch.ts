import type { Result } from '../shared/types.js';
import type { EmbedClient, EmbedError } from './embedClient.js';

export interface EmbedBatchOptions {
  batchSize?: number;
  concurrency?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_RETRIES = 20;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_BACKOFF_MS = 65_000;

function chunkInto<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Prefers the server's own suggested wait (parsed from a 429's `retryDelay`) over blind
 * exponential backoff — verified against the real free-tier quota (100 embed_content
 * "requests" per minute, counted per text) that a fixed exponential schedule undershoots.
 */
function computeRetryDelayMs(error: EmbedError, attempt: number, baseDelayMs: number): number {
  if (error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, MAX_BACKOFF_MS);
  }
  const exponential = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
  return Math.min(exponential, MAX_BACKOFF_MS);
}

async function embedBatchWithRetry(
  batch: readonly string[],
  client: EmbedClient,
  maxRetries: number,
  baseDelayMs: number,
  signal: AbortSignal | undefined,
): Promise<Result<number[][], EmbedError>> {
  let attempt = 0;
  for (;;) {
    const result = await client.embedBatch(batch, signal);
    if (result.ok) return result;
    if (result.error.kind !== 'rate-limit' || attempt >= maxRetries) return result;
    await sleep(computeRetryDelayMs(result.error, attempt, baseDelayMs));
    attempt += 1;
  }
}

export async function embedTexts(
  texts: readonly string[],
  client: EmbedClient,
  options: EmbedBatchOptions = {},
): Promise<Result<number[][], EmbedError>> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  const batches = chunkInto(texts, batchSize);
  const results: Array<number[][] | undefined> = new Array(batches.length);
  let cursor = 0;
  let failure: EmbedError | undefined;

  async function worker(): Promise<void> {
    for (;;) {
      if (failure) return;
      const index = cursor;
      cursor += 1;
      if (index >= batches.length) return;
      const batch = batches[index];
      if (!batch) continue;
      const result = await embedBatchWithRetry(batch, client, maxRetries, baseDelayMs, options.signal);
      if (!result.ok) {
        failure = result.error;
        return;
      }
      results[index] = result.value;
    }
  }

  const workerCount = Math.min(concurrency, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failure) return { ok: false, error: failure };

  const value: number[][] = [];
  for (const batchResult of results) {
    if (batchResult) value.push(...batchResult);
  }
  return { ok: true, value };
}
