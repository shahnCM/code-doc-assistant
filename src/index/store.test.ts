import { describe, expect, it } from 'vitest';
import type { Chunk } from '../shared/types.js';
import type { Db } from './db.js';
import { replaceChunks } from './store.js';

// The fake restores its table when the callback fails, because replaceChunks now depends on
// rollback for correctness — without it, a mid-insert failure would leave the DELETE applied and
// the tests below could not tell the two outcomes apart. It models the contract only; that real
// Postgres honours it is asserted in the db contract test, not here.
function fakeDb(options: { failOnHash?: string } = {}): {
  db: Db;
  calls: Array<{ text: string; params: readonly unknown[] }>;
  table: Map<string, Record<string, unknown>>;
} {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const table = new Map<string, Record<string, unknown>>();
  let nextId = 1;

  const db: Db = {
    async query(text: string, params: readonly unknown[] = []) {
      calls.push({ text, params });

      if (/DELETE FROM chunks/i.test(text)) {
        const repoSource = params[0];
        const removed: Array<Record<string, unknown>> = [];
        for (const [key, row] of table) {
          if (row['repo_source'] === repoSource) {
            removed.push({ id: row['id'] });
            table.delete(key);
          }
        }
        return { rows: removed };
      }

      const columnsMatch = /INSERT INTO chunks \(([^)]+)\)/i.exec(text);
      if (!columnsMatch) return { rows: [] };
      const columnList = columnsMatch[1];
      const columns = columnList ? columnList.split(',').map((c) => c.trim()) : [];

      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = params[i];
      });

      if (options.failOnHash !== undefined && row['content_hash'] === options.failOnHash) {
        throw new Error(`insert failed for ${options.failOnHash}`);
      }

      const conflictMatch = /ON CONFLICT \(([^)]+)\)/i.exec(text);
      const conflictColumnList = conflictMatch?.[1];
      const conflictCols = conflictColumnList ? conflictColumnList.split(',').map((c) => c.trim()) : [];
      const key = conflictCols.map((c) => row[c]).join('::');

      if (table.has(key)) {
        return { rows: [] };
      }

      const id = nextId;
      nextId += 1;
      table.set(key, { id, ...row });
      return { rows: [{ id }] };
    },

    withTransaction: async (fn) => {
      const snapshot = new Map(table);
      const restore = () => {
        table.clear();
        for (const [key, row] of snapshot) table.set(key, row);
      };
      try {
        const result = await fn(db);
        if (!result.ok) restore();
        return result;
      } catch (error) {
        restore();
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };

  return { db, calls, table };
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
    content: 'export function add(a: number, b: number): number {\n  return a + b;\n}',
    embedText: 'file: src/add.ts\nkind: function\n\nexport function add...',
    ...overrides,
  };
}

describe('replaceChunks', () => {
  it('[REQ] inserts a new row for a fresh (repo_source, content_hash) pair with every mapped column present', async () => {
    const { db, calls } = fakeDb();
    const chunk = testChunk();

    const result = await replaceChunks(db, 'https://github.com/o/r', [
      { chunk, embedding: [0.1, 0.2, 0.3] },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ deleted: 0, inserted: 1 });

    const insert = calls.find((c) => /INSERT INTO chunks/i.test(c.text));
    expect(insert?.params).toContain('https://github.com/o/r');
    expect(insert?.params).toContain(chunk.filePath);
    expect(insert?.params).toContain(chunk.contentHash);
    expect(insert?.params).toContain(chunk.content);
    expect(insert?.params).toContain(chunk.embedText);
  });

  it('[REQ] a re-ingest with shifted line numbers stores the new start_line/end_line', async () => {
    const { db, table } = fakeDb();
    const repoSource = 'https://github.com/o/r';
    const original = testChunk({ startLine: 10, endLine: 12 });

    const first = await replaceChunks(db, repoSource, [{ chunk: original, embedding: [0.1] }]);
    expect(first.ok && first.value).toEqual({ deleted: 0, inserted: 1 });

    const shifted = testChunk({ startLine: 55, endLine: 57 });
    const second = await replaceChunks(db, repoSource, [{ chunk: shifted, embedding: [0.1] }]);
    expect(second.ok && second.value).toEqual({ deleted: 1, inserted: 1 });

    const stored = table.get(`${repoSource}::${original.contentHash}`);
    expect(stored?.start_line).toBe(55);
    expect(stored?.end_line).toBe(57);
  });

  it('[REQ] a re-ingest with a new embedding replaces the stored vector', async () => {
    const { db, table } = fakeDb();
    const repoSource = 'https://github.com/o/r';
    const chunk = testChunk();

    await replaceChunks(db, repoSource, [{ chunk, embedding: [0.1] }]);
    expect(table.get(`${repoSource}::${chunk.contentHash}`)?.embedding).toBe('[0.1]');

    await replaceChunks(db, repoSource, [{ chunk, embedding: [0.9] }]);
    expect(table.get(`${repoSource}::${chunk.contentHash}`)?.embedding).toBe('[0.9]');
  });

  it('[REQ] a chunk absent from the new set is gone after the run', async () => {
    const { db, table } = fakeDb();
    const repoSource = 'https://github.com/o/r';
    const kept = testChunk({ contentHash: 'hash-kept', symbolName: 'kept' });
    const removed = testChunk({ contentHash: 'hash-removed', symbolName: 'removed' });

    await replaceChunks(db, repoSource, [
      { chunk: kept, embedding: [0.1] },
      { chunk: removed, embedding: [0.2] },
    ]);
    expect(table.size).toBe(2);

    const second = await replaceChunks(db, repoSource, [{ chunk: kept, embedding: [0.1] }]);

    expect(second.ok && second.value).toEqual({ deleted: 2, inserted: 1 });
    expect(table.size).toBe(1);
    expect(table.has(`${repoSource}::hash-removed`)).toBe(false);
    expect(table.has(`${repoSource}::hash-kept`)).toBe(true);
  });

  it('[REQ] the delete is scoped to one repo_source — another source keeps its rows', async () => {
    const { db, table } = fakeDb();
    const chunk = testChunk();

    await replaceChunks(db, 'https://github.com/o/r1', [{ chunk, embedding: [0.1] }]);
    const second = await replaceChunks(db, 'https://github.com/o/r2', [{ chunk, embedding: [0.1] }]);

    expect(second.ok && second.value).toEqual({ deleted: 0, inserted: 1 });
    expect(table.size).toBe(2);
    expect(table.has(`https://github.com/o/r1::${chunk.contentHash}`)).toBe(true);
  });

  it('two chunks sharing a content_hash within one run still collapse to one row', async () => {
    const { db, table } = fakeDb();
    const a = testChunk({ symbolName: 'a' });
    const b = testChunk({ symbolName: 'b' });

    const result = await replaceChunks(db, 'https://github.com/o/r', [
      { chunk: a, embedding: [0.1] },
      { chunk: b, embedding: [0.1] },
    ]);

    expect(result.ok && result.value).toEqual({ deleted: 0, inserted: 1 });
    expect(table.size).toBe(1);
  });

  it('[REQ] a failure mid-insert rolls back — nothing deleted, nothing inserted', async () => {
    const { db, table } = fakeDb({ failOnHash: 'hash-new' });
    const repoSource = 'https://github.com/o/r';
    const existing = testChunk({ contentHash: 'hash-existing' });

    await replaceChunks(db, repoSource, [{ chunk: existing, embedding: [0.1] }]);
    const before = new Map(table);

    const failed = await replaceChunks(db, repoSource, [
      { chunk: testChunk({ contentHash: 'hash-ok' }), embedding: [0.2] },
      { chunk: testChunk({ contentHash: 'hash-new' }), embedding: [0.3] },
    ]);

    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toContain('insert failed for hash-new');
    expect([...table.entries()]).toEqual([...before.entries()]);
  });
});
