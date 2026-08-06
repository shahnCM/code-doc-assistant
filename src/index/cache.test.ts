import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileEmbedCache } from './cache.js';

let workDir: string | undefined;

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

describe('createFileEmbedCache', () => {
  it('[REQ] persists across two separately-constructed instances pointed at the same dir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cache-test-'));
    workDir = dir;
    const cacheA = createFileEmbedCache(dir);
    await cacheA.set('hash1', 'gemini-embedding-2', [1, 2, 3]);

    const cacheB = createFileEmbedCache(dir);
    const result = await cacheB.get('hash1', 'gemini-embedding-2');

    expect(result).toEqual([1, 2, 3]);
  });

  it("[REQ] treats a stored entry's model mismatch as a miss", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cache-test-'));
    workDir = dir;
    const cache = createFileEmbedCache(dir);
    await cache.set('hash1', 'model-a', [1, 2, 3]);

    const result = await cache.get('hash1', 'model-b');

    expect(result).toBeNull();
  });

  it('returns null on a plain cache miss', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cache-test-'));
    workDir = dir;
    const cache = createFileEmbedCache(dir);

    const result = await cache.get('never-written', 'gemini-embedding-2');

    expect(result).toBeNull();
  });

  it('creates the cache directory on first write if it does not exist yet', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cache-test-'));
    workDir = dir;
    const nested = path.join(dir, 'nested', 'embeddings');
    const cache = createFileEmbedCache(nested);

    await cache.set('hash1', 'gemini-embedding-2', [1]);
    const result = await cache.get('hash1', 'gemini-embedding-2');

    expect(result).toEqual([1]);
  });
});
