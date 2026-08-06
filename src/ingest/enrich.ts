import type { Chunk } from '../shared/types.js';
import { contentHash } from './hash.js';
import { estimateTokens } from './tokens.js';

export interface LineWindow {
  startLine: number;
  endLine: number;
  content: string;
}

export function splitByLines(content: string, startLine: number, maxTokens: number): LineWindow[] {
  const lines = content.split('\n');
  const windows: LineWindow[] = [];
  let windowLines: string[] = [];
  let windowStart = startLine;

  for (const line of lines) {
    const candidateLines = [...windowLines, line];
    if (windowLines.length > 0 && estimateTokens(candidateLines.join('\n')) > maxTokens) {
      windows.push({
        startLine: windowStart,
        endLine: windowStart + windowLines.length - 1,
        content: windowLines.join('\n'),
      });
      windowStart += windowLines.length;
      windowLines = [line];
    } else {
      windowLines = candidateLines;
    }
  }
  if (windowLines.length > 0) {
    windows.push({
      startLine: windowStart,
      endLine: windowStart + windowLines.length - 1,
      content: windowLines.join('\n'),
    });
  }

  return windows;
}

export function tagParts<T>(items: readonly T[]): Array<T & { partIndex: number; partTotal: number }> {
  const partTotal = items.length;
  return items.map((item, index) => ({ ...item, partIndex: index + 1, partTotal }));
}

function buildHeader(chunk: Chunk): string {
  const lines = [`file: ${chunk.filePath}`, `kind: ${chunk.kind}`];
  if (chunk.symbolName) lines.push(`symbol: ${chunk.symbolName}`);
  if (chunk.parentSymbol) lines.push(`parent: ${chunk.parentSymbol}`);
  if (chunk.signature) lines.push(`signature: ${chunk.signature}`);
  if (chunk.jsDoc) lines.push(`jsDoc: ${chunk.jsDoc}`);
  return lines.join('\n');
}

export function enrichChunk(chunk: Chunk): Chunk {
  const header = buildHeader(chunk);
  const embedText = `${header}\n\n${chunk.content}`;
  const hash = contentHash(chunk.chunkerKind, chunk.filePath, chunk.symbolName, chunk.partIndex, chunk.content);
  return { ...chunk, embedText, contentHash: hash };
}

export function enrich(chunks: readonly Chunk[]): Chunk[] {
  return chunks.map(enrichChunk);
}
