import { readFile } from 'node:fs/promises';
import type { Chunk, IngestReport, Result } from '../shared/types.js';
import { acquireRepo, type AcquireOptions, type GitRunner, realGitRunner } from './acquire.js';
import { type Chunker, registry, selectChunker } from './chunkers/index.js';
import { enrich } from './enrich.js';
import { walk } from './walk.js';

export type PipelineOptions = AcquireOptions;

export interface PipelineResult {
  chunks: Chunk[];
  report: IngestReport;
}

export async function runPipeline(
  repoInput: string,
  options: PipelineOptions = {},
  chunkers: readonly Chunker[] = registry,
  git: GitRunner = realGitRunner,
): Promise<Result<PipelineResult, string>> {
  const acquired = await acquireRepo(repoInput, options, git);
  if (!acquired.ok) {
    return acquired;
  }

  const chunks: Chunk[] = [];
  let filesSeen = 0;
  let chunked = 0;
  let degraded = 0;
  let noDeclarations = 0;
  let failed = 0;
  let skipped = 0;

  for await (const entry of walk(acquired.value.rootDir)) {
    if (entry.type === 'skipped') {
      skipped++;
      continue;
    }

    filesSeen++;
    try {
      const source = await readFile(entry.candidate.absolutePath, 'utf8');
      const chunker = selectChunker(entry.candidate, chunkers);
      if (!chunker) {
        failed++;
        continue;
      }

      const result = chunker.chunk(entry.candidate, source);
      if (!result.ok) {
        failed++;
        continue;
      }

      chunks.push(...result.value.chunks);
      if (result.value.outcome === 'chunked') {
        chunked++;
      } else if (result.value.outcome === 'degraded') {
        degraded++;
      } else {
        noDeclarations++;
      }
    } catch {
      failed++;
    }
  }

  const enrichedChunks = enrich(chunks);

  return {
    ok: true,
    value: {
      chunks: enrichedChunks,
      report: {
        filesSeen,
        chunked,
        degraded,
        noDeclarations,
        failed,
        skipped,
        totalChunks: enrichedChunks.length,
        commitSha: acquired.value.commitSha,
      },
    },
  };
}
