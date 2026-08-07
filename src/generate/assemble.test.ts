import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RetrievedChunk } from '../shared/types.js';
import { estimateTokens } from '../tokens.js';
import { assembleContext, renderChunkBlock } from './assemble.js';

const GENERATE_DIR = path.dirname(fileURLToPath(import.meta.url));

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

describe('src/generate/ boundary', () => {
  it('[1] imports nothing from src/ingest/ — the estimateTokens move stays behind the boundary', () => {
    const files = readdirSync(GENERATE_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(path.join(GENERATE_DIR, file), 'utf8');
      expect(source).not.toMatch(/['"][^'"]*ingest[^'"]*['"]/);
    }
  });
});

describe('assembleContext', () => {
  it('[2][REQ] dedupes by file, keeping the higher fusedScore chunk', () => {
    const winner = retrievedChunk({ id: 1, filePath: 'src/a.ts', fusedScore: 0.9, content: 'winner' });
    const loser = retrievedChunk({ id: 2, filePath: 'src/a.ts', fusedScore: 0.1, content: 'loser' });

    const result = assembleContext([loser, winner]);

    expect(result.included).toEqual([winner]);
    expect(result.dropped).toEqual([loser]);
  });

  it('[3] orders included chunks by fusedScore descending regardless of input order', () => {
    const low = retrievedChunk({ id: 1, filePath: 'src/low.ts', fusedScore: 0.1 });
    const high = retrievedChunk({ id: 2, filePath: 'src/high.ts', fusedScore: 0.9 });
    const mid = retrievedChunk({ id: 3, filePath: 'src/mid.ts', fusedScore: 0.5 });

    const result = assembleContext([low, high, mid]);

    expect(result.included.map((c) => c.filePath)).toEqual(['src/high.ts', 'src/mid.ts', 'src/low.ts']);
  });

  it('[4][REQ] drops whole blocks from the tail once the budget is exceeded', () => {
    const a = retrievedChunk({ id: 1, filePath: 'src/a.ts', fusedScore: 0.9, content: 'a'.repeat(200) });
    const b = retrievedChunk({ id: 2, filePath: 'src/b.ts', fusedScore: 0.8, content: 'b'.repeat(200) });
    const c = retrievedChunk({ id: 3, filePath: 'src/c.ts', fusedScore: 0.7, content: 'c'.repeat(200) });
    const budget = estimateTokens(renderChunkBlock(a)) + estimateTokens(renderChunkBlock(b));

    const result = assembleContext([a, b, c], { tokenBudget: budget });

    expect(result.included).toEqual([a, b]);
    expect(result.dropped).toEqual([c]);
    expect(result.budgetExceeded).toBe(false);
    expect(result.text).not.toContain('c'.repeat(10));
    const lastLine = result.text.trimEnd().split('\n').at(-1) ?? '';
    expect(lastLine.startsWith('---')).toBe(false);
  });

  it('[5] includes a single oversized top block whole and sets budgetExceeded', () => {
    const huge = retrievedChunk({ id: 1, filePath: 'src/huge.ts', fusedScore: 0.9, content: 'x'.repeat(10_000) });

    const result = assembleContext([huge], { tokenBudget: 10 });

    expect(result.included).toEqual([huge]);
    expect(result.dropped).toEqual([]);
    expect(result.budgetExceeded).toBe(true);
    expect(result.text).toContain('x'.repeat(10_000));
  });

  it('[6] returns an empty context for empty input without throwing', () => {
    const result = assembleContext([]);

    expect(result).toEqual({ text: '', included: [], dropped: [], budgetExceeded: false });
  });

  it('[7] renders the header line exactly, omitting the symbol parenthetical when null', () => {
    const withSymbol = retrievedChunk({
      id: 1,
      filePath: 'src/retrieve/fusion.ts',
      fusedScore: 1,
      startLine: 36,
      endLine: 68,
      symbolName: 'buildParams',
      language: 'typescript',
      content: 'body',
    });
    const withoutSymbol = retrievedChunk({
      id: 2,
      filePath: 'docs/readme.md',
      fusedScore: 1,
      startLine: 1,
      endLine: 5,
      symbolName: null,
      language: 'markdown',
      content: 'body',
    });

    expect(renderChunkBlock(withSymbol)).toBe('--- src/retrieve/fusion.ts:36-68 (buildParams) [typescript] ---\nbody');
    expect(renderChunkBlock(withoutSymbol)).toBe('--- docs/readme.md:1-5 [markdown] ---\nbody');
  });
});
