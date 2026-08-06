import { describe, expect, it } from 'vitest';
import { estimateTokens } from './tokens.js';

describe('estimateTokens', () => {
  it('estimates chars/4', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('rounds up for a partial token', () => {
    expect(estimateTokens('abc')).toBe(1);
  });

  it('returns 0 for empty content', () => {
    expect(estimateTokens('')).toBe(0);
  });
});
