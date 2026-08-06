import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../shared/types.js';
import { estimateTokens } from '../tokens.js';
import { tsMorphChunker } from './ts-morph.js';

function candidate(filePath: string, extension = '.ts', language = 'typescript'): Candidate {
  return { filePath, absolutePath: `/abs/${filePath}`, extension, language };
}

function padLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `    const x${i} = ${i};`).join('\n');
}

describe('tsMorphChunker.supports', () => {
  it('supports all eight TS/JS extensions and nothing else', () => {
    for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']) {
      expect(tsMorphChunker.supports(candidate(`f${extension}`, extension, 'typescript'))).toBe(true);
    }
    expect(tsMorphChunker.supports(candidate('f.py', '.py', 'python'))).toBe(false);
  });
});

describe('tsMorphChunker.chunk — classes', () => {
  it('[REQ] splits an oversized class at method boundaries, never cutting a method in half', () => {
    const source = [
      'export class Foo {',
      '  alpha(): number {',
      padLines(60),
      '    return 1;',
      '  }',
      '',
      '  beta(): number {',
      padLines(60),
      '    return 2;',
      '  }',
      '',
      '  gamma(): number {',
      padLines(60),
      '    return 3;',
      '  }',
      '}',
      '',
    ].join('\n');

    const result = tsMorphChunker.chunk(candidate('foo.ts'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outcome).toBe('chunked');
    const chunks = result.value.chunks;
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.symbolName)).toEqual(['alpha', 'beta', 'gamma']);

    for (const c of chunks) {
      expect(c.kind).toBe('method');
      expect(c.parentSymbol).toBe('Foo');
      expect(c.partTotal).toBe(3);
      expect(c.content.trim().endsWith('}')).toBe(true);
    }
    expect(chunks.map((c) => c.partIndex)).toEqual([1, 2, 3]);
    expect(chunks[0]?.content.trim().startsWith('alpha(): number {')).toBe(true);
    expect(chunks[1]?.content.trim().startsWith('beta(): number {')).toBe(true);
    expect(chunks[2]?.content.trim().startsWith('gamma(): number {')).toBe(true);
  });

  it('keeps a class under budget as a single class chunk with no parent', () => {
    const source = ['export class Bar {', "  greet(): string {", "    return 'hi';", '  }', '}', ''].join('\n');

    const result = tsMorphChunker.chunk(candidate('bar.ts'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.chunks.length).toBe(1);
    const chunk = result.value.chunks[0];
    expect(chunk?.kind).toBe('class');
    expect(chunk?.symbolName).toBe('Bar');
    expect(chunk?.parentSymbol).toBeNull();
  });
});

describe('tsMorphChunker.chunk — diagnostics gate', () => {
  it('[REQ] falls back to a line-window chunk for an unparseable file, counted as degraded', () => {
    const broken = 'export function broken( {{{ this is not valid typescript syntax at all!!! ---';

    const result = tsMorphChunker.chunk(candidate('broken.ts'), broken);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outcome).toBe('degraded');
    expect(result.value.chunks.length).toBeGreaterThan(0);
    for (const c of result.value.chunks) {
      expect(c.chunkerKind).toBe('fallback');
    }
  });

  it('still chunks surrounding files after a broken file was processed', () => {
    tsMorphChunker.chunk(candidate('broken2.ts'), 'export function broken( {{{ ---');

    const result = tsMorphChunker.chunk(candidate('good.ts'), 'export function ok(): void {}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe('chunked');
    expect(result.value.chunks[0]?.chunkerKind).toBe('ts-morph');
  });

  it('produces zero fallbacks for a clean file with an unresolvable import', () => {
    const source = [
      "import { doesNotExist } from './nowhere';",
      '',
      'export function useIt(): void {',
      '  doesNotExist();',
      '}',
      '',
    ].join('\n');

    const result = tsMorphChunker.chunk(candidate('clean.ts'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outcome).toBe('chunked');
    expect(result.value.chunks.every((c) => c.chunkerKind !== 'fallback')).toBe(true);
  });
});

describe('tsMorphChunker.chunk — barrel re-exports', () => {
  it('[REQ] yields a single re-export chunk for a barrel file', () => {
    const source = ["export * from './a';", "export { b } from './b';", "export { c as d } from './c';", ''].join(
      '\n',
    );

    const result = tsMorphChunker.chunk(candidate('index.ts'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outcome).toBe('chunked');
    expect(result.value.chunks.length).toBe(1);
    expect(result.value.chunks[0]?.kind).toBe('re-export');
  });

  it('yields exactly one chunk for fifty re-exports, not fifty', () => {
    const source = Array.from({ length: 50 }, (_, i) => `export { x${i} } from './m${i}';`).join('\n');

    const result = tsMorphChunker.chunk(candidate('barrel.ts'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.chunks.length).toBe(1);
    expect(result.value.chunks[0]?.kind).toBe('re-export');
  });
});

describe('tsMorphChunker.chunk — zero declarations', () => {
  it('[REQ] yields a single file chunk, counted no-declarations, not a failure', () => {
    const source = ["import { thing } from './thing';", '', 'thing();', "console.log('side effect');", ''].join(
      '\n',
    );

    const result = tsMorphChunker.chunk(candidate('side.ts'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outcome).toBe('no-declarations');
    expect(result.value.chunks.length).toBe(1);
    expect(result.value.chunks[0]?.kind).toBe('file');
  });
});

describe('tsMorphChunker.chunk — signature composition', () => {
  it('gives a 50-line-body function a single-line signature', () => {
    const source = [
      'export function big(a: number, b: string): number {',
      padLines(50),
      '  return a;',
      '}',
      '',
    ].join('\n');

    const result = tsMorphChunker.chunk(candidate('big.ts'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const chunk = result.value.chunks[0];
    expect(chunk?.signature).toBe('export function big(a: number, b: string): number');
    expect(chunk?.signature?.includes('\n')).toBe(false);
  });

  it('captures jsDoc and includes it in startLine', () => {
    const source = [
      '/**',
      ' * Adds two numbers.',
      ' */',
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
    ].join('\n');

    const result = tsMorphChunker.chunk(candidate('add.ts'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const chunk = result.value.chunks[0];
    expect(chunk?.jsDoc).toContain('Adds two numbers.');
    expect(chunk?.startLine).toBe(1);
    expect(chunk?.endLine).toBe(6);
  });
});

describe('tsMorphChunker.chunk — const inclusion rules', () => {
  it('[REQ] chunks an exported arrow const and a private function-valued const, skips a private object literal', () => {
    const source = [
      'export const Comp = (a: number): number => a * 2;',
      "const helper = () => 'x';",
      'const MAGIC = { a: 1, b: 2 };',
      '',
    ].join('\n');

    const result = tsMorphChunker.chunk(candidate('consts.ts'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const chunks = result.value.chunks;
    expect(chunks.length).toBe(2);
    const names = chunks.map((c) => c.symbolName);
    expect(names).toContain('Comp');
    expect(names).toContain('helper');
    expect(names).not.toContain('MAGIC');

    const comp = chunks.find((c) => c.symbolName === 'Comp');
    expect(comp?.kind).toBe('const');
    expect(comp?.isExported).toBe(true);

    const helper = chunks.find((c) => c.symbolName === 'helper');
    expect(helper?.kind).toBe('const');
    expect(helper?.isExported).toBe(false);
  });
});

describe('tsMorphChunker.chunk — interface, type alias, enum', () => {
  it('[REQ] emits distinct kinds for interface, type alias and enum', () => {
    const source = [
      'export interface Foo { x: number; }',
      'export type Bar = { y: string };',
      'export enum Color { Red, Green, Blue }',
      '',
    ].join('\n');

    const result = tsMorphChunker.chunk(candidate('kinds.ts'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.chunks.map((c) => c.kind).sort()).toEqual(['enum', 'interface', 'type-alias']);
  });
});

describe('tsMorphChunker.chunk — oversized function splitting', () => {
  it('[REQ] splits an oversized function by statement block, reconstructing the original body', () => {
    const bodyLines = Array.from({ length: 200 }, (_, i) => `  const x${i} = ${i};`);
    const source = ['export function big(seed: number): number {', ...bodyLines, '  return seed;', '}', ''].join(
      '\n',
    );

    const result = tsMorphChunker.chunk(candidate('big.ts'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outcome).toBe('chunked');
    const chunks = result.value.chunks;
    expect(chunks.length).toBeGreaterThan(1);

    for (const c of chunks) {
      expect(estimateTokens(c.content)).toBeLessThanOrEqual(512);
      expect(c.kind).toBe('function');
      expect(c.symbolName).toBe('big');
      expect(c.signature).toBe('export function big(seed: number): number');
    }

    expect(chunks.map((c) => c.partIndex)).toEqual(chunks.map((_, i) => i + 1));
    expect(chunks.every((c) => c.partTotal === chunks.length)).toBe(true);

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]?.startLine).toBeGreaterThanOrEqual(1);
      expect(chunks[i]?.endLine).toBeGreaterThanOrEqual(chunks[i]?.startLine ?? 0);
      if (i > 0) {
        expect(chunks[i]?.startLine).toBe((chunks[i - 1]?.endLine ?? 0) + 1);
      }
    }

    const rejoinedBody = chunks.map((c) => c.content).join('\n');
    const originalBody = [...bodyLines, '  return seed;'].join('\n');
    expect(rejoinedBody).toBe(originalBody);
  });

  it('keeps a small function as a single part', () => {
    const result = tsMorphChunker.chunk(candidate('small.ts'), 'export function small(): number {\n  return 1;\n}\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.chunks.length).toBe(1);
    expect(result.value.chunks[0]?.partIndex).toBe(1);
    expect(result.value.chunks[0]?.partTotal).toBe(1);
  });
});
