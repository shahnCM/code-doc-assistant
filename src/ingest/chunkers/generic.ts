import type { Candidate, Chunk, ChunkError, ChunkerOutput, Result } from '../../shared/types.js';
import { estimateTokens } from '../tokens.js';
import type { Chunker } from './index.js';

const MAX_TOKENS = 512;
const MIN_TOKENS = 24;

const INDENT_LANGUAGES = new Set(['python']);

const DEFINITION_PATTERN =
  /^(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+)*(?:def|class|function|func|fn|struct|interface|type|const|let|var|impl|trait|enum|module|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

interface RawBlock {
  startLine: number;
  endLine: number;
  content: string;
}

function braceModeBlocks(source: string): RawBlock[] {
  const lines = source.split('\n');
  const blocks: RawBlock[] = [];

  let depth = 0;
  let seenOpenBrace = false;
  let stringChar: string | null = null;
  let inBlockComment = false;

  let blockStartLine = 1;
  let blockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i] ?? '';
    blockLines.push(line);

    let inLineComment = false;
    for (let c = 0; c < line.length; c++) {
      if (inLineComment) break;
      const ch = line[c];
      const next = line[c + 1];

      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          c++;
        }
        continue;
      }

      if (stringChar) {
        if (ch === '\\') {
          c++;
          continue;
        }
        if (ch === stringChar) {
          stringChar = null;
        }
        continue;
      }

      if (ch === '/' && next === '/') {
        inLineComment = true;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        c++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        stringChar = ch;
        continue;
      }
      if (ch === '{') {
        depth++;
        seenOpenBrace = true;
        continue;
      }
      if (ch === '}') {
        depth = Math.max(0, depth - 1);
        continue;
      }
    }

    if (seenOpenBrace && depth === 0) {
      blocks.push({ startLine: blockStartLine, endLine: lineNo, content: blockLines.join('\n') });
      blockStartLine = lineNo + 1;
      blockLines = [];
      seenOpenBrace = false;
    }
  }

  const remainder = blockLines.join('\n');
  if (remainder.trim() !== '') {
    blocks.push({ startLine: blockStartLine, endLine: lines.length, content: remainder });
  }

  return blocks;
}

function indentModeBlocks(source: string): RawBlock[] {
  const lines = source.split('\n');
  const blocks: RawBlock[] = [];

  let blockStartLine = 1;
  let blockLines: string[] = [];
  let started = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i] ?? '';
    const isTopLevel = line.trim() !== '' && line[0] !== ' ' && line[0] !== '\t';

    if (isTopLevel && started) {
      const content = blockLines.join('\n');
      if (content.trim() !== '') {
        blocks.push({ startLine: blockStartLine, endLine: lineNo - 1, content });
      }
      blockStartLine = lineNo;
      blockLines = [];
    }

    blockLines.push(line);
    if (isTopLevel) started = true;
  }

  const content = blockLines.join('\n');
  if (content.trim() !== '') {
    blocks.push({ startLine: blockStartLine, endLine: lines.length, content });
  }

  return blocks;
}

function mergeSmallBlocks(blocks: RawBlock[]): RawBlock[] {
  const merged: RawBlock[] = [];
  let acc: RawBlock | undefined;

  for (const block of blocks) {
    if (!acc) {
      acc = block;
      continue;
    }
    if (estimateTokens(acc.content) < MIN_TOKENS) {
      acc = { startLine: acc.startLine, endLine: block.endLine, content: `${acc.content}\n${block.content}` };
    } else {
      merged.push(acc);
      acc = block;
    }
  }
  if (acc) merged.push(acc);

  return merged;
}

function splitLargeBlock(block: RawBlock): RawBlock[] {
  if (estimateTokens(block.content) <= MAX_TOKENS) {
    return [block];
  }

  const lines = block.content.split('\n');
  const parts: RawBlock[] = [];
  let windowLines: string[] = [];
  let windowStart = block.startLine;

  for (const line of lines) {
    const candidateLines = [...windowLines, line];
    if (windowLines.length > 0 && estimateTokens(candidateLines.join('\n')) > MAX_TOKENS) {
      parts.push({
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
    parts.push({ startLine: windowStart, endLine: windowStart + windowLines.length - 1, content: windowLines.join('\n') });
  }

  return parts;
}

function extractSymbolName(content: string): string | null {
  const firstLine = content.split('\n').find((line) => line.trim() !== '');
  if (!firstLine) return null;
  const match = DEFINITION_PATTERN.exec(firstLine.trim());
  return match?.[1] ?? null;
}

function toChunk(candidate: Candidate, block: RawBlock, symbolName: string | null, partIndex: number, partTotal: number): Chunk {
  return {
    filePath: candidate.filePath,
    symbolName,
    kind: 'block',
    signature: null,
    jsDoc: null,
    startLine: block.startLine,
    endLine: block.endLine,
    parentSymbol: null,
    isExported: false,
    contentHash: '',
    language: candidate.language,
    chunkerKind: 'generic',
    partIndex,
    partTotal,
    content: block.content,
    embedText: '',
  };
}

function chunkSource(candidate: Candidate, source: string): Result<ChunkerOutput, ChunkError> {
  try {
    const mode = INDENT_LANGUAGES.has(candidate.language) ? 'indent' : 'brace';
    const rawBlocks = mode === 'indent' ? indentModeBlocks(source) : braceModeBlocks(source);
    const mergedBlocks = mergeSmallBlocks(rawBlocks);

    const chunks: Chunk[] = [];
    for (const block of mergedBlocks) {
      const symbolName = extractSymbolName(block.content);
      const parts = splitLargeBlock(block);
      const partTotal = parts.length;
      parts.forEach((part, index) => {
        chunks.push(toChunk(candidate, part, symbolName, index + 1, partTotal));
      });
    }

    if (chunks.length === 0) {
      return { ok: true, value: { chunks: [], outcome: 'no-declarations' } };
    }
    return { ok: true, value: { chunks, outcome: 'chunked' } };
  } catch (error) {
    return {
      ok: false,
      error: { filePath: candidate.filePath, reason: error instanceof Error ? error.message : String(error) },
    };
  }
}

export const genericChunker: Chunker = {
  name: 'generic',
  chunkerKind: 'generic',
  supports() {
    return true;
  },
  chunk(candidate, source) {
    return chunkSource(candidate, source);
  },
};
