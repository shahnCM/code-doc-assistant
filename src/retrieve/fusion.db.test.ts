import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../config.js';
import { EMBEDDING_DIM } from '../index/constants.js';
import { createPgDb, type Db, type PgDb } from '../index/db.js';
import type { EmbedClient } from '../index/embedClient.js';
import { upsertChunks, type EmbeddedChunk } from '../index/store.js';
import type { Chunk } from '../shared/types.js';
import { searchChunks } from './search.js';

// Isolation for this fixture, and the scope test 17 proves is empty. Never real repo data.
const REPO_SOURCE = 'test://rrf-fixture';
const EMPTY_REPO_SOURCE = 'test://rrf-fixture-empty';

// Query vector is [1,0,0,...]. Sparse vectors here give exact, hand-verifiable cosine distances
// (plans/03-retrieval.md, Verified 11) — no embedding API call anywhere in this suite; the fake
// EmbedClient below always returns QUERY_VECTOR regardless of the query text.
function vectorAt(entries: ReadonlyArray<readonly [number, number]>, dim = EMBEDDING_DIM): number[] {
  const vector = new Array(dim).fill(0);
  for (const [index, value] of entries) vector[index] = value;
  return vector;
}

const QUERY_VECTOR = vectorAt([[0, 1]]);

function fixtureChunk(overrides: Partial<Chunk> & Pick<Chunk, 'contentHash' | 'content'>): Chunk {
  return {
    filePath: 'src/fixture.ts',
    symbolName: null,
    kind: 'block',
    signature: null,
    jsDoc: null,
    startLine: 1,
    endLine: 1,
    parentSymbol: null,
    isExported: false,
    language: 'text',
    chunkerKind: 'generic',
    partIndex: 1,
    partTotal: 1,
    embedText: overrides.content,
    ...overrides,
  };
}

function fixedVectorEmbedClient(vector: readonly number[]): EmbedClient {
  return {
    async embedBatch(texts) {
      return { ok: true, value: texts.map(() => [...vector]) };
    },
  };
}

// Distance to QUERY_VECTOR ([1,0,0,...]) and the resulting dense rank, inserted in this exact
// order so ascending id breaks the E/F distance tie the way the table below documents.
//
// | Row | chunker_kind | symbol_name  | dist | dense rank |
// |-----|--------------|--------------|------|------------|
// | B   | generic      | null         | 0.0  | 1          |
// | C   | ts-morph     | loadSettings | 0.2  | 2          |
// | D   | generic      | null         | 0.4  | 3          |
// | E   | ts-morph     | formatOutput | 1.0  | 4          |
// | F   | generic      | null         | 1.0  | 5          |
// | A   | ts-morph     | parseConfig  | 2.0  | 6          |
//
// Row A is anti-parallel to the query (distance 2.0, worse than any non-negative embedding could
// produce) so it can only reach rank 1 via the exact-symbol boost, not by coincidence of the
// dense leg.
const rowB = fixtureChunk({
  filePath: 'docs/ranking.md',
  contentHash: 'rrf-fixture-b',
  language: 'markdown',
  chunkerKind: 'generic',
  kind: 'block',
  content: 'Documentation describing how retrieval results are ranked and displayed to the user.',
});

const rowC = fixtureChunk({
  filePath: 'src/fixture/settings.ts',
  contentHash: 'rrf-fixture-c',
  language: 'typescript',
  chunkerKind: 'ts-morph',
  kind: 'function',
  symbolName: 'loadSettings',
  signature: 'function loadSettings(): Settings',
  content: 'function loadSettings(): Settings { const cache = createCache(); return cache.load(); }',
});

const rowD = fixtureChunk({
  filePath: 'docs/cache.md',
  contentHash: 'rrf-fixture-d',
  language: 'markdown',
  chunkerKind: 'generic',
  kind: 'block',
  content: 'The cache directory holds serialized embeddings shared across ingest runs.',
});

const rowE = fixtureChunk({
  filePath: 'src/fixture/format.ts',
  contentHash: 'rrf-fixture-e',
  language: 'typescript',
  chunkerKind: 'ts-morph',
  kind: 'function',
  symbolName: 'formatOutput',
  signature: 'function formatOutput(value: unknown): string',
  content: 'function formatOutput(value: unknown): string { return JSON.stringify(value); }',
});

const rowF = fixtureChunk({
  filePath: 'docs/deploy.md',
  contentHash: 'rrf-fixture-f',
  language: 'markdown',
  chunkerKind: 'generic',
  kind: 'block',
  content: 'Notes on deployment targets and rollout order for the ingest workers.',
});

const rowA = fixtureChunk({
  filePath: 'src/fixture/config.ts',
  contentHash: 'rrf-fixture-a',
  language: 'typescript',
  chunkerKind: 'ts-morph',
  kind: 'function',
  symbolName: 'parseConfig',
  signature: 'function parseConfig(raw: string): Config',
  content: 'function parseConfig(raw: string): Config { return JSON.parse(raw); }',
});

let db: Db;
let pgDb: PgDb;

beforeAll(async () => {
  const envResult = loadEnv();
  if (!envResult.ok) throw new Error(envResult.error);
  pgDb = createPgDb(envResult.value.DATABASE_URL);
  db = pgDb.db;

  await db.query('DELETE FROM chunks WHERE repo_source = $1', [REPO_SOURCE]);

  const rows: EmbeddedChunk[] = [
    { chunk: rowB, embedding: vectorAt([[0, 1]]) },
    { chunk: rowC, embedding: vectorAt([[0, 0.8], [1, 0.6]]) },
    { chunk: rowD, embedding: vectorAt([[0, 0.6], [1, 0.8]]) },
    { chunk: rowE, embedding: vectorAt([[1, 1]]) },
    { chunk: rowF, embedding: vectorAt([[2, 1]]) },
    { chunk: rowA, embedding: vectorAt([[0, -1]]) },
  ];
  const result = await upsertChunks(db, REPO_SOURCE, rows);
  if (!result.ok) throw new Error(result.error);
  if (result.value.upserted !== 6) {
    throw new Error(`expected 6 fixture rows upserted, got ${result.value.upserted}`);
  }
});

afterAll(async () => {
  await db.query('DELETE FROM chunks WHERE repo_source = $1', [REPO_SOURCE]);
  await pgDb.end();
});

describe('hybrid retrieval contract (real Postgres)', () => {
  it('[13][REQ] an exact symbol name query returns that symbol at rank 1', async () => {
    const result = await searchChunks('parseConfig', 'unused', 'unused', {
      repoSource: REPO_SOURCE,
      embedClient: fixedVectorEmbedClient(QUERY_VECTOR),
      db,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.symbolName).toBe('parseConfig');
    expect(result.value[0]?.denseRank).toBe(6);
    expect(result.value[0]?.lexicalRank).toBe(1);
  });

  it('[14][REQ] a purely conceptual query returns results the lexical leg alone would miss', async () => {
    const result = await searchChunks('wombat telemetry across quantum fjords', 'unused', 'unused', {
      repoSource: REPO_SOURCE,
      embedClient: fixedVectorEmbedClient(QUERY_VECTOR),
      db,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
    expect(result.value.some((chunk) => chunk.lexicalRank === null && chunk.denseRank !== null)).toBe(true);
  });

  it('[15][REQ] RRF fusion matches hand-computed ranks at default weights', async () => {
    const result = await searchChunks('parseConfig', 'unused', 'unused', {
      repoSource: REPO_SOURCE,
      embedClient: fixedVectorEmbedClient(QUERY_VECTOR),
      db,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byHash = new Map(result.value.map((chunk) => [chunk.symbolName ?? chunk.filePath, chunk]));

    // Row A: both legs — denseRank 6, lexicalRank 1 (boost).
    const rowAResult = byHash.get('parseConfig');
    expect(rowAResult?.denseRank).toBe(6);
    expect(rowAResult?.lexicalRank).toBe(1);
    expect(rowAResult?.fusedScore).toBeCloseTo(1 / 66 + 1 / 61, 12);

    // Row B: dense-only, denseRank 1.
    const rowBResult = byHash.get('docs/ranking.md');
    expect(rowBResult?.denseRank).toBe(1);
    expect(rowBResult?.lexicalRank).toBeNull();
    expect(rowBResult?.fusedScore).toBeCloseTo(1 / 61, 12);

    // Row F: dense-only, denseRank 5.
    const rowFResult = byHash.get('docs/deploy.md');
    expect(rowFResult?.denseRank).toBe(5);
    expect(rowFResult?.lexicalRank).toBeNull();
    expect(rowFResult?.fusedScore).toBeCloseTo(1 / 65, 12);
  });

  it('[16][REQ] both chunker kinds are returned, and a null-symbol_name generic row keeps its lexical rank', async () => {
    const result = await searchChunks('cache', 'unused', 'unused', {
      repoSource: REPO_SOURCE,
      embedClient: fixedVectorEmbedClient(QUERY_VECTOR),
      db,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const kinds = new Set(result.value.map((chunk) => chunk.chunkerKind));
    expect(kinds.has('ts-morph')).toBe(true);
    expect(kinds.has('generic')).toBe(true);

    const genericNullSymbol = result.value.find(
      (chunk) => chunk.chunkerKind === 'generic' && chunk.symbolName === null && chunk.filePath === 'docs/cache.md',
    );
    expect(genericNullSymbol).toBeDefined();
    expect(genericNullSymbol?.lexicalRank).not.toBeNull();
  });

  it('[17] an empty scope returns [] and does not throw', async () => {
    const result = await searchChunks('parseConfig', 'unused', 'unused', {
      repoSource: EMPTY_REPO_SOURCE,
      embedClient: fixedVectorEmbedClient(QUERY_VECTOR),
      db,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});
