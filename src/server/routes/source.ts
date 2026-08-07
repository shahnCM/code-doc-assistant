import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Db } from '../../index/db.js';
import { fetchSourceRange } from '../../retrieve/source.js';

const SourceQuerySchema = z.object({
  repoSource: z.string().min(1),
  filePath: z.string().min(1),
  startLine: z.coerce.number().int().positive(),
  endLine: z.coerce.number().int().positive(),
});

export interface SourceRouteDeps {
  db: Db;
}

export function createSourceHandler(deps: SourceRouteDeps) {
  return async function sourceHandler(req: Request, res: Response): Promise<void> {
    const parsed = SourceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const range = await fetchSourceRange(deps.db, parsed.data);
    if (range.blocks.length === 0) {
      res.status(404).json({ error: 'no chunks found for the requested file and range' });
      return;
    }

    res.status(200).json(range);
  };
}
