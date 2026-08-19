import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile as writeRealFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EmbedCache } from '../index/cache.js';
import type { Db } from '../index/db.js';
import type { EmbedClient } from '../index/embedClient.js';
import type { GitRunner } from './acquire.js';
import { main } from './cli.js';

let workDir: string | undefined;

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function fakeGit(): GitRunner {
  return {
    async clone() {
      throw new Error('clone should not be called for a local --repo path');
    },
    async fetchAndReset() {
      throw new Error('fetchAndReset should not be called for a local --repo path');
    },
    async revParseHead() {
      return 'fake-sha';
    },
  };
}

function fakeEmbedClient(): { client: EmbedClient; callCount: { value: number } } {
  const callCount = { value: 0 };
  const client: EmbedClient = {
    async embedBatch(texts) {
      callCount.value += 1;
      return { ok: true, value: texts.map(() => [0, 0, 0]) };
    },
  };
  return { client, callCount };
}

function fakeDb(): { db: Db; calls: Array<{ text: string; params: readonly unknown[] }> } {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const db: Db = {
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows: [{ id: calls.length }] };
    },
    withTransaction: async (fn) => fn(db),
  };
  return { db, calls };
}

function noOpCache(): EmbedCache {
  return {
    async get() {
      return null;
    },
    async set() {
      // in-memory no-op — no real cache directory is ever touched by these tests
    },
  };
}

const validEnv = {
  DATABASE_URL: 'postgres://unused',
  GEMINI_API_KEY: 'unused',
  EMBED_MODEL: 'gemini-embedding-2',
  GEN_MODEL: 'gemini-3.6-flash',
};

describe('cli main()', () => {
  it('[REQ] runs the full --repo -> chunks -> embed -> store path end-to-end with fakes, no real network or Postgres', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cli-test-'));
    workDir = dir;
    await writeRealFile(path.join(dir, 'add.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');

    const written: Array<{ path: string; data: string }> = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const { client, callCount } = fakeEmbedClient();
    const { db, calls: dbCalls } = fakeDb();

    const exitCode = await main({
      argv: ['node', 'cli.ts', '--repo', dir, '--out', path.join(dir, 'out.json')],
      env: validEnv,
      git: fakeGit(),
      embedClient: client,
      cache: noOpCache(),
      db,
      writeFile: async (filePath, data) => {
        written.push({ path: filePath, data });
      },
      log: (msg) => logs.push(msg),
      logError: (msg) => errors.push(msg),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]?.data ?? '[]')).not.toHaveLength(0);
    expect(callCount.value).toBeGreaterThan(0);
    expect(dbCalls.length).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes('Deleted'))).toBe(true);
    expect(logs.some((line) => line.includes('Inserted'))).toBe(true);
  });

  it('exits 1 with a usage message when --repo is missing', async () => {
    const errors: string[] = [];

    const exitCode = await main({ argv: ['node', 'cli.ts'], logError: (msg) => errors.push(msg), log: () => {} });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain('Usage:');
  });

  it('exits 1 with a readable message when required env is missing, without ever calling the embed client', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cli-test-'));
    workDir = dir;
    await writeRealFile(path.join(dir, 'add.ts'), 'export const x = 1;\n');
    const errors: string[] = [];
    const { client, callCount } = fakeEmbedClient();

    const exitCode = await main({
      argv: ['node', 'cli.ts', '--repo', dir, '--out', path.join(dir, 'out.json')],
      env: {},
      git: fakeGit(),
      embedClient: client,
      cache: noOpCache(),
      writeFile: async () => {},
      logError: (msg) => errors.push(msg),
      log: () => {},
    });

    expect(exitCode).toBe(1);
    expect(errors[0]).toContain('Config error');
    expect(callCount.value).toBe(0);
  });
});
