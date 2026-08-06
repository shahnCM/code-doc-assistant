import { describe, expect, it } from 'vitest';
import type { Chunk } from '../shared/types.js';
import type { Db } from './db.js';
import { upsertChunks } from './store.js';

function fakeDb(): { db: Db; calls: Array<{ text: string; params: readonly unknown[] }>; table: Map<string, Record<string, unknown>> } {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const table = new Map<string, Record<string, unknown>>();
  let nextId = 1;

  const db: Db = {
    async query(text: string, params: readonly unknown[] = []) {
      calls.push({ text, params });

      const columnsMatch = /INSERT INTO chunks \(([^)]+)\)/i.exec(text);
      if (!columnsMatch) return { rows: [] };
      const columnList = columnsMatch[1];
      const columns = columnList ? columnList.split(',').map((c) => c.trim()) : [];

      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = params[i];
      });

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

describe('upsertChunks', () => {
  it('[REQ] inserts a new row for a fresh (repo_source, content_hash) pair with every mapped column present', async () => {
    const { db, calls } = fakeDb();
    const chunk = testChunk();

    const result = await upsertChunks(db, 'https://github.com/o/r', [{ chunk, embedding: [0.1, 0.2, 0.3] }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.upserted).toBe(1);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.params).toContain('https://github.com/o/r');
    expect(call?.params).toContain(chunk.filePath);
    expect(call?.params).toContain(chunk.contentHash);
    expect(call?.params).toContain(chunk.content);
    expect(call?.params).toContain(chunk.embedText);
  });

  it('[REQ] a repeat (repo_source, content_hash) is a no-op — the existing row keeps its original start_line/end_line', async () => {
    const { db, table } = fakeDb();
    const repoSource = 'https://github.com/o/r';
    const original = testChunk({ startLine: 10, endLine: 12 });

    const first = await upsertChunks(db, repoSource, [{ chunk: original, embedding: [0.1] }]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.upserted).toBe(1);

    const shifted = testChunk({ startLine: 55, endLine: 57 });
    const second = await upsertChunks(db, repoSource, [{ chunk: shifted, embedding: [0.1] }]);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.upserted).toBe(0);

    const stored = table.get(`${repoSource}::${original.contentHash}`);
    expect(stored?.start_line).toBe(10);
    expect(stored?.end_line).toBe(12);
  });

  it('a different repo_source with the same content_hash does not collide', async () => {
    const { db } = fakeDb();
    const chunk = testChunk();

    const a = await upsertChunks(db, 'https://github.com/o/r1', [{ chunk, embedding: [0.1] }]);
    const b = await upsertChunks(db, 'https://github.com/o/r2', [{ chunk, embedding: [0.1] }]);

    expect(a.ok && a.value.upserted).toBe(1);
    expect(b.ok && b.value.upserted).toBe(1);
  });
});
