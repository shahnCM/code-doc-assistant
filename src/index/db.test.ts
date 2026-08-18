import { describe, expect, it } from 'vitest';
import type { Result } from '../shared/types.js';
import { createDb, type TxClient, type TxPool } from './db.js';

function fakePool(options: { throwOn?: string; connectFails?: string } = {}) {
  const poolCalls: string[] = [];
  const clientCalls: string[] = [];
  let connects = 0;
  let releases = 0;

  const pool: TxPool = {
    async query(text: string) {
      poolCalls.push(text);
      return { rows: [] };
    },
    async connect(): Promise<TxClient> {
      if (options.connectFails) throw new Error(options.connectFails);
      connects += 1;
      return {
        async query(text: string) {
          clientCalls.push(text);
          if (options.throwOn && text === options.throwOn) throw new Error(`failed: ${text}`);
          return { rows: [] };
        },
        release() {
          releases += 1;
        },
      };
    },
  };

  return {
    pool,
    poolCalls,
    clientCalls,
    connects: () => connects,
    releases: () => releases,
  };
}

describe('createDb', () => {
  it('[REQ] queries outside a transaction go to the pool, not to a dedicated client', async () => {
    const { pool, poolCalls, clientCalls, connects } = fakePool();

    await createDb(pool).query('SELECT 1');

    expect(poolCalls).toEqual(['SELECT 1']);
    expect(clientCalls).toEqual([]);
    expect(connects()).toBe(0);
  });
});

describe('withTransaction', () => {
  it('[REQ] commits when the callback succeeds, and every statement lands on one dedicated client', async () => {
    const { pool, poolCalls, clientCalls, connects, releases } = fakePool();

    const result = await createDb(pool).withTransaction(async (tx) => {
      await tx.query('DELETE FROM chunks WHERE repo_source = $1', ['r']);
      await tx.query('INSERT INTO chunks (id) VALUES ($1)', [1]);
      return { ok: true, value: 2 };
    });

    expect(result).toEqual({ ok: true, value: 2 });
    expect(clientCalls).toEqual([
      'BEGIN',
      'DELETE FROM chunks WHERE repo_source = $1',
      'INSERT INTO chunks (id) VALUES ($1)',
      'COMMIT',
    ]);
    expect(poolCalls).toEqual([]);
    expect(connects()).toBe(1);
    expect(releases()).toBe(1);
  });

  it('[REQ] rolls back when the callback returns ok:false, and passes that error through unchanged', async () => {
    const { pool, clientCalls, releases } = fakePool();

    const result = await createDb(pool).withTransaction(async (tx) => {
      await tx.query('DELETE FROM chunks WHERE repo_source = $1', ['r']);
      return { ok: false, error: 'embedding rejected' };
    });

    expect(result).toEqual({ ok: false, error: 'embedding rejected' });
    expect(clientCalls).toEqual(['BEGIN', 'DELETE FROM chunks WHERE repo_source = $1', 'ROLLBACK']);
    expect(releases()).toBe(1);
  });

  it('[REQ] rolls back when the callback throws, and converts the throw to ok:false', async () => {
    const { pool, clientCalls, releases } = fakePool();

    const result = await createDb(pool).withTransaction(
      async (tx): Promise<Result<number, string>> => {
        await tx.query('DELETE FROM chunks WHERE repo_source = $1', ['r']);
        throw new Error('duplicate key value violates unique constraint');
      },
    );

    expect(result).toEqual({
      ok: false,
      error: 'duplicate key value violates unique constraint',
    });
    expect(clientCalls).toEqual(['BEGIN', 'DELETE FROM chunks WHERE repo_source = $1', 'ROLLBACK']);
    expect(releases()).toBe(1);
  });

  it('[REQ] releases the client and reports the original error when ROLLBACK itself throws', async () => {
    const { pool, clientCalls, releases } = fakePool({ throwOn: 'ROLLBACK' });

    const result = await createDb(pool).withTransaction(
      async (): Promise<Result<number, string>> => {
        throw new Error('original failure');
      },
    );

    expect(result).toEqual({ ok: false, error: 'original failure' });
    expect(clientCalls).toEqual(['BEGIN', 'ROLLBACK']);
    expect(releases()).toBe(1);
  });

  it('releases the client when COMMIT throws, and reports the commit failure', async () => {
    const { pool, releases } = fakePool({ throwOn: 'COMMIT' });

    const result = await createDb(pool).withTransaction(async () => ({ ok: true, value: 1 }));

    expect(result).toEqual({ ok: false, error: 'failed: COMMIT' });
    expect(releases()).toBe(1);
  });

  it('returns ok:false without releasing anything when the pool cannot hand out a connection', async () => {
    const { pool, releases } = fakePool({ connectFails: 'sorry, too many clients already' });

    const result = await createDb(pool).withTransaction(async () => ({ ok: true, value: 1 }));

    expect(result).toEqual({ ok: false, error: 'sorry, too many clients already' });
    expect(releases()).toBe(0);
  });

  it('[REQ] a nested withTransaction runs inline — one BEGIN, one COMMIT, one connection', async () => {
    const { pool, clientCalls, connects, releases } = fakePool();

    const result = await createDb(pool).withTransaction(async (tx) =>
      tx.withTransaction(async (inner) => {
        await inner.query('SELECT 1');
        return { ok: true, value: 'inner' };
      }),
    );

    expect(result).toEqual({ ok: true, value: 'inner' });
    expect(clientCalls).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(connects()).toBe(1);
    expect(releases()).toBe(1);
  });
});
