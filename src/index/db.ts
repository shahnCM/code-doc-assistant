import { Pool } from 'pg';
import type { Result } from '../shared/types.js';

export interface Db {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  withTransaction<T, E>(fn: (tx: Db) => Promise<Result<T, E>>): Promise<Result<T, E | string>>;
}

export interface TxClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}

export interface TxPool {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  connect(): Promise<TxClient>;
}

export interface PgDb {
  db: Db;
  end: () => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rollbackQuietly(client: TxClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // A connection that died mid-transaction cannot roll back, and the server has already
    // discarded the transaction. Swallowing here keeps the caller's original error the one
    // that gets reported.
  }
}

export function createDb(pool: TxPool): Db {
  return {
    query: (text, params) => pool.query(text, params),

    async withTransaction(fn) {
      let client: TxClient;
      try {
        client = await pool.connect();
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }

      // Postgres has no true nested transactions, and a second BEGIN on the same connection is a
      // warning, not a transaction. Nested calls run inline against the same client.
      const tx: Db = {
        query: (text, params) => client.query(text, params),
        withTransaction: (nested) => nested(tx),
      };

      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        if (!result.ok) {
          await rollbackQuietly(client);
          return result;
        }
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await rollbackQuietly(client);
        return { ok: false, error: messageOf(error) };
      } finally {
        client.release();
      }
    },
  };
}

export function createPgDb(connectionString: string): PgDb {
  const pool = new Pool({ connectionString, max: 10 });
  const txPool: TxPool = {
    query: async (text, params) => {
      const result = await pool.query(text, params as unknown[] | undefined);
      return { rows: result.rows };
    },
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text, params) => {
          const result = await client.query(text, params as unknown[] | undefined);
          return { rows: result.rows };
        },
        release: () => client.release(),
      };
    },
  };
  return { db: createDb(txPool), end: () => pool.end() };
}

export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
