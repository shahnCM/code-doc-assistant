import type { Request, Response } from 'express';
import type { Db } from '../../index/db.js';

export function createHealthHandler() {
  return function healthHandler(_req: Request, res: Response): void {
    res.status(200).json({ status: 'ok' });
  };
}

export function createReadyHandler(db: Db) {
  return async function readyHandler(_req: Request, res: Response): Promise<void> {
    try {
      await db.query('SELECT 1');
      res.status(200).json({ status: 'ready' });
    } catch (error) {
      res.status(503).json({ status: 'not-ready', error: error instanceof Error ? error.message : String(error) });
    }
  };
}
