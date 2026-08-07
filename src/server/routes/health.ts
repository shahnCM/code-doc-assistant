import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { Db } from '../../index/db.js';

export function createHealthHandler() {
  return function healthHandler(_req: Request, res: Response): void {
    res.status(200).json({ status: 'ok' });
  };
}

export interface ReadyHandlerOptions {
  isShuttingDown?: (() => boolean) | undefined;
  migrationsDir?: string | undefined;
}

function getExpectedMigrationNames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((file) => /\.(ts|js)$/.test(file))
    .map((file) => file.replace(/\.(ts|js)$/, ''));
}

export function createReadyHandler(db: Db, options: ReadyHandlerOptions = {}) {
  const isShuttingDown = options.isShuttingDown ?? (() => false);
  const migrationsDir = options.migrationsDir ?? path.resolve(process.cwd(), 'migrations');

  return async function readyHandler(_req: Request, res: Response): Promise<void> {
    if (isShuttingDown()) {
      res.status(503).json({ status: 'shutting-down' });
      return;
    }
    try {
      const expected = getExpectedMigrationNames(migrationsDir);
      const applied = await db.query('SELECT name FROM pgmigrations');
      const appliedNames = new Set(applied.rows.map((row) => String(row.name)));
      const pending = expected.filter((name) => !appliedNames.has(name));
      if (pending.length > 0) {
        res.status(503).json({ status: 'not-ready', error: `pending migrations: ${pending.join(', ')}` });
        return;
      }
      res.status(200).json({ status: 'ready' });
    } catch (error) {
      res.status(503).json({ status: 'not-ready', error: error instanceof Error ? error.message : String(error) });
    }
  };
}
