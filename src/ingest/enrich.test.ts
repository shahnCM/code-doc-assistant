import { describe, expect, it } from 'vitest';
import type { Candidate } from '../shared/types.js';
import { genericChunker } from './chunkers/generic.js';
import { tsMorphChunker } from './chunkers/ts-morph.js';
import { enrich, splitByLines, tagParts } from './enrich.js';

function candidate(filePath: string, extension: string, language: string): Candidate {
  return { filePath, absolutePath: `/abs/${filePath}`, extension, language };
}

describe('splitByLines', () => {
  it('keeps a single window when content is within budget', () => {
    const windows = splitByLines('a\nb\nc', 1, 512);
    expect(windows).toEqual([{ startLine: 1, endLine: 3, content: 'a\nb\nc' }]);
  });

  it('splits into multiple windows once the budget is exceeded, covering every line exactly once', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} padding padding padding`);
    const windows = splitByLines(lines.join('\n'), 10, 100);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]?.startLine).toBe(10);
    expect(windows[windows.length - 1]?.endLine).toBe(10 + lines.length - 1);
    const rejoined = windows.map((w) => w.content).join('\n');
    expect(rejoined).toBe(lines.join('\n'));
  });
});

describe('tagParts', () => {
  it('assigns 1-based partIndex and a shared partTotal', () => {
    const tagged = tagParts([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(tagged.map((t) => t.partIndex)).toEqual([1, 2, 3]);
    expect(tagged.every((t) => t.partTotal === 3)).toBe(true);
  });

  it('handles a single item', () => {
    const tagged = tagParts([{ a: 1 }]);
    expect(tagged).toEqual([{ a: 1, partIndex: 1, partTotal: 1 }]);
  });
});

describe('enrich', () => {
  it('[REQ] gives every chunk from both chunkers an enrichment header, without fabricating generic signature/jsDoc', () => {
    const tsResult = tsMorphChunker.chunk(
      candidate('add.ts', '.ts', 'typescript'),
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    );
    const genericResult = genericChunker.chunk(
      candidate('tool.py', '.py', 'python'),
      'def main():\n    print("hello")\n',
    );

    expect(tsResult.ok).toBe(true);
    expect(genericResult.ok).toBe(true);
    if (!tsResult.ok || !genericResult.ok) return;

    const enriched = enrich([...tsResult.value.chunks, ...genericResult.value.chunks]);
    expect(enriched.length).toBeGreaterThan(0);

    for (const chunk of enriched) {
      expect(chunk.embedText).toContain(`file: ${chunk.filePath}`);
      expect(chunk.embedText).toContain(`kind: ${chunk.kind}`);
      expect(chunk.embedText).toContain(chunk.content);
      expect(chunk.contentHash.length).toBeGreaterThan(0);
    }

    const genericChunks = enriched.filter((c) => c.chunkerKind === 'generic');
    expect(genericChunks.length).toBeGreaterThan(0);
    for (const chunk of genericChunks) {
      expect(chunk.signature).toBeNull();
      expect(chunk.jsDoc).toBeNull();
    }
  });

  it('does not mutate the fields it does not own', () => {
    const result = tsMorphChunker.chunk(
      candidate('add.ts', '.ts', 'typescript'),
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [before] = result.value.chunks;
    const [after] = enrich(result.value.chunks);
    expect(after?.symbolName).toBe(before?.symbolName);
    expect(after?.kind).toBe(before?.kind);
    expect(after?.signature).toBe(before?.signature);
    expect(after?.startLine).toBe(before?.startLine);
    expect(after?.endLine).toBe(before?.endLine);
    expect(after?.content).toBe(before?.content);
  });
});
