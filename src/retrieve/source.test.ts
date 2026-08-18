import { describe, expect, it } from 'vitest';
import type { Db } from '../index/db.js';
import { fetchSourceRange, MAX_SOURCE_LINES } from './source.js';

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
    withTransaction: async (fn) => fn(db),
  };
  return { db, calls };
}

describe('fetchSourceRange', () => {
  it('[35] stitches returned blocks in start_line order and reports no gaps when the file is contiguous', async () => {
    const { db } = fakeDb([
      { start_line: 1, end_line: 2, content: 'a' },
      { start_line: 3, end_line: 7, content: 'b' },
    ]);

    const range = await fetchSourceRange(db, {
      repoSource: 'https://github.com/o/r',
      filePath: 'src/a.ts',
      startLine: 1,
      endLine: 7,
    });

    expect(range.blocks).toEqual([
      { startLine: 1, endLine: 2, content: 'a' },
      { startLine: 3, endLine: 7, content: 'b' },
    ]);
    expect(range.gaps).toEqual([]);
  });

  it('[35] reports uncovered spans in gaps for a file with leading and interior gaps', async () => {
    const { db } = fakeDb([{ start_line: 5, end_line: 6, content: 'mid' }]);

    const range = await fetchSourceRange(db, {
      repoSource: 'https://github.com/o/r',
      filePath: 'src/a.ts',
      startLine: 1,
      endLine: 10,
    });

    expect(range.gaps).toEqual([
      { startLine: 1, endLine: 4 },
      { startLine: 7, endLine: 10 },
    ]);
  });

  it('[35] an unknown file returns zero blocks rather than throwing', async () => {
    const { db } = fakeDb([]);

    const range = await fetchSourceRange(db, {
      repoSource: 'https://github.com/o/r',
      filePath: 'src/missing.ts',
      startLine: 1,
      endLine: 5,
    });

    expect(range.blocks).toEqual([]);
  });

  it('[36] caps the requested span at MAX_SOURCE_LINES before the query runs', async () => {
    const { db, calls } = fakeDb([]);

    const range = await fetchSourceRange(db, {
      repoSource: 'https://github.com/o/r',
      filePath: 'src/huge.ts',
      startLine: 1,
      endLine: 100_000,
    });

    expect(range.endLine).toBe(MAX_SOURCE_LINES);
    expect(calls[0]?.params).toEqual(['https://github.com/o/r', 'src/huge.ts', 1, MAX_SOURCE_LINES]);
  });
});
