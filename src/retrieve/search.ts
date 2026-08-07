import type { ChunkKind, RetrievedChunk, Result } from '../shared/types.js';
import { createPgDb, toVectorLiteral, type Db, type PgDb } from '../index/db.js';
import { realEmbedClient, type EmbedClient } from '../index/embedClient.js';
import { buildParams, HYBRID_SQL, type RetrieveOptions } from './fusion.js';

export type RetrieveError =
  | { kind: 'embed'; message: string }
  | { kind: 'db'; message: string }
  | { kind: 'aborted'; message: string };

export interface SearchOptions extends RetrieveOptions {
  embedClient?: EmbedClient;
  db?: Db;
  /** Pool factory, injected for tests so pool ownership is verifiable without a real Postgres. */
  dbFactory?: (connectionString: string) => PgDb;
  signal?: AbortSignal;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected string, got ${typeof value}`);
  return value;
}

function asNullableString(value: unknown): string | null {
  return value === null ? null : asString(value);
}

function asNumber(value: unknown): number {
  const num = Number(value);
  if (Number.isNaN(num)) throw new Error(`expected number, got ${String(value)}`);
  return num;
}

function asNullableNumber(value: unknown): number | null {
  return value === null ? null : asNumber(value);
}

// ROW_NUMBER() is bigint; node-postgres returns int8 as a string, not a number. dense_rank and
// lexical_rank must go through asNullableNumber or a string rank flows through unnoticed.
export function toRetrievedChunk(row: Record<string, unknown>): RetrievedChunk {
  return {
    id: asNumber(row.id),
    repoSource: asString(row.repo_source),
    filePath: asString(row.file_path),
    symbolName: asNullableString(row.symbol_name),
    kind: asString(row.kind) as ChunkKind,
    signature: asNullableString(row.signature),
    startLine: asNumber(row.start_line),
    endLine: asNumber(row.end_line),
    language: asString(row.language),
    chunkerKind: asString(row.chunker_kind),
    content: asString(row.content),
    denseRank: asNullableNumber(row.dense_rank),
    lexicalRank: asNullableNumber(row.lexical_rank),
    denseDistance: asNullableNumber(row.dense_distance),
    lexicalScore: asNullableNumber(row.lexical_score),
    fusedScore: asNumber(row.fused_score),
  };
}

export async function searchChunks(
  query: string,
  connectionString: string,
  embedModel: string,
  options: SearchOptions = {},
): Promise<Result<RetrievedChunk[], RetrieveError>> {
  const embedClient = options.embedClient ?? realEmbedClient(embedModel);

  let db: Db;
  let ownedPool: PgDb | undefined;
  if (options.db) {
    db = options.db;
  } else {
    ownedPool = (options.dbFactory ?? createPgDb)(connectionString);
    db = ownedPool.db;
  }

  try {
    const embedResult = await embedClient.embedBatch([query], options.signal);
    if (!embedResult.ok) {
      const kind = embedResult.error.kind === 'aborted' ? 'aborted' : 'embed';
      return { ok: false, error: { kind, message: embedResult.error.message } };
    }
    const [vector] = embedResult.value;
    if (!vector) {
      return { ok: false, error: { kind: 'embed', message: 'embedBatch returned no vector for the query' } };
    }

    // node-postgres ignores AbortSignal entirely, so this is the only place a caller's
    // cancellation actually stops the query from being issued.
    if (options.signal?.aborted) {
      return { ok: false, error: { kind: 'aborted', message: 'aborted before query' } };
    }

    const params = buildParams(toVectorLiteral(vector), query, options);
    const result = await db.query(HYBRID_SQL, params);
    return { ok: true, value: result.rows.map(toRetrievedChunk) };
  } catch (error) {
    return { ok: false, error: { kind: 'db', message: error instanceof Error ? error.message : String(error) } };
  } finally {
    if (ownedPool) await ownedPool.end();
  }
}
