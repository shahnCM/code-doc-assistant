import { describe, expect, it } from 'vitest';
import { estimateTokensNotGenerated } from './tokenEstimate.js';

describe('estimateTokensNotGenerated', () => {
  it('returns the full budget when nothing has been generated', () => {
    expect(estimateTokensNotGenerated('')).toBe(2048);
  });

  it('clamps to zero rather than going negative once the budget is exceeded', () => {
    expect(estimateTokensNotGenerated('a'.repeat(9000))).toBe(0);
  });
});
