import { describe, expect, it } from 'vitest';
import { loadEnv } from './config.js';

const validEnv = {
  DATABASE_URL: 'postgres://admin:admin@postgres-16:5432/codedocs',
  GEMINI_API_KEY: 'test-key',
  EMBED_MODEL: 'gemini-embedding-2',
  GEN_MODEL: 'gemini-3.6-flash',
};

describe('loadEnv', () => {
  it('[REQ] returns ok:true with all four parsed values when present, with no real process.env needed', () => {
    const result = loadEnv(validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(validEnv);
  });

  it('[REQ] returns ok:false with a readable message when a required key is missing', () => {
    const { GEMINI_API_KEY: _omit, ...withoutKey } = validEnv;
    const result = loadEnv(withoutKey);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('GEMINI_API_KEY');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('returns ok:false when a required key is present but empty', () => {
    const result = loadEnv({ ...validEnv, DATABASE_URL: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('DATABASE_URL');
  });
});
