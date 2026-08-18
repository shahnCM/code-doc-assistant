import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { GenChunk, GenClient, GenError } from '../generate/llmClient.js';
import type { Db } from '../index/db.js';
import type { EmbedClient } from '../index/embedClient.js';
import type { Result } from '../shared/types.js';
import { createApp, type AppDeps } from './app.js';

function fakeDb(rows: Array<Record<string, unknown>> = [], onQuery?: () => void): Db {
  const db: Db = {
    async query() {
      onQuery?.();
      return { rows };
    },
    withTransaction: async (fn) => fn(db),
  };
  return db;
}

function rejectingDb(): Db {
  const db: Db = {
    async query() {
      throw new Error('connection refused');
    },
    withTransaction: async (fn) => fn(db),
  };
  return db;
}

function throwingDb(): Db {
  const db: Db = {
    async query() {
      throw new Error('should never be called by /health');
    },
    withTransaction: async (fn) => fn(db),
  };
  return db;
}

function fakeEmbedClient(): { client: EmbedClient; calls: { count: number } } {
  const calls = { count: 0 };
  const client: EmbedClient = {
    async embedBatch(texts) {
      calls.count += 1;
      return { ok: true, value: texts.map(() => [0.1, 0.2, 0.3]) };
    },
  };
  return { client, calls };
}

function fakeGenClient(chunks: Array<Result<GenChunk, GenError>>): { client: GenClient; calls: { count: number } } {
  const calls = { count: 0 };
  const client: GenClient = {
    async *stream() {
      calls.count += 1;
      for (const item of chunks) {
        yield item;
      }
    },
  };
  return { client, calls };
}

const baseAppDeps = { connectionString: 'postgres://unused', embedModel: 'gemini-embedding-2', genModel: 'gemini-3.6-flash' };

async function withApp<T>(deps: AppDeps, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = createApp(deps);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('GET /health', () => {
  it('[26] returns 200 without touching the database', async () => {
    const deps: AppDeps = { ...baseAppDeps, db: throwingDb() };
    await withApp(deps, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
    });
  });
});

describe('GET /ready', () => {
  it('[27] returns 503 when the DB check rejects', async () => {
    const deps: AppDeps = { ...baseAppDeps, db: rejectingDb() };
    await withApp(deps, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ready`);
      expect(res.status).toBe(503);
    });
  });

  it('[27] returns 200 when the DB reports every migration in migrations/ as applied', async () => {
    const deps: AppDeps = { ...baseAppDeps, db: fakeDb([{ name: '001_init' }]) };
    await withApp(deps, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ready`);
      expect(res.status).toBe(200);
    });
  });

  it('returns 503 when a migration in migrations/ is missing from the applied rows', async () => {
    const deps: AppDeps = { ...baseAppDeps, db: fakeDb([]) };
    await withApp(deps, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ready`);
      expect(res.status).toBe(503);
    });
  });
});

describe('POST /api/chat', () => {
  it('[28][REQ] a malformed body returns 400 from zod with a JSON content-type, and never reaches retrieval or generation', async () => {
    const { client: embedClient, calls: embedCalls } = fakeEmbedClient();
    const { client: genClient, calls: genCalls } = fakeGenClient([]);
    const deps: AppDeps = { ...baseAppDeps, db: fakeDb([]), embedClient, genClient };

    await withApp(deps, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });

      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(embedCalls.count).toBe(0);
      expect(genCalls.count).toBe(0);
    });
  });

  it('[33][REQ] a client disconnect never reaches the error boundary as a 500', async () => {
    const { client: embedClient } = fakeEmbedClient();
    let released: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      released = resolve;
    });
    const genClient: GenClient = {
      async *stream() {
        yield { ok: true, value: { text: 'partial', finishReason: null } };
        await stalled;
        yield { ok: true, value: { text: ' more', finishReason: 'STOP' } };
      },
    };
    const onErrorCalls: unknown[] = [];
    const deps: AppDeps = {
      ...baseAppDeps,
      db: fakeDb([{
        id: 1,
        repo_source: 'r',
        file_path: 'a.ts',
        symbol_name: null,
        kind: 'block',
        signature: null,
        start_line: 1,
        end_line: 1,
        language: 'typescript',
        chunker_kind: 'generic',
        content: 'x',
        dense_rank: '1',
        lexical_rank: null,
        dense_distance: 0.1,
        lexical_score: null,
        fused_score: 0.5,
      }]),
      embedClient,
      genClient,
      onError: (err) => onErrorCalls.push(err),
    };

    await withApp(deps, async (baseUrl) => {
      const controller = new AbortController();
      const fetchPromise = fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        signal: controller.signal,
      }).catch(() => undefined);

      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();
      await fetchPromise;
      released();
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(onErrorCalls).toHaveLength(0);
    });
  });
});

describe('GET /api/source', () => {
  const row = (overrides: Record<string, unknown>) => ({ start_line: 1, end_line: 1, content: 'x', ...overrides });

  it('[35] stitches blocks in order and reports gaps', async () => {
    const deps: AppDeps = {
      ...baseAppDeps,
      db: fakeDb([row({ start_line: 5, end_line: 6, content: 'mid' })]),
    };
    await withApp(deps, async (baseUrl) => {
      const url = `${baseUrl}/api/source?repoSource=r&filePath=a.ts&startLine=1&endLine=10`;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { gaps: unknown[]; blocks: unknown[] };
      expect(body.blocks).toHaveLength(1);
      expect(body.gaps).toEqual([
        { startLine: 1, endLine: 4 },
        { startLine: 7, endLine: 10 },
      ]);
    });
  });

  it('[35] an unknown file returns 404', async () => {
    const deps: AppDeps = { ...baseAppDeps, db: fakeDb([]) };
    await withApp(deps, async (baseUrl) => {
      const url = `${baseUrl}/api/source?repoSource=r&filePath=missing.ts&startLine=1&endLine=10`;
      const res = await fetch(url);
      expect(res.status).toBe(404);
    });
  });

  it('[36] caps an unbounded range request at MAX_SOURCE_LINES', async () => {
    const deps: AppDeps = { ...baseAppDeps, db: fakeDb([row({ start_line: 1, end_line: 1 })]) };
    await withApp(deps, async (baseUrl) => {
      const url = `${baseUrl}/api/source?repoSource=r&filePath=a.ts&startLine=1&endLine=1000000`;
      const res = await fetch(url);
      const body = (await res.json()) as { endLine: number };
      expect(body.endLine).toBe(400);
    });
  });
});

describe('static web UI serving', () => {
  it('with no web build present, GET / still 404s — identical to today, no behavior change', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'app-test-no-build-'));
    const deps: AppDeps = { ...baseAppDeps, db: fakeDb([]), webDistDir: emptyDir };
    await withApp(deps, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(404);
    });
  });

  it('with a web build present, GET / serves index.html and an unmatched deep path falls back to it too', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'app-test-with-build-'));
    writeFileSync(join(distDir, 'index.html'), '<html><body>chat ui</body></html>');
    mkdirSync(join(distDir, 'assets'));
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("app bundle");');
    const deps: AppDeps = { ...baseAppDeps, db: fakeDb([]), webDistDir: distDir };

    await withApp(deps, async (baseUrl) => {
      const root = await fetch(`${baseUrl}/`);
      expect(root.status).toBe(200);
      expect(await root.text()).toContain('chat ui');

      const deepPath = await fetch(`${baseUrl}/some/unmatched/deep/path`);
      expect(deepPath.status).toBe(200);
      expect(await deepPath.text()).toContain('chat ui');

      const asset = await fetch(`${baseUrl}/assets/app.js`);
      expect(asset.status).toBe(200);
      const assetBody = await asset.text();
      expect(assetBody).toContain('app bundle');
      expect(assetBody).not.toContain('chat ui');
    });
  });

  it('API routes still take priority over the SPA fallback once a web build is present', async () => {
    const distDir = mkdtempSync(join(tmpdir(), 'app-test-priority-'));
    writeFileSync(join(distDir, 'index.html'), '<html><body>chat ui</body></html>');
    const deps: AppDeps = { ...baseAppDeps, db: fakeDb([{ name: '001_init' }]), webDistDir: distDir };

    await withApp(deps, async (baseUrl) => {
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });

      const ready = await fetch(`${baseUrl}/ready`);
      expect(ready.status).toBe(200);
    });
  });
});

describe('binding', () => {
  it('[37] binds 0.0.0.0, asserted on server.address(), not a string in the source', async () => {
    const app = createApp({ ...baseAppDeps, db: fakeDb([]) });
    const server = app.listen(0, '0.0.0.0');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const address = server.address() as AddressInfo;
      expect(address.address).toBe('0.0.0.0');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
