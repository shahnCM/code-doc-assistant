import type { Server } from 'node:http';
import { loadEnv } from '../config.js';
import { createPgDb, type Db, type PgDb } from '../index/db.js';
import type { EmbedClient } from '../index/embedClient.js';
import type { GenClient } from '../generate/llmClient.js';
import { createApp } from './app.js';

type LogFn = (message: string) => void;

export interface ServerOptions {
  env?: NodeJS.ProcessEnv;
  dbFactory?: (connectionString: string) => PgDb;
  embedClient?: EmbedClient;
  genClient?: GenClient;
  log?: LogFn;
  logError?: LogFn;
}

export interface StartedServer {
  server: Server;
  db: Db;
  close: () => Promise<void>;
}

export async function startServer(options: ServerOptions = {}): Promise<StartedServer | undefined> {
  const {
    env = process.env,
    dbFactory = createPgDb,
    embedClient,
    genClient,
    log = console.log,
    logError = console.error,
  } = options;

  const envResult = loadEnv(env);
  if (!envResult.ok) {
    logError(`Config error: ${envResult.error}`);
    return undefined;
  }
  const config = envResult.value;

  const pgDb = dbFactory(config.DATABASE_URL);
  let shuttingDown = false;

  const app = createApp({
    db: pgDb.db,
    connectionString: config.DATABASE_URL,
    embedModel: config.EMBED_MODEL,
    genModel: config.GEN_MODEL,
    ...(embedClient !== undefined ? { embedClient } : {}),
    ...(genClient !== undefined ? { genClient } : {}),
    onError: (error) => logError(`unhandled request error: ${error instanceof Error ? error.message : String(error)}`),
    isShuttingDown: () => shuttingDown,
  });

  const server = app.listen(config.PORT, '0.0.0.0', () => {
    log(`listening on 0.0.0.0:${config.PORT}`);
  });
  // SSE responses can run for the duration of a whole answer; the per-request 30s
  // AbortSignal.timeout inside the chat route is the real deadline, not the socket timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;

  const close = async (): Promise<void> => {
    shuttingDown = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pgDb.end();
  };

  return { server, db: pgDb.db, close };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const started = await startServer();
  if (!started) {
    process.exit(1);
  } else {
    const shutdown = (signal: string): void => {
      console.log(`received ${signal}, draining in-flight connections`);
      void started.close().then(() => {
        console.log('shutdown complete');
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}
