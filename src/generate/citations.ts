import type { Citation, CitationValidation, RetrievedChunk } from '../shared/types.js';

const CITATION_PATTERN = /([A-Za-z0-9_\-./]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;

export function parseCitations(text: string): Citation[] {
  const citations: Citation[] = [];

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const filePath = match[1];
    const startLineStr = match[2];
    if (!filePath || !startLineStr) continue;

    const startLine = Number(startLineStr);
    const endLine = match[3] ? Number(match[3]) : startLine;

    citations.push({ filePath, startLine, endLine, raw: match[0] ?? '' });
  }

  return citations;
}

export function validateCitations(
  citations: readonly Citation[],
  included: readonly RetrievedChunk[],
): CitationValidation {
  const valid: Citation[] = [];
  const invalid: CitationValidation['invalid'] = [];

  for (const citation of citations) {
    const sameFile = included.filter((chunk) => chunk.filePath === citation.filePath);
    if (sameFile.length === 0) {
      invalid.push({ citation, reason: 'unknown-file' });
      continue;
    }

    const contained = sameFile.some(
      (chunk) => citation.startLine >= chunk.startLine && citation.endLine <= chunk.endLine,
    );
    if (!contained) {
      invalid.push({ citation, reason: 'range-not-retrieved' });
      continue;
    }

    valid.push(citation);
  }

  return { valid, invalid };
}
