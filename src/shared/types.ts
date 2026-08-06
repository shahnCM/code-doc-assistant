export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type ChunkKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type-alias'
  | 'enum'
  | 'const'
  | 're-export'
  | 'file'
  | 'block'
  | 'window';

export interface Chunk {
  filePath: string;
  symbolName: string | null;
  kind: ChunkKind;
  signature: string | null;
  jsDoc: string | null;
  startLine: number;
  endLine: number;
  parentSymbol: string | null;
  isExported: boolean;
  contentHash: string;
  language: string;
  chunkerKind: string;
  partIndex: number;
  partTotal: number;
  content: string;
  embedText: string;
}

export interface Candidate {
  filePath: string;
  absolutePath: string;
  extension: string;
  language: string;
}

export interface ChunkerOutput {
  chunks: Chunk[];
  outcome: 'chunked' | 'degraded' | 'no-declarations';
}

export interface ChunkError {
  filePath: string;
  reason: string;
}

export type SkipReason =
  | 'ignored-dir'
  | 'lockfile'
  | 'minified'
  | 'too-large'
  | 'binary-extension'
  | 'binary-content'
  | 'symlink';

export interface IngestReport {
  filesSeen: number;
  chunked: number;
  degraded: number;
  noDeclarations: number;
  failed: number;
  skipped: number;
  totalChunks: number;
  commitSha: string | null;
}

export interface AcquiredRepo {
  rootDir: string;
  source: 'local' | 'git';
  commitSha: string | null;
}
