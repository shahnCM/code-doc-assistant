import { describe, expect, it } from 'vitest';
import type { RetrievedChunk } from '../shared/types.js';
import { parseCitations, validateCitations } from './citations.js';

function retrievedChunk(
  overrides: Partial<RetrievedChunk> & Pick<RetrievedChunk, 'id' | 'filePath' | 'fusedScore'>,
): RetrievedChunk {
  return {
    repoSource: 'test://repo',
    symbolName: null,
    kind: 'block',
    signature: null,
    startLine: 1,
    endLine: 1,
    language: 'typescript',
    chunkerKind: 'generic',
    content: 'body',
    denseRank: 1,
    lexicalRank: null,
    denseDistance: 0,
    lexicalScore: null,
    ...overrides,
  };
}

describe('parseCitations', () => {
  it('[10][REQ] extracts a range citation and normalizes a bare line number to start === end', () => {
    const ranged = parseCitations('See src/a.ts:10-20 for details.');
    expect(ranged).toEqual([{ filePath: 'src/a.ts', startLine: 10, endLine: 20, raw: 'src/a.ts:10-20' }]);

    const bare = parseCitations('See src/a.ts:10 for details.');
    expect(bare).toEqual([{ filePath: 'src/a.ts', startLine: 10, endLine: 10, raw: 'src/a.ts:10' }]);
  });

  it('[11] ignores non-citation colons: URLs, error prefixes, and clock times', () => {
    const result = parseCitations('Visit http://example.com. Error: boom happened at 10:30am.');
    expect(result).toEqual([]);
  });
});

describe('validateCitations', () => {
  it('[12][REQ] a citation naming a file absent from the included set is invalid with reason unknown-file', () => {
    const included = [retrievedChunk({ id: 1, filePath: 'src/a.ts', fusedScore: 1, startLine: 1, endLine: 50 })];
    const citation = { filePath: 'src/missing.ts', startLine: 1, endLine: 5, raw: 'src/missing.ts:1-5' };

    const result = validateCitations([citation], included);

    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual([{ citation, reason: 'unknown-file' }]);
  });

  it('[13][REQ] a citation whose range escapes every included chunk is invalid with reason range-not-retrieved', () => {
    const included = [
      retrievedChunk({ id: 1, filePath: 'src/a.ts', fusedScore: 1, startLine: 100, endLine: 140 }),
    ];
    const citation = { filePath: 'src/a.ts', startLine: 120, endLine: 145, raw: 'src/a.ts:120-145' };

    const result = validateCitations([citation], included);

    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual([{ citation, reason: 'range-not-retrieved' }]);
  });

  it('[14] validates by containment not overlap — an interior range and the exact boundary are both valid', () => {
    const included = [
      retrievedChunk({ id: 1, filePath: 'src/a.ts', fusedScore: 1, startLine: 100, endLine: 200 }),
    ];
    const interior = { filePath: 'src/a.ts', startLine: 120, endLine: 145, raw: 'src/a.ts:120-145' };
    const boundary = { filePath: 'src/a.ts', startLine: 100, endLine: 200, raw: 'src/a.ts:100-200' };

    const result = validateCitations([interior, boundary], included);

    expect(result.valid).toEqual([interior, boundary]);
    expect(result.invalid).toEqual([]);
  });
});
