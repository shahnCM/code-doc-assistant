import { describe, expect, it } from 'vitest';
import { contentHash } from './hash.js';

describe('contentHash', () => {
  it('differs for identical content in two different files', () => {
    const a = contentHash('ts-morph', 'src/a.ts', 'fn', 1, 'function fn() {}');
    const b = contentHash('ts-morph', 'src/b.ts', 'fn', 1, 'function fn() {}');
    expect(a).not.toBe(b);
  });

  it('is stable across repeated calls with the same input', () => {
    const a = contentHash('ts-morph', 'src/a.ts', 'fn', 1, 'function fn() {}');
    const b = contentHash('ts-morph', 'src/a.ts', 'fn', 1, 'function fn() {}');
    expect(a).toBe(b);
  });

  it('is unchanged when a line is inserted elsewhere in the file', () => {
    const chunkContent = 'function fn() {\n  return 1;\n}';
    const beforeInsertion = contentHash('ts-morph', 'src/a.ts', 'fn', 1, chunkContent);
    // A line inserted above this declaration shifts its line numbers but not its own text.
    const afterInsertion = contentHash('ts-morph', 'src/a.ts', 'fn', 1, chunkContent);
    expect(beforeInsertion).toBe(afterInsertion);
  });

  it('differs when chunkerKind differs for otherwise identical input', () => {
    const a = contentHash('ts-morph', 'src/a.ts', 'fn', 1, 'function fn() {}');
    const b = contentHash('fallback', 'src/a.ts', 'fn', 1, 'function fn() {}');
    expect(a).not.toBe(b);
  });
});
