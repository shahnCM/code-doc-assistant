import type { Candidate, Chunk, ChunkError, ChunkerOutput, Result } from '../../shared/types.js';
import { splitByLines, tagParts } from '../enrich.js';
import { estimateTokens } from '../../tokens.js';
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
  let pendingDecorator = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    const isTopLevel = trimmed !== '' && line[0] !== ' ' && line[0] !== '\t';

    // A decorator line attaches to whatever follows, so it must not close the block that
    // precedes it — the boundary belongs before the decorator, not after it.
    if (isTopLevel && started && !pendingDecorator) {
      const content = blockLines.join('\n');
      if (content.trim() !== '') {
        blocks.push({ startLine: blockStartLine, endLine: lineNo - 1, content });
      }
      blockStartLine = lineNo;
      blockLines = [];
    }

    blockLines.push(line);
    if (isTopLevel) started = true;
    pendingDecorator = isTopLevel && trimmed.startsWith('@');
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
  return splitByLines(block.content, block.startLine, MAX_TOKENS);
}

function extractSymbolName(content: string): string | null {
  const definitionLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('@'));
  if (!definitionLine) return null;
  const match = DEFINITION_PATTERN.exec(definitionLine);
  return match?.[1] ?? null;
}

function toChunk(candidate: Candidate, part: RawBlock & { partIndex: number; partTotal: number }, symbolName: string | null): Chunk {
  return {
    filePath: candidate.filePath,
    symbolName,
    kind: 'block',
    signature: null,
    jsDoc: null,
    startLine: part.startLine,
    endLine: part.endLine,
    parentSymbol: null,
    isExported: false,
    contentHash: '',
    language: candidate.language,
    chunkerKind: 'generic',
    partIndex: part.partIndex,
    partTotal: part.partTotal,
    content: part.content,
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
      const parts = tagParts(splitLargeBlock(block));
      for (const part of parts) {
        chunks.push(toChunk(candidate, part, symbolName));
      }
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
