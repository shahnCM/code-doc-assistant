import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { GenClient } from '../generate/llmClient.js';
import type { Db } from '../index/db.js';
import type { EmbedClient } from '../index/embedClient.js';
import { createChatHandler } from './routes/chat.js';
import { createHealthHandler, createReadyHandler } from './routes/health.js';
import { createSourceHandler } from './routes/source.js';

export interface AppDeps {
  db: Db;
  connectionString: string;
  embedModel: string;
  genModel: string;
  embedClient?: EmbedClient;
  genClient?: GenClient;
  onError?: (error: unknown) => void;
  isShuttingDown?: (() => boolean) | undefined;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', createHealthHandler());
  app.get('/ready', createReadyHandler(deps.db, { isShuttingDown: deps.isShuttingDown }));
  app.post('/api/chat', createChatHandler(deps));
  app.get('/api/source', createSourceHandler({ db: deps.db }));

  // Single error boundary. AbortError never reaches here — the chat route classifies and
  // swallows it before the rejection can propagate this far.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    deps.onError?.(err);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });

  return app;
}
