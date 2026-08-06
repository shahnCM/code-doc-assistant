import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { walk, type WalkEntry } from './walk.js';

const FIXTURE_ROOT = path.join(process.cwd(), 'tests/fixtures/sample-repo');

let workDir: string | undefined;

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

async function setupWorkDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'walk-test-'));
  await cp(FIXTURE_ROOT, dir, { recursive: true });

  await mkdir(path.join(dir, 'node_modules', 'somepkg'), { recursive: true });
  await writeFile(path.join(dir, 'node_modules', 'somepkg', 'index.js'), 'module.exports = {};');

  await mkdir(path.join(dir, '.git'), { recursive: true });
  await writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');

  await writeFile(path.join(dir, 'big.ts'), 'x'.repeat(1024 * 1024 + 1));

  await writeFile(path.join(dir, 'weird.txt'), Buffer.from([0x68, 0x69, 0x00, 0x62, 0x79, 0x65]));

  await symlink(path.join(dir, 'src', 'index.ts'), path.join(dir, 'link.ts'));

  return dir;
}

async function collect(dir: string): Promise<WalkEntry[]> {
  const entries: WalkEntry[] = [];
  for await (const entry of walk(dir)) {
    entries.push(entry);
  }
  return entries;
}

describe('walk', () => {
  it('skips node_modules, .git, lockfiles, minified files, oversized files, binary extensions, NUL-byte content and symlinks', async () => {
    workDir = await setupWorkDir();
    const entries = await collect(workDir);

    const skipped = new Map(
      entries.filter((e): e is Extract<WalkEntry, { type: 'skipped' }> => e.type === 'skipped').map((e) => [e.skip.filePath, e.skip.reason]),
    );
    const candidates = new Set(
      entries
        .filter((e): e is Extract<WalkEntry, { type: 'candidate' }> => e.type === 'candidate')
        .map((e) => e.candidate.filePath),
    );

    expect(skipped.get('node_modules')).toBe('ignored-dir');
    expect(skipped.get('.git')).toBe('ignored-dir');
    expect(skipped.get('package-lock.json')).toBe('lockfile');
    expect(skipped.get('vendor.min.js')).toBe('minified');
    expect(skipped.get('logo.png')).toBe('binary-extension');
    expect(skipped.get('big.ts')).toBe('too-large');
    expect(skipped.get('weird.txt')).toBe('binary-content');
    expect(skipped.get('link.ts')).toBe('symlink');

    expect(candidates.has('node_modules/somepkg/index.js')).toBe(false);
    expect(candidates.has('.git/HEAD')).toBe(false);
    expect(candidates.has('src/index.ts')).toBe(true);
  });

  it('yields correctly classified candidates for routable files', async () => {
    workDir = await setupWorkDir();
    const entries = await collect(workDir);
    const byPath = new Map(
      entries
        .filter((e): e is Extract<WalkEntry, { type: 'candidate' }> => e.type === 'candidate')
        .map((e) => [e.candidate.filePath, e.candidate]),
    );

    expect(byPath.get('src/index.ts')?.language).toBe('typescript');
    expect(byPath.get('scripts/tool.py')?.language).toBe('python');
    expect(byPath.get('data.unknownext')?.language).toBe('unknown');
  });
});
