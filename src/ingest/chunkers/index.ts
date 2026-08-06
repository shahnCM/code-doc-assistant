import type { Candidate, ChunkError, ChunkerOutput, Result } from '../../shared/types.js';

export interface Chunker {
  readonly name: string;
  readonly chunkerKind: string;
  supports(candidate: Candidate): boolean;
  chunk(candidate: Candidate, source: string): Result<ChunkerOutput, ChunkError>;
}

export function selectChunker(candidate: Candidate, chunkers: readonly Chunker[]): Chunker | undefined {
  return chunkers.find((chunker) => chunker.supports(candidate));
}

export const registry: readonly Chunker[] = [];
