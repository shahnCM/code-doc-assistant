import { Pool } from 'pg';

export interface Db {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PgDb {
  db: Db;
  end: () => Promise<void>;
}

export function createPgDb(connectionString: string): PgDb {
  const pool = new Pool({ connectionString, max: 10 });
  return {
    db: {
      query: async (text, params) => {
        const result = await pool.query(text, params as unknown[] | undefined);
        return { rows: result.rows };
      },
    },
    end: () => pool.end(),
  };
}
