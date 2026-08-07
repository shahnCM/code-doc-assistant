import { describe, expect, it } from 'vitest';
import { buildParams, HYBRID_SQL } from './fusion.js';

describe('HYBRID_SQL', () => {
  it('[1] uses cosine distance (<=>) and never L2 (<->)', () => {
    expect(HYBRID_SQL).toContain('<=>');
    expect(HYBRID_SQL).not.toContain('<->');
  });

  it('[5] limits each leg independently, with ROW_NUMBER() applied outside the limited subquery', () => {
    const limitCount = (HYBRID_SQL.match(/LIMIT \$3/g) ?? []).length;
    const rowNumberCount = (HYBRID_SQL.match(/ROW_NUMBER\(\) OVER/g) ?? []).length;
    expect(limitCount).toBe(2);
    expect(rowNumberCount).toBe(2);
  });
});

describe('buildParams', () => {
  it('[2] applies documented defaults when no options are given', () => {
    const params = buildParams('[1,0,0]', 'parseConfig');
    expect(params[2]).toBe(30); // $3 perLegLimit
    expect(params[4]).toBe(1.0); // $5 symbolBoost
    expect(params[5]).toBe(60); // $6 rrfK
    expect(params[6]).toBe(10); // $7 topK
    expect(params[7]).toBe(1.0); // $8 denseWeight
    expect(params[8]).toBe(1.0); // $9 lexicalWeight
  });

  it('[3] binds an omitted repoSource as JS null, never undefined and never the string "null"', () => {
    const params = buildParams('[1,0,0]', 'parseConfig');
    expect(params[3]).toBeNull();
    expect(params[3]).not.toBeUndefined();
    expect(params[3]).not.toBe('null');
  });

  it('[4] places explicit overrides at their correct positions and leaves the rest at default', () => {
    const params = buildParams('[1,0,0]', 'parseConfig', {
      rrfK: 10,
      topK: 3,
      denseWeight: 0,
    });
    expect(params[5]).toBe(10); // $6 rrfK
    expect(params[6]).toBe(3); // $7 topK
    expect(params[7]).toBe(0); // $8 denseWeight
    expect(params[4]).toBe(1.0); // $5 symbolBoost — untouched, still default
    expect(params[8]).toBe(1.0); // $9 lexicalWeight — untouched, still default
  });

  it('places a supplied repoSource at $4', () => {
    const params = buildParams('[1,0,0]', 'parseConfig', { repoSource: 'https://github.com/o/r' });
    expect(params[3]).toBe('https://github.com/o/r');
  });

  it('binds the vector literal at $1 and the query text at $2', () => {
    const params = buildParams('[1,0,0]', 'parseConfig');
    expect(params[0]).toBe('[1,0,0]');
    expect(params[1]).toBe('parseConfig');
  });
});
