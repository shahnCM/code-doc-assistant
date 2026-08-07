import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { GenChunk, GenClient, GenError } from '../../generate/llmClient.js';
import type { Db } from '../../index/db.js';
import type { EmbedClient } from '../../index/embedClient.js';
import type { Result } from '../../shared/types.js';
import { createChatHandler, shouldAbortOnClose, type ChatCapableResponse } from './chat.js';

class FakeChatResponse extends EventEmitter implements ChatCapableResponse {
  statusCode: number | undefined;
  headers: Record<string, string> | undefined;
  jsonBody: unknown;
  writes: string[] = [];
  writableFinished = false;
  flushCount = 0;

  get writableEnded(): boolean {
    return this.writableFinished;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  set(headers: Record<string, string>): this {
    this.headers = headers;
    return this;
  }

  json(body: unknown): this {
    this.jsonBody = body;
    return this;
  }

  flushHeaders(): void {
    this.flushCount += 1;
  }

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(): this {
    this.writableFinished = true;
    return this;
  }
}

function fakeDb(rows: Array<Record<string, unknown>> = []): { db: Db; calls: { count: number } } {
  const calls = { count: 0 };
  const db: Db = {
    async query() {
      calls.count += 1;
      return { rows };
    },
  };
  return { db, calls };
}

function fakeEmbedClient(): EmbedClient {
  return {
    async embedBatch(texts) {
      return { ok: true, value: texts.map(() => [0.1, 0.2, 0.3]) };
    },
  };
}

function fakeGenClient(chunks: Array<Result<GenChunk, GenError>>): GenClient {
  return {
    async *stream() {
      for (const item of chunks) {
        yield item;
      }
    },
  };
}

const baseDeps = { connectionString: 'postgres://unused', embedModel: 'gemini-embedding-2', genModel: 'gemini-3.6-flash' };

describe('shouldAbortOnClose', () => {
  it('[34] is false once the response has finished — the guard a naive res.on(close) handler would miss', () => {
    expect(shouldAbortOnClose({ writableFinished: true })).toBe(false);
  });

  it('is true for a response that never finished', () => {
    expect(shouldAbortOnClose({ writableFinished: false })).toBe(true);
  });
});

describe('createChatHandler', () => {
  it('[32][REQ] leaves zero close listeners on res after a normal request completes', async () => {
    const { db } = fakeDb([]);
    const handler = createChatHandler({
      ...baseDeps,
      db,
      embedClient: fakeEmbedClient(),
      genClient: fakeGenClient([]),
    });
    const res = new FakeChatResponse();

    await handler({ body: { messages: [{ role: 'user', content: 'hi' }] } }, res);

    expect(res.listenerCount('close')).toBe(0);
  });

  it('a malformed body is rejected before any retrieval or generation happens', async () => {
    const { db, calls } = fakeDb([]);
    const handler = createChatHandler({
      ...baseDeps,
      db,
      embedClient: fakeEmbedClient(),
      genClient: fakeGenClient([]),
    });
    const res = new FakeChatResponse();

    await handler({ body: { messages: [] } }, res);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody).toBeDefined();
    expect(res.flushCount).toBe(0);
    expect(calls.count).toBe(0);
  });
});
