import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface CachedEmbedding {
  model: string;
  vector: number[];
}

export interface EmbedCache {
  get(hash: string, model: string): Promise<number[] | null>;
  set(hash: string, model: string, vector: readonly number[]): Promise<void>;
}

function isCachedEmbedding(value: unknown): value is CachedEmbedding {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['model'] === 'string' && Array.isArray(record['vector']);
}

export function createFileEmbedCache(dir: string): EmbedCache {
  function entryPath(hash: string): string {
    return path.join(dir, `${hash}.json`);
  }

  return {
    async get(hash, model) {
      let raw: string;
      try {
        raw = await readFile(entryPath(hash), 'utf8');
      } catch {
        return null;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isCachedEmbedding(parsed) || parsed.model !== model) return null;
      return parsed.vector;
    },

    async set(hash, model, vector) {
      await mkdir(dir, { recursive: true });
      const entry: CachedEmbedding = { model, vector: [...vector] };
      const target = entryPath(hash);
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(entry));
      await rename(tmp, target);
    },
  };
}
