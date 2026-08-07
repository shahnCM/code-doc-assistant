import type { Db } from '../index/db.js';
import type { SourceRange } from '../shared/types.js';

export const MAX_SOURCE_LINES = 400;

export interface SourceRangeParams {
  repoSource: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

const SOURCE_RANGE_SQL = `
SELECT start_line, end_line, content
FROM chunks
WHERE repo_source = $1
  AND file_path = $2
  AND end_line >= $3
  AND start_line <= $4
ORDER BY start_line ASC, part_index ASC;
`;

function asNumber(value: unknown): number {
  const num = Number(value);
  if (Number.isNaN(num)) throw new Error(`expected number, got ${String(value)}`);
  return num;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected string, got ${typeof value}`);
  return value;
}

// Chunks straddling the requested boundary come back whole (the query overlaps, not
// contains), so gaps are computed against the requested span, clamped to it — a block
// extending past the edge must not be mistaken for covering territory outside the request.
function computeGaps(
  requestedStart: number,
  requestedEnd: number,
  blocks: ReadonlyArray<{ startLine: number; endLine: number }>,
): SourceRange['gaps'] {
  const gaps: SourceRange['gaps'] = [];
  let cursor = requestedStart;

  for (const block of blocks) {
    const blockStart = Math.max(block.startLine, requestedStart);
    const blockEnd = Math.min(block.endLine, requestedEnd);
    if (blockStart > cursor) {
      gaps.push({ startLine: cursor, endLine: blockStart - 1 });
    }
    cursor = Math.max(cursor, blockEnd + 1);
  }

  if (cursor <= requestedEnd) {
    gaps.push({ startLine: cursor, endLine: requestedEnd });
  }

  return gaps;
}

export async function fetchSourceRange(db: Db, params: SourceRangeParams): Promise<SourceRange> {
  const startLine = params.startLine;
  const endLine = Math.min(params.endLine, startLine + MAX_SOURCE_LINES - 1);

  const result = await db.query(SOURCE_RANGE_SQL, [params.repoSource, params.filePath, startLine, endLine]);
  const blocks = result.rows.map((row) => ({
    startLine: asNumber(row.start_line),
    endLine: asNumber(row.end_line),
    content: asString(row.content),
  }));

  return {
    repoSource: params.repoSource,
    filePath: params.filePath,
    startLine,
    endLine,
    blocks,
    gaps: computeGaps(startLine, endLine, blocks),
  };
}
