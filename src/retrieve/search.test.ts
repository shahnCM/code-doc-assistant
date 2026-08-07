import { describe, expect, it } from 'vitest';
import type { Db, PgDb } from '../index/db.js';
import type { EmbedClient } from '../index/embedClient.js';
import { searchChunks, toRetrievedChunk } from './search.js';

function fakeEmbedClient(vector: number[] = [0.1, 0.2, 0.3]): { client: EmbedClient; calls: string[][] } {
  const calls: string[][] = [];
  const client: EmbedClient = {
    async embedBatch(texts) {
      calls.push([...texts]);
      return { ok: true, value: texts.map(() => vector) };
    },
  };
  return { client, calls };
}

function fakeDb(rows: Array<Record<string, unknown>> = []): {
  db: Db;
  calls: Array<{ text: string; params: readonly unknown[] }>;
} {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const db: Db = {
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows };
    },
  };
  return { db, calls };
}

const fullRow: Record<string, unknown> = {
  id: 42,
  repo_source: 'https://github.com/o/r',
  file_path: 'src/add.ts',
  symbol_name: 'add',
  kind: 'function',
  signature: 'function add(a: number, b: number): number',
  start_line: 1,
  end_line: 3,
  language: 'typescript',
  chunker_kind: 'ts-morph',
  content: 'export function add(a, b) { return a + b; }',
  dense_rank: '6',
  lexical_rank: '1',
  dense_distance: 0.42,
  lexical_score: 0.887,
  fused_score: 0.031545,
};

describe('toRetrievedChunk', () => {
  it('[7] maps every snake_case column onto its camelCase field', () => {
    const chunk = toRetrievedChunk(fullRow);
    expect(chunk).toEqual({
      id: 42,
      repoSource: 'https://github.com/o/r',
      filePath: 'src/add.ts',
      symbolName: 'add',
      kind: 'function',
      signature: 'function add(a: number, b: number): number',
      startLine: 1,
      endLine: 3,
      language: 'typescript',
      chunkerKind: 'ts-morph',
      content: 'export function add(a, b) { return a + b; }',
      denseRank: 6,
      lexicalRank: 1,
      denseDistance: 0.42,
      lexicalScore: 0.887,
      fusedScore: 0.031545,
    });
  });

  it('[8] coerces bigint rank columns arriving as strings to numbers', () => {
    const chunk = toRetrievedChunk({ ...fullRow, dense_rank: '6', lexical_rank: '1' });
    expect(chunk.denseRank).toBe(6);
    expect(chunk.lexicalRank).toBe(1);
    expect(typeof chunk.denseRank).toBe('number');
    expect(typeof chunk.lexicalRank).toBe('number');
  });

  it('[9] maps a null lexical_rank to null, not 0', () => {
    const chunk = toRetrievedChunk({ ...fullRow, lexical_rank: null, lexical_score: null });
    expect(chunk.lexicalRank).toBeNull();
    expect(chunk.lexicalRank).not.toBe(0);
  });
});

describe('searchChunks', () => {
  it('[6] embeds the query exactly once as a single-element array and binds the vector literal at $1', async () => {
    const { client, calls: embedCalls } = fakeEmbedClient([1, 0, 0]);
    const { db, calls: dbCalls } = fakeDb([fullRow]);

    const result = await searchChunks('parseConfig', 'postgres://unused', 'gemini-embedding-2', {
      embedClient: client,
      db,
    });

    expect(result.ok).toBe(true);
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toEqual(['parseConfig']);
    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0]?.params[0]).toBe('[1,0,0]');
  });

  it('[10][REQ] an empty rowset returns [] and does not throw', async () => {
    const { client } = fakeEmbedClient();
    const { db } = fakeDb([]);

    const result = await searchChunks('anything', 'postgres://unused', 'gemini-embedding-2', {
      embedClient: client,
      db,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('[11] an embed failure short-circuits before any query is issued', async () => {
    const client: EmbedClient = {
      async embedBatch() {
        return { ok: false, error: { kind: 'other', message: 'boom' } };
      },
    };
    const { db, calls: dbCalls } = fakeDb([fullRow]);

    const result = await searchChunks('anything', 'postgres://unused', 'gemini-embedding-2', {
      embedClient: client,
      db,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('embed');
    expect(dbCalls).toHaveLength(0);
  });

  it('[12] never ends an injected db', async () => {
    const { client } = fakeEmbedClient();
    const { db } = fakeDb([fullRow]);
    let dbFactoryCalled = false;
    const dbFactory = (): PgDb => {
      dbFactoryCalled = true;
      return { db, end: async () => {} };
    };

    const result = await searchChunks('anything', 'postgres://unused', 'gemini-embedding-2', {
      embedClient: client,
      db,
      dbFactory,
    });

    expect(result.ok).toBe(true);
    expect(dbFactoryCalled).toBe(false);
  });

  it('[12] with no injected db, creates one via dbFactory and ends it even when the query rejects', async () => {
    const { client } = fakeEmbedClient();
    let endCalls = 0;
    const rejectingDb: Db = {
      async query() {
        throw new Error('connection refused');
      },
    };
    const dbFactory = (): PgDb => ({
      db: rejectingDb,
      end: async () => {
        endCalls += 1;
      },
    });

    const result = await searchChunks('anything', 'postgres://unused', 'gemini-embedding-2', {
      embedClient: client,
      dbFactory,
    });

    expect(result.ok).toBe(false);
    expect(endCalls).toBe(1);
  });

  it('[12] with no injected db, creates one via dbFactory and ends it on success', async () => {
    const { client } = fakeEmbedClient();
    const { db } = fakeDb([fullRow]);
    let endCalls = 0;
    const dbFactory = (): PgDb => ({
      db,
      end: async () => {
        endCalls += 1;
      },
    });

    const result = await searchChunks('anything', 'postgres://unused', 'gemini-embedding-2', {
      embedClient: client,
      dbFactory,
    });

    expect(result.ok).toBe(true);
    expect(endCalls).toBe(1);
  });
});
