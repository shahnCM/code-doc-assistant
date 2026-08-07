import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { PgDb } from '../index/db.js';
import { startServer } from './index.js';

const validEnv = {
  DATABASE_URL: 'postgres://admin:admin@postgres-16:5432/codedocs',
  GEMINI_API_KEY: 'test-key',
  EMBED_MODEL: 'gemini-embedding-2',
  GEN_MODEL: 'gemini-3.6-flash',
  PORT: '58234',
};

function fakeDbFactory(): { dbFactory: (connectionString: string) => PgDb; endCalls: { count: number } } {
  const endCalls = { count: 0 };
  const dbFactory = (): PgDb => ({
    db: { async query() { return { rows: [] }; } },
    end: async () => {
      endCalls.count += 1;
    },
  });
  return { dbFactory, endCalls };
}

describe('startServer', () => {
  it('returns undefined and logs without listening when the environment is invalid', async () => {
    const errors: string[] = [];
    const started = await startServer({ env: {}, logError: (message) => errors.push(message) });

    expect(started).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('[37] binds 0.0.0.0 using the real bootstrap path, and close() tears down the server and the pool', async () => {
    const { dbFactory, endCalls } = fakeDbFactory();
    const started = await startServer({ env: validEnv, dbFactory, log: () => {}, logError: () => {} });

    expect(started).toBeDefined();
    if (!started) return;

    if (!started.server.listening) {
      await new Promise<void>((resolve) => started.server.once('listening', resolve));
    }
    const address = started.server.address() as AddressInfo;
    expect(address.address).toBe('0.0.0.0');

    await started.close();
    expect(endCalls.count).toBe(1);
  });
});
