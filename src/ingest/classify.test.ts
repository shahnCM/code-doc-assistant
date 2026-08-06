import { describe, expect, it } from 'vitest';
import { classify } from './classify.js';

describe('classify', () => {
  it('routes all eight TS/JS extensions to typescript or javascript', () => {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) {
      expect(classify(`file${ext}`).language).toBe('typescript');
    }
    for (const ext of ['.js', '.jsx', '.mjs', '.cjs']) {
      expect(classify(`file${ext}`).language).toBe('javascript');
    }
  });

  it('routes known non-TS/JS extensions to their language', () => {
    expect(classify('scripts/tool.py').language).toBe('python');
    expect(classify('main.go').language).toBe('go');
    expect(classify('README.md').language).toBe('markdown');
  });

  it('routes an unknown extension to unknown', () => {
    expect(classify('data.unknownext').language).toBe('unknown');
  });

  it('returns extension and language only — no chunker knowledge', () => {
    const result = classify('src/index.ts');
    expect(result).toEqual({ extension: '.ts', language: 'typescript' });
    expect(Object.keys(result).sort()).toEqual(['extension', 'language']);
  });
});
