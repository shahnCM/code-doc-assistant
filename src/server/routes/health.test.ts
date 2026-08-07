import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../index/db.js';
import { createReadyHandler } from './health.js';

const FIXTURE_MIGRATIONS_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../tests/fixtures/migrations',
);

function fakeResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function fakeDb(query: Db['query']): Db {
  return { query };
}

describe('createReadyHandler', () => {
  it('[REQ] short-circuits to 503 shutting-down without touching the db when isShuttingDown() is true', async () => {
    const query = vi.fn();
    const handler = createReadyHandler(fakeDb(query), {
      isShuttingDown: () => true,
      migrationsDir: FIXTURE_MIGRATIONS_DIR,
    });
    const res = fakeResponse();

    await handler({} as never, res as never);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ status: 'shutting-down' });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 503 not-ready when the db query rejects (unreachable / table missing)', async () => {
    const query = vi.fn().mockRejectedValue(new Error('relation "pgmigrations" does not exist'));
    const handler = createReadyHandler(fakeDb(query), { migrationsDir: FIXTURE_MIGRATIONS_DIR });
    const res = fakeResponse();

    await handler({} as never, res as never);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ status: 'not-ready' });
  });

  it('[REQ] returns 503 not-ready naming the pending migration when one of the fixture\'s two expected migrations is unapplied', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: '001_init' }] });
    const handler = createReadyHandler(fakeDb(query), { migrationsDir: FIXTURE_MIGRATIONS_DIR });
    const res = fakeResponse();

    await handler({} as never, res as never);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ status: 'not-ready' });
    expect((res.body as { error: string }).error).toContain('002_fake');
  });

  it('returns 200 ready when the db reports both fixture migrations applied', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: '001_init' }, { name: '002_fake' }] });
    const handler = createReadyHandler(fakeDb(query), { migrationsDir: FIXTURE_MIGRATIONS_DIR });
    const res = fakeResponse();

    await handler({} as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });
});
