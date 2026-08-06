import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AcquiredRepo, Result } from '../shared/types.js';

const execFileAsync = promisify(execFile);

export interface GitRunner {
  clone(url: string, targetDir: string): Promise<void>;
  fetchAndReset(targetDir: string): Promise<void>;
  revParseHead(targetDir: string): Promise<string | null>;
}

export const realGitRunner: GitRunner = {
  async clone(url, targetDir) {
    await mkdir(path.dirname(targetDir), { recursive: true });
    await execFileAsync('git', ['clone', '--depth', '1', url, targetDir]);
  },
  async fetchAndReset(targetDir) {
    await execFileAsync('git', ['-C', targetDir, 'fetch', '--depth', '1', 'origin']);
    await execFileAsync('git', ['-C', targetDir, 'reset', '--hard', 'FETCH_HEAD']);
  },
  async revParseHead(targetDir) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', targetDir, 'rev-parse', 'HEAD']);
      return stdout.trim();
    } catch {
      return null;
    }
  },
};

export interface AcquireOptions {
  refresh?: boolean;
  tmpRoot?: string;
}

type ParsedInput = { kind: 'github'; owner: string; repo: string } | { kind: 'invalid-url' } | { kind: 'local' };

function parseInput(input: string): ParsedInput {
  const looksLikeRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) || input.startsWith('git@');
  if (!looksLikeRemote) {
    return { kind: 'local' };
  }

  const prefix = 'https://github.com/';
  if (!input.startsWith(prefix)) {
    return { kind: 'invalid-url' };
  }

  const rest = input.slice(prefix.length);
  const match = /^([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(rest);
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo) {
    return { kind: 'invalid-url' };
  }

  return { kind: 'github', owner, repo };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function acquireRepo(
  input: string,
  options: AcquireOptions = {},
  git: GitRunner = realGitRunner,
): Promise<Result<AcquiredRepo, string>> {
  const parsed = parseInput(input);

  if (parsed.kind === 'invalid-url') {
    return { ok: false, error: `unsupported repo source: ${input}` };
  }

  if (parsed.kind === 'local') {
    const commitSha = await git.revParseHead(input);
    return { ok: true, value: { rootDir: input, source: 'local', commitSha } };
  }

  const tmpRoot = options.tmpRoot ?? './tmp';
  const targetDir = path.join(tmpRoot, parsed.repo);
  const url = `https://github.com/${parsed.owner}/${parsed.repo}`;
  const exists = await pathExists(targetDir);

  if (exists && options.refresh) {
    await git.fetchAndReset(targetDir);
  } else if (!exists) {
    await git.clone(url, targetDir);
  }

  const commitSha = await git.revParseHead(targetDir);
  return { ok: true, value: { rootDir: targetDir, source: 'git', commitSha } };
}
