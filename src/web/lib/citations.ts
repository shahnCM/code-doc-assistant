import type { Citation, CitationProblem } from '../../shared/types.js';

// Duplicated from src/generate/citations.ts:3, pinned to CITATION_FORMAT in
// src/generate/prompt.ts:6 — kept out of the browser bundle rather than imported, per
// plans/05-frontend.md's Decisions. Update both copies together if the format ever changes.
export const CITATION_PATTERN = /([A-Za-z0-9_\-./]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;

export interface CitationLookupEntry {
  citation: Citation;
  valid: boolean;
  reason?: CitationProblem;
}

export interface TextSegment {
  type: 'text';
  text: string;
}

export interface CitationSegment {
  type: 'citation';
  citation: Citation;
  valid: boolean;
  reason: CitationProblem | null;
}

export type Segment = TextSegment | CitationSegment;

export function splitWithCitations(
  text: string,
  lookup: ReadonlyMap<string, CitationLookupEntry>,
): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const raw = match[0];
    const matchIndex = match.index;

    if (matchIndex > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, matchIndex) });
    }

    const entry = lookup.get(raw);
    if (entry) {
      segments.push({
        type: 'citation',
        citation: entry.citation,
        valid: entry.valid,
        reason: entry.reason ?? null,
      });
    } else {
      segments.push({ type: 'text', text: raw });
    }

    cursor = matchIndex + raw.length;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', text: text.slice(cursor) });
  }

  return segments;
}
