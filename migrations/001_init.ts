import type { MigrationBuilder } from 'node-pg-migrate';
import { EMBEDDING_DIM } from '../src/index/constants.js';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createExtension('vector', { ifNotExists: true });

  pgm.createTable(
    'chunks',
    {
      id: 'id',
      repo_source: { type: 'text', notNull: true },
      file_path: { type: 'text', notNull: true },
      symbol_name: { type: 'text' },
      kind: { type: 'text', notNull: true },
      signature: { type: 'text' },
      js_doc: { type: 'text' },
      start_line: { type: 'integer', notNull: true },
      end_line: { type: 'integer', notNull: true },
      parent_symbol: { type: 'text' },
      is_exported: { type: 'boolean', notNull: true },
      content_hash: { type: 'text', notNull: true },
      language: { type: 'text', notNull: true },
      chunker_kind: { type: 'text', notNull: true },
      part_index: { type: 'integer', notNull: true },
      part_total: { type: 'integer', notNull: true },
      content: { type: 'text', notNull: true },
      embed_text: { type: 'text', notNull: true },
      embedding: { type: `vector(${EMBEDDING_DIM})`, notNull: true },
      tsv: {
        type: 'tsvector',
        notNull: true,
        expressionGenerated:
          "to_tsvector('english', coalesce(symbol_name, '') || ' ' || coalesce(signature, '') || ' ' || content)",
      },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        unique: [['repo_source', 'content_hash']],
      },
    },
  );

  pgm.createIndex('chunks', 'tsv', { method: 'gin' });
  pgm.createIndex('chunks', 'language', { method: 'btree' });
  pgm.sql('CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);');
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('chunks');
};
