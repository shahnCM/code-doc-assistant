import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitRunner } from './acquire.js';
import type { Chunker } from './chunkers/index.js';
import { runPipeline } from './pipeline.js';
import type { Candidate, Chunk, ChunkError, ChunkerOutput, Result } from '../shared/types.js';

let workDir: string | undefined;

afterEach(async () => {
  if (workDir) {
    await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

const noopGit: GitRunner = {
  async clone() {},
  async fetchAndReset() {},
  async revParseHead() {
    return null;
  },
};

function fakeChunk(candidate: Candidate, content: string): Chunk {
  return {
    filePath: candidate.filePath,
    symbolName: null,
    kind: 'block',
    signature: null,
    jsDoc: null,
    startLine: 1,
    endLine: 1,
    parentSymbol: null,
    isExported: false,
    contentHash: '',
    language: candidate.language,
    chunkerKind: 'fake',
    partIndex: 1,
    partTotal: 1,
    content,
    embedText: '',
  };
}

function outcomeFakeChunker(): Chunker {
  return {
    name: 'fake',
    chunkerKind: 'fake',
    supports() {
      return true;
    },
    chunk(candidate): Result<ChunkerOutput, ChunkError> {
      if (candidate.filePath === 'fail.ts') {
        return { ok: false, error: { filePath: candidate.filePath, reason: 'simulated failure' } };
      }
      if (candidate.filePath === 'broken.ts') {
        return { ok: true, value: { chunks: [fakeChunk(candidate, 'x')], outcome: 'degraded' } };
      }
      if (candidate.filePath === 'empty.ts') {
        return { ok: true, value: { chunks: [fakeChunk(candidate, 'x')], outcome: 'no-declarations' } };
      }
      return { ok: true, value: { chunks: [fakeChunk(candidate, 'x')], outcome: 'chunked' } };
    },
  };
}

describe('runPipeline — failure isolation and reporting', () => {
  it('[REQ] one failing file does not abort the run; failed/degraded/no-declarations are distinct and filesSeen reconciles', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pipeline-test-'));
    await writeFile(path.join(workDir, 'good.ts'), 'anything\n');
    await writeFile(path.join(workDir, 'broken.ts'), 'anything\n');
    await writeFile(path.join(workDir, 'empty.ts'), 'anything\n');
    await writeFile(path.join(workDir, 'fail.ts'), 'anything\n');

    const result = await runPipeline(workDir, {}, [outcomeFakeChunker()], noopGit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { report } = result.value;
    expect(report.filesSeen).toBe(4);
    expect(report.chunked).toBe(1);
    expect(report.degraded).toBe(1);
    expect(report.noDeclarations).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.filesSeen).toBe(report.chunked + report.degraded + report.noDeclarations + report.failed);
  });
});

describe('runPipeline — parser-agnostic', () => {
  it('[REQ] a fake chunker drives a full run end-to-end, producing enriched, hashed chunks', async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'pipeline-test-'));
    await writeFile(path.join(workDir, 'a.txt'), 'hello world\n');

    const fake: Chunker = {
      name: 'fake',
      chunkerKind: 'fake',
      supports() {
        return true;
      },
      chunk(candidate, source): Result<ChunkerOutput, ChunkError> {
        return { ok: true, value: { chunks: [fakeChunk(candidate, source)], outcome: 'chunked' } };
      },
    };

    const result = await runPipeline(workDir, {}, [fake], noopGit);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.chunks.length).toBe(1);
    const chunk = result.value.chunks[0];
    expect(chunk?.chunkerKind).toBe('fake');
    expect(chunk?.content).toBe('hello world\n');
    expect(chunk?.embedText.length).toBeGreaterThan(0);
    expect(chunk?.embedText).toContain(chunk?.content ?? '');
    expect(chunk?.contentHash.length).toBeGreaterThan(0);
    expect(result.value.report.chunked).toBe(1);
    expect(result.value.report.totalChunks).toBe(1);
  });
});
