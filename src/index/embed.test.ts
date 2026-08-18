import { describe, expect, it } from 'vitest';
import type { Chunk } from '../shared/types.js';
import type { EmbedCache } from './cache.js';
import type { Db } from './db.js';
import type { EmbedClient } from './embedClient.js';
import { indexChunks } from './embed.js';

function fakeCache(initial: Map<string, { model: string; vector: number[] }> = new Map()): EmbedCache {
  return {
    async get(hash, model) {
      const entry = initial.get(hash);
      if (!entry || entry.model !== model) return null;
      return entry.vector;
    },
    async set(hash, model, vector) {
      initial.set(hash, { model, vector: [...vector] });
    },
  };
}

function fakeEmbedClient(): { client: EmbedClient; calls: string[][] } {
  const calls: string[][] = [];
  const client: EmbedClient = {
    async embedBatch(texts) {
      calls.push([...texts]);
      return { ok: true, value: texts.map((text) => [text.length, 0, 0]) };
    },
  };
  return { client, calls };
}

function fakeDb(options: { existingRows?: number } = {}): {
  db: Db;
  calls: Array<{ text: string; params: readonly unknown[] }>;
} {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const db: Db = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (/DELETE FROM chunks/i.test(text)) {
        const existing = options.existingRows ?? 0;
        return { rows: Array.from({ length: existing }, (_, i) => ({ id: i + 1 })) };
      }
      return { rows: [{ id: calls.length }] };
    },
    withTransaction: async (fn) => fn(db),
  };
  return { db, calls };
}

function testChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    filePath: 'src/add.ts',
    symbolName: 'add',
    kind: 'function',
    signature: 'function add(a: number, b: number): number',
    jsDoc: null,
    startLine: 1,
    endLine: 3,
    parentSymbol: null,
    isExported: true,
    contentHash: 'hash-1',
    language: 'typescript',
    chunkerKind: 'ts-morph',
    partIndex: 1,
    partTotal: 1,
    content: 'export function add(a, b) { return a + b; }',
    embedText: 'file: src/add.ts\nkind: function\n\nexport function add...',
    ...overrides,
  };
}

describe('indexChunks', () => {
  it('[REQ] a cache hit skips the API call entirely', async () => {
    const chunk = testChunk();
    const cache = fakeCache(new Map([[chunk.contentHash, { model: 'gemini-embedding-2', vector: [1, 2, 3] }]]));
    const { client, calls } = fakeEmbedClient();
    const { db } = fakeDb();

    const result = await indexChunks([chunk], 'https://github.com/o/r', 'postgres://unused', 'gemini-embedding-2', {
      embedClient: client,
      cache,
      db,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(0);
    expect(result.value.cacheHits).toBe(1);
    expect(result.value.embedded).toBe(0);
  });

  it('[REQ] dedups two chunks sharing one contentHash — embed client called once, both inserts carry the identical embedding', async () => {
    const a = testChunk({ symbolName: 'add', contentHash: 'shared-hash' });
    const b = testChunk({ symbolName: 'addAlias', contentHash: 'shared-hash' });
    const cache = fakeCache();
    const { client, calls } = fakeEmbedClient();
    const { db, calls: dbCalls } = fakeDb();

    const result = await indexChunks([a, b], 'https://github.com/o/r', 'postgres://unused', 'gemini-embedding-2', {
      embedClient: client,
      cache,
      db,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(dbCalls[0]?.text).toMatch(/DELETE FROM chunks/i);
    const inserts = dbCalls.filter((c) => /INSERT INTO chunks/i.test(c.text));
    expect(inserts).toHaveLength(2);
    const lastParamOf = (call: { params: readonly unknown[] }): unknown => call.params[call.params.length - 1];
    expect(inserts[0] && lastParamOf(inserts[0])).toEqual(inserts[1] && lastParamOf(inserts[1]));
  });

  it('[REQ] the returned IndexReport reconciles totalChunks, uniqueHashes, cacheHits, embedded, deleted, and inserted', async () => {
    const cachedChunk = testChunk({ contentHash: 'cached-hash', symbolName: 'cached' });
    const freshChunk1 = testChunk({ contentHash: 'fresh-hash', symbolName: 'fresh1' });
    const freshChunk2 = testChunk({ contentHash: 'fresh-hash', symbolName: 'fresh2' });
    const cache = fakeCache(new Map([['cached-hash', { model: 'gemini-embedding-2', vector: [9, 9, 9] }]]));
    const { client } = fakeEmbedClient();
    const { db } = fakeDb();

    const result = await indexChunks(
      [cachedChunk, freshChunk1, freshChunk2],
      'https://github.com/o/r',
      'postgres://unused',
      'gemini-embedding-2',
      { embedClient: client, cache, db },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalChunks).toBe(3);
    expect(result.value.uniqueHashes).toBe(2);
    expect(result.value.cacheHits).toBe(1);
    expect(result.value.embedded).toBe(1);
    expect(result.value.inserted).toBe(3);
  });

  it('[REQ] the report separates rows cleared from rows written, so "nothing changed" cannot read as "everything was rejected"', async () => {
    const chunk = testChunk({ contentHash: 'hash-1' });
    const cache = fakeCache();
    const { client } = fakeEmbedClient();
    const { db } = fakeDb({ existingRows: 7 });

    const result = await indexChunks([chunk], 'https://github.com/o/r', 'postgres://unused', 'gemini-embedding-2', {
      embedClient: client,
      cache,
      db,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deleted).toBe(7);
    expect(result.value.inserted).toBe(1);
  });

  it('[25][REQ] a cancelled embedding batch writes no partial entries to the content-hash cache', async () => {
    const chunk = testChunk();
    const setCalls: unknown[] = [];
    const cache: EmbedCache = {
      async get() {
        return null;
      },
      async set(hash, model, vector) {
        setCalls.push({ hash, model, vector });
      },
    };
    const controller = new AbortController();
    controller.abort();
    const client: EmbedClient = {
      async embedBatch(texts, signal) {
        expect(signal?.aborted).toBe(true);
        return { ok: false, error: { kind: 'aborted', message: 'aborted' } };
      },
    };
    const { db, calls: dbCalls } = fakeDb();

    const result = await indexChunks([chunk], 'https://github.com/o/r', 'postgres://unused', 'gemini-embedding-2', {
      embedClient: client,
      cache,
      db,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(setCalls).toHaveLength(0);
    expect(dbCalls).toHaveLength(0);
  });

  it('propagates an embedding failure without writing anything to the db', async () => {
    const chunk = testChunk();
    const cache = fakeCache();
    const client: EmbedClient = {
      async embedBatch() {
        return { ok: false, error: { kind: 'other', message: 'boom' } };
      },
    };
    const { db, calls: dbCalls } = fakeDb();

    const result = await indexChunks([chunk], 'https://github.com/o/r', 'postgres://unused', 'gemini-embedding-2', {
      embedClient: client,
      cache,
      db,
    });

    expect(result.ok).toBe(false);
    expect(dbCalls).toHaveLength(0);
  });
});
