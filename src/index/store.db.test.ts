import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../config.js';
import type { Chunk } from '../shared/types.js';
import { EMBEDDING_DIM } from './constants.js';
import { createPgDb, type Db, type PgDb } from './db.js';
import { replaceChunks } from './store.js';

// This suite runs against the REAL dev database, and its whole subject is a DELETE keyed on
// repo_source. A fixture that ever named a real corpus would destroy it, with no undo. Every
// repo_source used here passes through requireTestSource first, which throws before any
// statement is issued rather than after.
const REPO_SOURCE = 'test://replace-semantics';
const NEIGHBOUR_SOURCE = 'test://replace-semantics-neighbour';

function requireTestSource(repoSource: string): string {
  if (!repoSource.startsWith('test://')) {
    throw new Error(`refusing to run a destructive fixture against repo_source ${repoSource}`);
  }
  return repoSource;
}

function vectorOf(value: number, dim: number = EMBEDDING_DIM): number[] {
  return Array.from({ length: dim }, () => value);
}

function fixtureChunk(overrides: Partial<Chunk> & Pick<Chunk, 'contentHash' | 'content'>): Chunk {
  return {
    filePath: 'src/fixture/replace.ts',
    symbolName: null,
    kind: 'block',
    signature: null,
    jsDoc: null,
    startLine: 1,
    endLine: 1,
    parentSymbol: null,
    isExported: false,
    language: 'typescript',
    chunkerKind: 'generic',
    partIndex: 1,
    partTotal: 1,
    embedText: overrides.content,
    ...overrides,
  };
}

const alpha = fixtureChunk({
  contentHash: 'replace-alpha',
  content: 'export function alpha(): number { return 1; }',
  symbolName: 'alpha',
  startLine: 10,
  endLine: 12,
});

const beta = fixtureChunk({
  contentHash: 'replace-beta',
  content: 'export function beta(): number { return 2; }',
  symbolName: 'beta',
  startLine: 20,
  endLine: 22,
});

let db: Db;
let pgDb: PgDb;

async function rowsFor(repoSource: string): Promise<Array<Record<string, unknown>>> {
  const result = await db.query(
    'SELECT content_hash, start_line, end_line FROM chunks WHERE repo_source = $1 ORDER BY content_hash',
    [requireTestSource(repoSource)],
  );
  return result.rows;
}

async function clearFixtures(): Promise<void> {
  for (const source of [REPO_SOURCE, NEIGHBOUR_SOURCE]) {
    await db.query('DELETE FROM chunks WHERE repo_source = $1', [requireTestSource(source)]);
  }
}

beforeAll(async () => {
  const envResult = loadEnv();
  if (!envResult.ok) throw new Error(envResult.error);
  pgDb = createPgDb(envResult.value.DATABASE_URL);
  db = pgDb.db;
});

beforeEach(async () => {
  await clearFixtures();

  const seeded = await replaceChunks(db, requireTestSource(REPO_SOURCE), [
    { chunk: alpha, embedding: vectorOf(0.1) },
    { chunk: beta, embedding: vectorOf(0.2) },
  ]);
  if (!seeded.ok) throw new Error(seeded.error);

  const neighbour = await replaceChunks(db, requireTestSource(NEIGHBOUR_SOURCE), [
    { chunk: alpha, embedding: vectorOf(0.3) },
  ]);
  if (!neighbour.ok) throw new Error(neighbour.error);
});

afterAll(async () => {
  await clearFixtures();
  await pgDb.end();
});

describe('replaceChunks contract (real Postgres)', () => {
  it('[REQ] the fixture guard refuses a repo_source that is not a test sentinel', () => {
    expect(() => requireTestSource('./tmp/mini-demo')).toThrow(/refusing to run a destructive fixture/);
    expect(() => requireTestSource('https://github.com/honojs/hono')).toThrow();
    expect(requireTestSource(REPO_SOURCE)).toBe(REPO_SOURCE);
  });

  it('[REQ] a re-ingest updates changed rows, drops absent ones, and reports both counts', async () => {
    const shifted = fixtureChunk({
      contentHash: alpha.contentHash,
      content: alpha.content,
      symbolName: 'alpha',
      startLine: 40,
      endLine: 42,
    });

    const result = await replaceChunks(db, requireTestSource(REPO_SOURCE), [
      { chunk: shifted, embedding: vectorOf(0.9) },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ deleted: 2, inserted: 1 });

    const rows = await rowsFor(REPO_SOURCE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['content_hash']).toBe('replace-alpha');
    expect(rows[0]?.['start_line']).toBe(40);
    expect(rows[0]?.['end_line']).toBe(42);
  });

  it('[REQ] an unchanged content_hash still gets its new line numbers — the defect this block fixes', async () => {
    const shifted = fixtureChunk({
      contentHash: alpha.contentHash,
      content: alpha.content,
      symbolName: 'alpha',
      startLine: 77,
      endLine: 79,
    });

    await replaceChunks(db, requireTestSource(REPO_SOURCE), [
      { chunk: shifted, embedding: vectorOf(0.1) },
      { chunk: beta, embedding: vectorOf(0.2) },
    ]);

    const rows = await rowsFor(REPO_SOURCE);
    const stored = rows.find((row) => row['content_hash'] === 'replace-alpha');
    expect(stored?.['start_line']).toBe(77);
    expect(stored?.['end_line']).toBe(79);
  });

  it('[REQ] the delete is scoped to one repo_source — a neighbouring source is untouched', async () => {
    await replaceChunks(db, requireTestSource(REPO_SOURCE), []);

    expect(await rowsFor(REPO_SOURCE)).toHaveLength(0);
    expect(await rowsFor(NEIGHBOUR_SOURCE)).toHaveLength(1);
  });

  it('[REQ] a failure mid-transaction is rolled back by Postgres — the seeded rows survive intact', async () => {
    const before = await rowsFor(REPO_SOURCE);
    expect(before).toHaveLength(2);

    // A wrong-dimension vector fails during tuple construction, before conflict handling, so the
    // DELETE and the first INSERT have already run inside the transaction when it raises. This is
    // the one assertion a fake cannot make: only Postgres can prove its own ROLLBACK.
    const result = await replaceChunks(db, requireTestSource(REPO_SOURCE), [
      {
        chunk: fixtureChunk({ contentHash: 'replace-good', content: 'export const good = 1;' }),
        embedding: vectorOf(0.5),
      },
      {
        chunk: fixtureChunk({ contentHash: 'replace-bad', content: 'export const bad = 2;' }),
        embedding: vectorOf(0.5, EMBEDDING_DIM * 2),
      },
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/dimensions/i);

    const after = await rowsFor(REPO_SOURCE);
    expect(after).toEqual(before);
    expect(after.map((row) => row['content_hash'])).toEqual(['replace-alpha', 'replace-beta']);
  });
});
