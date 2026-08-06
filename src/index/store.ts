import type { Chunk, Result } from '../shared/types.js';
import type { Db } from './db.js';

export interface EmbeddedChunk {
  chunk: Chunk;
  embedding: readonly number[];
}

function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
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

export async function upsertChunks(
  db: Db,
  repoSource: string,
  rows: readonly EmbeddedChunk[],
): Promise<Result<{ upserted: number }, string>> {
  try {
    let upserted = 0;
    for (const row of rows) {
      const result = await db.query(INSERT_SQL, paramsFor(repoSource, row));
      if (result.rows.length > 0) upserted += 1;
    }
    return { ok: true, value: { upserted } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
