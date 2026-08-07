import { describe, expect, it } from 'vitest';
import type { Citation } from '../../shared/types.js';
import { buildCitationLookup, splitWithCitations, type CitationLookupEntry, type Segment } from './citations.js';

describe('splitWithCitations', () => {
  it('places a valid citation segment inline between the surrounding text', () => {
    const citation: Citation = { filePath: 'src/a.ts', startLine: 10, endLine: 20, raw: 'src/a.ts:10-20' };
    const lookup = new Map<string, CitationLookupEntry>([[citation.raw, { citation, valid: true }]]);

    const segments = splitWithCitations('see src/a.ts:10-20 for it', lookup);

    expect(segments).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'citation', citation, valid: true, reason: null },
      { type: 'text', text: ' for it' },
    ] satisfies Segment[]);
  });

  it('renders citation-shaped text absent from the lookup as plain text, never a chip', () => {
    const segments = splitWithCitations('see src/a.ts:10-20 for it', new Map());

    expect(segments.every((segment) => segment.type === 'text')).toBe(true);
    expect(segments).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'text', text: 'src/a.ts:10-20' },
      { type: 'text', text: ' for it' },
    ] satisfies Segment[]);
  });

  it('matches two identical citation occurrences independently by position', () => {
    const citation: Citation = { filePath: 'src/a.ts', startLine: 1, endLine: 2, raw: 'src/a.ts:1-2' };
    const lookup = new Map<string, CitationLookupEntry>([[citation.raw, { citation, valid: true }]]);

    const segments = splitWithCitations('src/a.ts:1-2 and src/a.ts:1-2', lookup);
    const citationSegments = segments.filter((segment) => segment.type === 'citation');

    expect(citationSegments).toHaveLength(2);
    expect(citationSegments[0]).not.toBe(citationSegments[1]);
  });

  it('attaches the invalid reason to an unresolved citation segment', () => {
    const citation: Citation = { filePath: 'src/missing.ts', startLine: 1, endLine: 1, raw: 'src/missing.ts:1' };
    const lookup = new Map<string, CitationLookupEntry>([
      [citation.raw, { citation, valid: false, reason: 'unknown-file' }],
    ]);

    const segments = splitWithCitations('src/missing.ts:1', lookup);

    expect(segments).toEqual([
      { type: 'citation', citation, valid: false, reason: 'unknown-file' },
    ] satisfies Segment[]);
  });
});

describe('buildCitationLookup', () => {
  it('marks valid and invalid citations correctly, keyed by raw text', () => {
    const validCitation: Citation = { filePath: 'src/a.ts', startLine: 1, endLine: 2, raw: 'src/a.ts:1-2' };
    const invalidCitation: Citation = {
      filePath: 'src/missing.ts',
      startLine: 1,
      endLine: 1,
      raw: 'src/missing.ts:1',
    };

    const lookup = buildCitationLookup({
      valid: [validCitation],
      invalid: [{ citation: invalidCitation, reason: 'unknown-file' }],
    });

    expect(lookup.get(validCitation.raw)).toEqual({ citation: validCitation, valid: true });
    expect(lookup.get(invalidCitation.raw)).toEqual({
      citation: invalidCitation,
      valid: false,
      reason: 'unknown-file',
    });
  });

  it('returns an empty lookup when citations have not resolved yet', () => {
    expect(buildCitationLookup(null).size).toBe(0);
  });
});
