import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { GenClient } from '../generate/llmClient.js';
import type { Db } from '../index/db.js';
import type { EmbedClient } from '../index/embedClient.js';
import { createChatHandler } from './routes/chat.js';
import { createHealthHandler, createReadyHandler } from './routes/health.js';
import { createSourceHandler } from './routes/source.js';

// npm run build's vite step outputs here — dist/server/app.js sits beside dist/web/ once compiled.
const DEFAULT_WEB_DIST_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../web');

export interface AppDeps {
  db: Db;
  connectionString: string;
  embedModel: string;
  genModel: string;
  embedClient?: EmbedClient;
  genClient?: GenClient;
  onError?: (error: unknown) => void;
  isShuttingDown?: (() => boolean) | undefined;
  webDistDir?: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', createHealthHandler());
  app.get('/ready', createReadyHandler(deps.db, { isShuttingDown: deps.isShuttingDown }));
  app.post('/api/chat', createChatHandler(deps));
  app.get('/api/source', createSourceHandler({ db: deps.db }));

  // Serves the built React client from the same process/port, per BUILD-PLAN's original design
  // ("one container, one port for the grader") — additive only: if no build is present (the
  // common case in local dev, which never runs `npm run build`), this is a no-op and behavior is
  // unchanged from before this existed.
  const webDistDir = deps.webDistDir ?? DEFAULT_WEB_DIST_DIR;
  const webIndexHtml = join(webDistDir, 'index.html');
  if (existsSync(webIndexHtml)) {
    app.use(express.static(webDistDir));
    // Express 5 (path-to-regexp v8) dropped the bare '*' wildcard — '/*splat' is the replacement.
    app.get('/*splat', (_req, res) => res.sendFile(webIndexHtml));
  }

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
