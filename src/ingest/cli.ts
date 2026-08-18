import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadEnv } from '../config.js';
import type { EmbedCache } from '../index/cache.js';
import type { Db } from '../index/db.js';
import { indexChunks } from '../index/embed.js';
import type { EmbedClient } from '../index/embedClient.js';
import type { GitRunner } from './acquire.js';
import { runPipeline } from './pipeline.js';

type WriteFileFn = (path: string, data: string) => Promise<void>;
type LogFn = (message: string) => void;

export interface CliOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  git?: GitRunner;
  embedClient?: EmbedClient;
  cache?: EmbedCache;
  db?: Db;
  writeFile?: WriteFileFn;
  log?: LogFn;
  logError?: LogFn;
}

export async function main(options: CliOptions = {}): Promise<number> {
  const {
    argv = process.argv,
    env = process.env,
    git,
    embedClient,
    cache,
    db,
    writeFile: writeFileFn = writeFile,
    log = console.log,
    logError = console.error,
  } = options;

  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      repo: { type: 'string' },
      refresh: { type: 'boolean', default: false },
      out: { type: 'string', default: 'chunks.json' },
    },
  });

  if (!values.repo) {
    logError('Usage: npm run ingest -- --repo <local-path-or-github-url> [--refresh] [--out chunks.json]');
    return 1;
  }

  const pipelineResult = await runPipeline(values.repo, { refresh: values.refresh }, undefined, git);
  if (!pipelineResult.ok) {
    logError(`Ingest failed: ${pipelineResult.error}`);
    return 1;
  }

  const { chunks, report } = pipelineResult.value;
  await writeFileFn(values.out, JSON.stringify(chunks, null, 2));

  log(`Files seen:      ${report.filesSeen}`);
  log(`Chunked:         ${report.chunked}`);
  log(`Degraded:        ${report.degraded}`);
  log(`No declarations: ${report.noDeclarations}`);
  log(`Failed:          ${report.failed}`);
  log(`Skipped:         ${report.skipped}`);
  log(`Total chunks:    ${report.totalChunks}`);
  log(`Commit SHA:      ${report.commitSha ?? '(none)'}`);
  log(`Wrote ${values.out}`);

  const envResult = loadEnv(env);
  if (!envResult.ok) {
    logError(`Config error: ${envResult.error}`);
    return 1;
  }

  const indexResult = await indexChunks(chunks, values.repo, envResult.value.DATABASE_URL, envResult.value.EMBED_MODEL, {
    ...(embedClient !== undefined ? { embedClient } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(db !== undefined ? { db } : {}),
  });
  if (!indexResult.ok) {
    logError(`Indexing failed: ${indexResult.error}`);
    return 1;
  }

  log(`Unique hashes:   ${indexResult.value.uniqueHashes}`);
  log(`Cache hits:      ${indexResult.value.cacheHits}`);
  log(`Embedded:        ${indexResult.value.embedded}`);
  log(`Deleted:         ${indexResult.value.deleted}`);
  log(`Inserted:        ${indexResult.value.inserted}`);

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main();
  process.exit(code);
}
