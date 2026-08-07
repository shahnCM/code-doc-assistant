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
  failures: ChunkError[];
}

export interface AcquiredRepo {
  rootDir: string;
  source: 'local' | 'git';
  commitSha: string | null;
}

export interface RetrievedChunk {
  id: number;
  repoSource: string;
  filePath: string;
  symbolName: string | null;
  kind: ChunkKind;
  signature: string | null;
  startLine: number;
  endLine: number;
  language: string;
  chunkerKind: string;
  content: string;
  denseRank: number | null;
  lexicalRank: number | null;
  denseDistance: number | null;
  lexicalScore: number | null;
  fusedScore: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
  /** Exactly as the model wrote it, so the UI can highlight the original span. */
  raw: string;
}

export type CitationProblem = 'unknown-file' | 'range-not-retrieved';

export interface CitationValidation {
  valid: Citation[];
  invalid: Array<{ citation: Citation; reason: CitationProblem }>;
}

export interface AssembledChunkTrace {
  id: number;
  filePath: string;
  symbolName: string | null;
  startLine: number;
  endLine: number;
  language: string;
  chunkerKind: string;
  denseRank: number | null;
  lexicalRank: number | null;
  fusedScore: number;
  /** False when the chunk was retrieved but lost dedupe or budget truncation. */
  included: boolean;
}

export type ChatEvent =
  | { type: 'trace'; chunks: AssembledChunkTrace[]; retrieveMs: number; contextTokens: number }
  | { type: 'token'; text: string }
  | { type: 'citations'; valid: Citation[]; invalid: CitationValidation['invalid'] }
  | { type: 'done'; finishReason: string; generateMs: number; totalMs: number }
  | { type: 'cancelled'; elapsedMs: number; estimatedTokensNotGenerated: number; note: string }
  | { type: 'error'; message: string };
