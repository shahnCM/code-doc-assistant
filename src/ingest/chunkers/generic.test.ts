import { describe, expect, it } from 'vitest';
import type { Candidate } from '../../shared/types.js';
import { estimateTokens } from '../tokens.js';
import { genericChunker } from './generic.js';

function candidate(filePath: string, extension: string, language: string): Candidate {
  return { filePath, absolutePath: `/abs/${filePath}`, extension, language };
}

describe('genericChunker.supports', () => {
  it('supports every candidate unconditionally', () => {
    expect(genericChunker.supports(candidate('a.py', '.py', 'python'))).toBe(true);
    expect(genericChunker.supports(candidate('a.ts', '.ts', 'typescript'))).toBe(true);
    expect(genericChunker.supports(candidate('a.unknownext', '', 'unknown'))).toBe(true);
  });
});

describe('genericChunker.chunk — indent mode', () => {
  it('[REQ] routes a Python file to indent mode, taking symbolName from def/class, never fabricating signature/jsDoc', () => {
    const source = [
      'def main():',
      '    """This is a docstring, not jsDoc."""',
      '    print("hello")',
      '    print("world")',
      '    return None',
      '',
      '',
      'class Foo:',
      '    def method(self):',
      '        return 1',
      '',
      '    def other(self):',
      '        return 2',
      '',
    ].join('\n');

    const result = genericChunker.chunk(candidate('tool.py', '.py', 'python'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outcome).toBe('chunked');
    const chunks = result.value.chunks;
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.symbolName).toBe('main');
    expect(chunks[1]?.symbolName).toBe('Foo');

    for (const c of chunks) {
      expect(c.signature).toBeNull();
      expect(c.jsDoc).toBeNull();
      expect(c.kind).toBe('block');
      expect(c.chunkerKind).toBe('generic');
      expect(c.language).toBe('python');
    }
    expect(chunks[0]?.content).toContain('This is a docstring, not jsDoc.');
  });
});

describe('genericChunker.chunk — unknown extension', () => {
  it('[REQ] routes an unknown extension to generic without throwing', () => {
    const source = ['some random content', 'with multiple', '} lines that look weird {', ''].join('\n');

    const result = genericChunker.chunk(candidate('data.unknownext', '', 'unknown'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.chunks.every((c) => c.language === 'unknown')).toBe(true);
    expect(result.value.chunks.every((c) => c.chunkerKind === 'generic')).toBe(true);
    expect(result.value.chunks.every((c) => c.signature === null && c.jsDoc === null)).toBe(true);
  });
});

describe('genericChunker.chunk — brace mode depth scanning', () => {
  it('does not let a } inside a string literal or a comment terminate a block', () => {
    const source = [
      'function outer() {',
      '  const s = "text with a } brace inside";',
      '  // comment with a } brace too',
      '  const t = `template with } as well`;',
      '  return s + t;',
      '}',
      '',
    ].join('\n');

    const result = genericChunker.chunk(candidate('weird.js', '.js', 'javascript'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.chunks.length).toBe(1);
    const chunk = result.value.chunks[0];
    expect(chunk?.startLine).toBe(1);
    expect(chunk?.endLine).toBe(6);
    expect(chunk?.content).toContain('return s + t;');
    expect(chunk?.content.trim().endsWith('}')).toBe(true);
  });
});

describe('genericChunker.chunk — token budget merge/split', () => {
  it('[REQ] merges blocks under 24 tokens', () => {
    const source = ['function a() {}', 'function b() {}', 'function c() {}', ''].join('\n');

    const result = genericChunker.chunk(candidate('tiny.js', '.js', 'javascript'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.chunks.length).toBe(1);
    expect(result.value.chunks[0]?.content).toContain('function a()');
    expect(result.value.chunks[0]?.content).toContain('function b()');
    expect(result.value.chunks[0]?.content).toContain('function c()');
  });

  it('[REQ] splits a block over 512 tokens, none of its parts exceeding budget', () => {
    const bodyLines = Array.from({ length: 200 }, (_, i) => `  const x${i} = ${i};`);
    const source = ['function big() {', ...bodyLines, '}', ''].join('\n');

    const result = genericChunker.chunk(candidate('big.js', '.js', 'javascript'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const chunks = result.value.chunks;
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateTokens(c.content)).toBeLessThanOrEqual(512);
    }
    expect(chunks.map((c) => c.partIndex)).toEqual(chunks.map((_, i) => i + 1));
    expect(chunks.every((c) => c.partTotal === chunks.length)).toBe(true);
    expect(chunks[0]?.content).toContain('function big() {');
  });
});

describe('genericChunker.chunk — decorator attachment', () => {
  it('[REQ] keeps a decorator line attached to the def/class it modifies, so symbolName still resolves', () => {
    const source = [
      '@nox.session',
      'def build_and_check_dists(session):',
      '    session.install("build")',
      '    session.run("python", "-m", "build")',
      '    session.log("build complete")',
      '',
      '',
      '@nox.session(python="3.11")',
      'def tests(session):',
      '    session.install("pytest")',
      '    session.run("pytest", "tests/")',
      '    session.log("tests complete")',
      '',
    ].join('\n');

    const result = genericChunker.chunk(candidate('noxfile.py', '.py', 'python'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const chunks = result.value.chunks;
    expect(chunks.map((c) => c.symbolName)).toEqual(['build_and_check_dists', 'tests']);
    for (const c of chunks) {
      expect(c.content).toContain('@nox.session');
    }
  });
});

describe('genericChunker.chunk — best-effort symbolName', () => {
  it('is null when the first line is not definition-shaped', () => {
    const source = ['someValue = 42;', 'anotherValue = someValue + 1;', ''].join('\n');

    const result = genericChunker.chunk(candidate('data.unknownext', '', 'unknown'), source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.chunks[0]?.symbolName).toBeNull();
  });
});
