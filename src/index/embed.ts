import type { Chunk, Result } from '../shared/types.js';
import { type EmbedBatchOptions, embedTexts } from './batch.js';
import { type EmbedCache, createFileEmbedCache } from './cache.js';
import { type Db, type PgDb, createPgDb } from './db.js';
import { type EmbedClient, realEmbedClient } from './embedClient.js';
import { type EmbeddedChunk, upsertChunks } from './store.js';

const DEFAULT_CACHE_DIR = '.cache/embeddings';

export interface IndexReport {
  totalChunks: number;
  uniqueHashes: number;
  cacheHits: number;
  embedded: number;
  upserted: number;
}

export interface IndexOptions {
  embedClient?: EmbedClient;
  cache?: EmbedCache;
  db?: Db;
  cacheDir?: string;
  batchOptions?: EmbedBatchOptions;
}

function groupByContentHash(chunks: readonly Chunk[]): Map<string, Chunk[]> {
  const byHash = new Map<string, Chunk[]>();
  for (const chunk of chunks) {
    const group = byHash.get(chunk.contentHash);
    if (group) {
      group.push(chunk);
    } else {
      byHash.set(chunk.contentHash, [chunk]);
    }
  }
  return byHash;
}

export async function indexChunks(
  chunks: readonly Chunk[],
  repoSource: string,
  connectionString: string,
  embedModel: string,
  options: IndexOptions = {},
): Promise<Result<IndexReport, string>> {
  const embedClient = options.embedClient ?? realEmbedClient(embedModel);
  const cache = options.cache ?? createFileEmbedCache(options.cacheDir ?? DEFAULT_CACHE_DIR);

  let db: Db;
  let ownedPool: PgDb | undefined;
  if (options.db) {
    db = options.db;
  } else {
    ownedPool = createPgDb(connectionString);
    db = ownedPool.db;
  }

  try {
    const byHash = groupByContentHash(chunks);
    const hashToEmbedding = new Map<string, number[]>();
    const missHashes: string[] = [];
    const missTexts: string[] = [];
    let cacheHits = 0;

    for (const [hash, group] of byHash) {
      const [representative] = group;
      if (!representative) continue;
      const cached = await cache.get(hash, embedModel);
      if (cached) {
        cacheHits += 1;
        hashToEmbedding.set(hash, cached);
      } else {
        missHashes.push(hash);
        missTexts.push(representative.embedText);
      }
    }

    if (missTexts.length > 0) {
      const embedResult = await embedTexts(missTexts, embedClient, options.batchOptions);
      if (!embedResult.ok) {
        return { ok: false, error: `embedding failed: ${embedResult.error.message}` };
      }
      for (let i = 0; i < missHashes.length; i++) {
        const hash = missHashes[i];
        const vector = embedResult.value[i];
        if (!hash || !vector) continue;
        hashToEmbedding.set(hash, vector);
        await cache.set(hash, embedModel, vector);
      }
    }

    const rows: EmbeddedChunk[] = [];
    for (const [hash, group] of byHash) {
      const embedding = hashToEmbedding.get(hash);
      if (!embedding) continue;
      for (const chunk of group) {
        rows.push({ chunk, embedding });
      }
    }

    const upsertResult = await upsertChunks(db, repoSource, rows);
    if (!upsertResult.ok) {
      return { ok: false, error: `store failed: ${upsertResult.error}` };
    }

    return {
      ok: true,
      value: {
        totalChunks: chunks.length,
        uniqueHashes: byHash.size,
        cacheHits,
        embedded: missTexts.length,
        upserted: upsertResult.value.upserted,
      },
    };
  } finally {
    if (ownedPool) await ownedPool.end();
  }
}
