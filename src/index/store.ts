import type { Chunk, Result } from '../shared/types.js';
import { toVectorLiteral, type Db } from './db.js';

export interface EmbeddedChunk {
  chunk: Chunk;
  embedding: readonly number[];
}

const INSERT_SQL = `
  INSERT INTO chunks (
    repo_source, file_path, symbol_name, kind, signature, js_doc,
    start_line, end_line, parent_symbol, is_exported, content_hash,
    language, chunker_kind, part_index, part_total, content, embed_text, embedding
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::vector
  )
  ON CONFLICT (repo_source, content_hash) DO NOTHING
  RETURNING id
`;

function paramsFor(repoSource: string, row: EmbeddedChunk): unknown[] {
  const { chunk, embedding } = row;
  return [
    repoSource,
    chunk.filePath,
    chunk.symbolName,
    chunk.kind,
    chunk.signature,
    chunk.jsDoc,
    chunk.startLine,
    chunk.endLine,
    chunk.parentSymbol,
    chunk.isExported,
    chunk.contentHash,
    chunk.language,
    chunk.chunkerKind,
    chunk.partIndex,
    chunk.partTotal,
    chunk.content,
    chunk.embedText,
    toVectorLiteral(embedding),
  ];
}

const DELETE_SQL = `
  DELETE FROM chunks WHERE repo_source = $1
  RETURNING id
`;

/**
 * Replace semantics: after this returns ok, the rows for `repoSource` are exactly `rows`.
 * ON CONFLICT DO NOTHING stays on the INSERT, but only to collapse duplicate hashes inside a
 * single run — the DELETE has already removed anything a previous run left behind.
 */
export async function replaceChunks(
  db: Db,
  repoSource: string,
  rows: readonly EmbeddedChunk[],
): Promise<Result<{ deleted: number; inserted: number }, string>> {
  return db.withTransaction(
    async (tx): Promise<Result<{ deleted: number; inserted: number }, string>> => {
      const removed = await tx.query(DELETE_SQL, [repoSource]);
      let inserted = 0;
      for (const row of rows) {
        const result = await tx.query(INSERT_SQL, paramsFor(repoSource, row));
        if (result.rows.length > 0) inserted += 1;
      }
      return { ok: true, value: { deleted: removed.rows.length, inserted } };
    },
  );
}
