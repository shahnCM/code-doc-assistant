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

  it('is unchanged when a line is inserted elsewhere in the file, shifting the declaration but not its text', () => {
    const before = ['function fn() {', '  return 1;', '}', ''].join('\n');
    const after = ['// a comment inserted above', 'function fn() {', '  return 1;', '}', ''].join('\n');

    // Declaration sits at line 1 in `before` and line 2 in `after` — different startLine,
    // same declaration text. contentHash takes content, not line numbers, so slicing each
    // version at its own (shifted) position must yield identical content and therefore hashes.
    const beforeContent = before.split('\n').slice(0, 3).join('\n');
    const afterContent = after.split('\n').slice(1, 4).join('\n');
    expect(beforeContent).toBe(afterContent);

    const beforeHash = contentHash('ts-morph', 'src/a.ts', 'fn', 1, beforeContent);
    const afterHash = contentHash('ts-morph', 'src/a.ts', 'fn', 1, afterContent);
    expect(afterHash).toBe(beforeHash);
  });

  it('differs when chunkerKind differs for otherwise identical input', () => {
    const a = contentHash('ts-morph', 'src/a.ts', 'fn', 1, 'function fn() {}');
    const b = contentHash('fallback', 'src/a.ts', 'fn', 1, 'function fn() {}');
    expect(a).not.toBe(b);
  });
});
