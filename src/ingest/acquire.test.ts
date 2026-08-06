import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireRepo, type GitRunner } from './acquire.js';

let workDir: string | undefined;

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

function fakeGit(overrides: Partial<GitRunner> = {}): { git: GitRunner; calls: string[] } {
  const calls: string[] = [];
  const git: GitRunner = {
    async clone(url, target) {
      calls.push(`clone:${url}:${target}`);
      if (overrides.clone) await overrides.clone(url, target);
    },
    async fetchAndReset(target) {
      calls.push(`fetchAndReset:${target}`);
      if (overrides.fetchAndReset) await overrides.fetchAndReset(target);
    },
    async revParseHead(target) {
      calls.push(`revParseHead:${target}`);
      return overrides.revParseHead ? overrides.revParseHead(target) : null;
    },
  };
  return { git, calls };
}

describe('acquireRepo', () => {
  it('resolves a GitHub URL to ./tmp/<repo> and clones when the target is absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'acquire-test-'));
    workDir = dir;
    const { git, calls } = fakeGit({
      async clone(_url, target) {
        await mkdir(target, { recursive: true });
      },
      async revParseHead() {
        return 'abc123';
      },
    });

    const result = await acquireRepo('https://github.com/o/r', { tmpRoot: dir }, git);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rootDir).toBe(path.join(dir, 'r'));
      expect(result.value.source).toBe('git');
      expect(result.value.commitSha).toBe('abc123');
    }
    expect(calls).toContain(`clone:https://github.com/o/r:${path.join(dir, 'r')}`);
  });

  it('rejects non-GitHub and non-HTTPS remote inputs without attempting a clone', async () => {
    const { git, calls } = fakeGit();

    for (const input of ['git@github.com:o/r.git', 'http://github.com/o/r', 'https://gitlab.com/o/r']) {
      const result = await acquireRepo(input, {}, git);
      expect(result.ok).toBe(false);
    }

    expect(calls).toEqual([]);
  });

  it('uses a local path in place, writing nothing under tmp', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'acquire-test-'));
    workDir = dir;
    const localDir = path.join(dir, 'local-project');
    await mkdir(localDir, { recursive: true });
    const { git, calls } = fakeGit();

    const result = await acquireRepo(localDir, {}, git);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.rootDir).toBe(localDir);
      expect(result.value.source).toBe('local');
    }
    expect(calls.some((c) => c.startsWith('clone:'))).toBe(false);
  });

  it('reuses an existing clone directory and reports its SHA without cloning', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'acquire-test-'));
    workDir = dir;
    const target = path.join(dir, 'r');
    await mkdir(target, { recursive: true });
    const { git, calls } = fakeGit({
      async revParseHead() {
        return 'existing-sha';
      },
    });

    const result = await acquireRepo('https://github.com/o/r', { tmpRoot: dir }, git);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.commitSha).toBe('existing-sha');
    expect(calls.some((c) => c.startsWith('clone:'))).toBe(false);
    expect(calls.some((c) => c.startsWith('fetchAndReset:'))).toBe(false);
  });

  it('--refresh re-clones (fetch + reset) an existing directory instead of reusing it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'acquire-test-'));
    workDir = dir;
    const target = path.join(dir, 'r');
    await mkdir(target, { recursive: true });
    const { git, calls } = fakeGit({
      async revParseHead() {
        return 'refreshed-sha';
      },
    });

    const result = await acquireRepo('https://github.com/o/r', { tmpRoot: dir, refresh: true }, git);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.commitSha).toBe('refreshed-sha');
    expect(calls).toContain(`fetchAndReset:${target}`);
    expect(calls.some((c) => c.startsWith('clone:'))).toBe(false);
  });

  it('a local non-git directory resolves with commitSha null, not an error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'acquire-test-'));
    workDir = dir;
    const { git } = fakeGit({
      async revParseHead() {
        return null;
      },
    });

    const result = await acquireRepo(dir, {}, git);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source).toBe('local');
      expect(result.value.commitSha).toBeNull();
    }
  });
});
