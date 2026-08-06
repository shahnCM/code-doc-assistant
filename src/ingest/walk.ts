import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Candidate, SkipReason } from '../shared/types.js';
import { classify } from './classify.js';

const SKIP_DIRS = new Set(['node_modules', '.git']);

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
]);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.wasm',
]);

const MAX_FILE_BYTES = 1024 * 1024;
const NUL_PROBE_BYTES = 8192;

export interface WalkSkip {
  filePath: string;
  reason: SkipReason;
}

export type WalkEntry = { type: 'candidate'; candidate: Candidate } | { type: 'skipped'; skip: WalkSkip };

export async function* walk(rootDir: string): AsyncGenerator<WalkEntry> {
  yield* walkDir(rootDir, rootDir);
}

async function* walkDir(rootDir: string, dir: string): AsyncGenerator<WalkEntry> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    const filePath = path.relative(rootDir, absolutePath).split(path.sep).join('/');

    if (entry.isSymbolicLink()) {
      yield { type: 'skipped', skip: { filePath, reason: 'symlink' } };
      continue;
    }

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        yield { type: 'skipped', skip: { filePath, reason: 'ignored-dir' } };
        continue;
      }
      yield* walkDir(rootDir, absolutePath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (LOCKFILES.has(entry.name)) {
      yield { type: 'skipped', skip: { filePath, reason: 'lockfile' } };
      continue;
    }

    if (entry.name.endsWith('.min.js')) {
      yield { type: 'skipped', skip: { filePath, reason: 'minified' } };
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (BINARY_EXTENSIONS.has(extension)) {
      yield { type: 'skipped', skip: { filePath, reason: 'binary-extension' } };
      continue;
    }

    const stats = await stat(absolutePath);
    if (stats.size > MAX_FILE_BYTES) {
      yield { type: 'skipped', skip: { filePath, reason: 'too-large' } };
      continue;
    }

    if (await hasNulByte(absolutePath)) {
      yield { type: 'skipped', skip: { filePath, reason: 'binary-content' } };
      continue;
    }

    const { language } = classify(filePath);
    yield { type: 'candidate', candidate: { filePath, absolutePath, extension, language } };
  }
}

async function hasNulByte(absolutePath: string): Promise<boolean> {
  const handle = await open(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(NUL_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}
