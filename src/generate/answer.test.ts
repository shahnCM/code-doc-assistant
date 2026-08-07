import { describe, expect, it } from 'vitest';
import { REFUSAL_SENTENCE } from './prompt.js';
import type { Db } from '../index/db.js';
import type { EmbedClient } from '../index/embedClient.js';
import type { GenChunk, GenClient, GenError, GenStreamParams } from './llmClient.js';
import type { ChatEvent, Result } from '../shared/types.js';
import { answerQuestion } from './answer.js';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    repo_source: 'https://github.com/o/r',
    file_path: 'src/add.ts',
    symbol_name: 'add',
    kind: 'function',
    signature: 'function add(a: number, b: number): number',
    start_line: 1,
    end_line: 3,
    language: 'typescript',
    chunker_kind: 'ts-morph',
    content: 'export function add(a, b) { return a + b; }',
    dense_rank: '1',
    lexical_rank: null,
    dense_distance: 0.1,
    lexical_score: null,
    fused_score: 0.5,
    ...overrides,
  };
}

function fakeDb(rows: Array<Record<string, unknown>> = []): {
  db: Db;
  calls: Array<{ text: string; params: readonly unknown[] }>;
} {
  const calls: Array<{ text: string; params: readonly unknown[] }> = [];
  const db: Db = {
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows };
    },
  };
  return { db, calls };
}

function fakeEmbedClient(): { client: EmbedClient; calls: string[][] } {
  const calls: string[][] = [];
  const client: EmbedClient = {
    async embedBatch(texts) {
      calls.push([...texts]);
      return { ok: true, value: texts.map(() => [0.1, 0.2, 0.3]) };
    },
  };
  return { client, calls };
}

function fakeGenClient(chunks: Array<Result<GenChunk, GenError>>): { client: GenClient; calls: GenStreamParams[] } {
  const calls: GenStreamParams[] = [];
  const client: GenClient = {
    async *stream(params) {
      calls.push(params);
      for (const item of chunks) {
        yield item;
      }
    },
  };
  return { client, calls };
}

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

const baseDeps = { connectionString: 'postgres://unused', embedModel: 'gemini-embedding-2', genModel: 'gemini-3.6-flash' };

describe('answerQuestion', () => {
  it('[20][REQ] empty retrieval fires the refusal path with zero LLM calls', async () => {
    const { db } = fakeDb([]);
    const { client: embedClient } = fakeEmbedClient();
    const { client: genClient, calls: genCalls } = fakeGenClient([]);

    const events = await collect(
      answerQuestion(
        { messages: [{ role: 'user', content: 'what does this do' }] },
        { ...baseDeps, db, embedClient, genClient },
      ),
    );

    expect(genCalls).toHaveLength(0);
    const tokenText = events
      .filter((e) => e.type === 'token')
      .map((e) => e.text)
      .join('');
    expect(tokenText).toContain(REFUSAL_SENTENCE);
  });

  it('[21] emits events in order: trace, one or more token, citations, done', async () => {
    const { db } = fakeDb([row()]);
    const { client: embedClient } = fakeEmbedClient();
    const { client: genClient } = fakeGenClient([
      { ok: true, value: { text: 'It adds two numbers ', finishReason: null } },
      { ok: true, value: { text: '(src/add.ts:1-3).', finishReason: 'STOP' } },
    ]);

    const events = await collect(
      answerQuestion(
        { messages: [{ role: 'user', content: 'what does add do' }] },
        { ...baseDeps, db, embedClient, genClient },
      ),
    );

    expect(events[0]?.type).toBe('trace');
    expect(events.at(-1)?.type).toBe('done');
    const citationsIndex = events.findIndex((e) => e.type === 'citations');
    expect(citationsIndex).toBeGreaterThan(0);
    expect(citationsIndex).toBe(events.length - 2);
    const between = events.slice(1, citationsIndex);
    expect(between.length).toBeGreaterThan(0);
    expect(between.every((e) => e.type === 'token')).toBe(true);
  });

  it('[22] the trace carries fusedScore, denseRank, lexicalRank, language, chunkerKind and included for every retrieved chunk, including ones dedupe dropped', async () => {
    const winner = row({ id: 1, symbol_name: 'winner', fused_score: 0.9 });
    const loser = row({ id: 2, symbol_name: 'loser', fused_score: 0.1 });
    const { db } = fakeDb([winner, loser]);
    const { client: embedClient } = fakeEmbedClient();
    const { client: genClient } = fakeGenClient([{ ok: true, value: { text: 'answer', finishReason: 'STOP' } }]);

    const events = await collect(
      answerQuestion(
        { messages: [{ role: 'user', content: 'question' }] },
        { ...baseDeps, db, embedClient, genClient },
      ),
    );

    const trace = events[0];
    if (trace?.type !== 'trace') throw new Error('expected a trace event first');
    expect(trace.chunks).toHaveLength(2);
    const winnerTrace = trace.chunks.find((c) => c.id === 1);
    const loserTrace = trace.chunks.find((c) => c.id === 2);
    expect(winnerTrace).toMatchObject({
      fusedScore: 0.9,
      denseRank: 1,
      lexicalRank: null,
      language: 'typescript',
      chunkerKind: 'ts-morph',
      included: true,
    });
    expect(loserTrace).toMatchObject({ fusedScore: 0.1, included: false });
  });

  it('[23][REQ] abort propagates to the mocked LLM client, and a cancelled event carries elapsedMs and estimatedTokensNotGenerated', async () => {
    const { db } = fakeDb([row()]);
    const { client: embedClient } = fakeEmbedClient();
    const controller = new AbortController();
    const genClient: GenClient = {
      async *stream(params) {
        yield { ok: true, value: { text: 'partial', finishReason: null } };
        controller.abort();
        expect(params.abortSignal?.aborted).toBe(true);
        yield { ok: false, error: { kind: 'aborted', message: 'aborted mid-stream' } };
      },
    };

    const events = await collect(
      answerQuestion(
        { messages: [{ role: 'user', content: 'question' }], signal: controller.signal },
        { ...baseDeps, db, embedClient, genClient },
      ),
    );

    const cancelled = events.find((e) => e.type === 'cancelled');
    expect(cancelled).toBeDefined();
    if (cancelled?.type !== 'cancelled') throw new Error('expected a cancelled event');
    expect(typeof cancelled.elapsedMs).toBe('number');
    expect(typeof cancelled.estimatedTokensNotGenerated).toBe('number');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('[24][REQ] an already-aborted request issues zero SQL', async () => {
    const controller = new AbortController();
    controller.abort();
    const { db, calls: dbCalls } = fakeDb([row()]);
    const { client: embedClient } = fakeEmbedClient();
    const { client: genClient, calls: genCalls } = fakeGenClient([]);

    const events = await collect(
      answerQuestion(
        { messages: [{ role: 'user', content: 'question' }], signal: controller.signal },
        { ...baseDeps, db, embedClient, genClient },
      ),
    );

    expect(dbCalls).toHaveLength(0);
    expect(genCalls).toHaveLength(0);
    expect(events.some((e) => e.type === 'cancelled')).toBe(true);
  });
});
