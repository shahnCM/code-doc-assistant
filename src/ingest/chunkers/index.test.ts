import { describe, expect, it } from 'vitest';
import type { Candidate, ChunkError, ChunkerOutput, Result } from '../../shared/types.js';
import { registry, selectChunker, type Chunker } from './index.js';

const TS_JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

function candidate(extension: string, language: string): Candidate {
  return { filePath: `file${extension}`, absolutePath: `/abs/file${extension}`, extension, language };
}

function makeChunker(name: string, chunkerKind: string, supports: (c: Candidate) => boolean): Chunker {
  return {
    name,
    chunkerKind,
    supports,
    chunk(): Result<ChunkerOutput, ChunkError> {
      return { ok: true, value: { chunks: [], outcome: 'chunked' } };
    },
  };
}

describe('chunker registry', () => {
  it('registers the ts-morph chunker for all eight TS/JS extensions', () => {
    for (const extension of TS_JS_EXTENSIONS) {
      expect(selectChunker(candidate(extension, 'typescript'), registry)?.name).toBe('ts-morph');
    }
  });

  const tsLikeChunker = makeChunker('ts-like', 'ts-morph', (c) => TS_JS_EXTENSIONS.includes(c.extension));
  const genericLikeChunker = makeChunker('generic-like', 'generic', () => true);
  const chunkers: readonly Chunker[] = [tsLikeChunker, genericLikeChunker];

  it('selects the ts-like chunker for all eight TS/JS extensions', () => {
    for (const extension of TS_JS_EXTENSIONS) {
      expect(selectChunker(candidate(extension, 'typescript'), chunkers)?.name).toBe('ts-like');
    }
  });

  it('selects the generic-like chunker for .py and an unknown extension', () => {
    expect(selectChunker(candidate('.py', 'python'), chunkers)?.name).toBe('generic-like');
    expect(selectChunker(candidate('', 'unknown'), chunkers)?.name).toBe('generic-like');
  });

  it('is total: every candidate resolves to a chunker', () => {
    expect(selectChunker(candidate('.weird', 'unknown'), chunkers)).toBeDefined();
  });

  it('respects order: the first chunker whose supports() matches wins', () => {
    const alwaysA = makeChunker('a', 'a', () => true);
    const alwaysB = makeChunker('b', 'b', () => true);
    expect(selectChunker(candidate('.ts', 'typescript'), [alwaysA, alwaysB])?.name).toBe('a');
    expect(selectChunker(candidate('.ts', 'typescript'), [alwaysB, alwaysA])?.name).toBe('b');
  });
});
