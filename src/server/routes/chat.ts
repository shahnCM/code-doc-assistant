import { z } from 'zod';
import { answerQuestion } from '../../generate/answer.js';
import type { GenClient } from '../../generate/llmClient.js';
import type { Db } from '../../index/db.js';
import type { EmbedClient } from '../../index/embedClient.js';
import { openSse, type SseCapableResponse } from '../sse.js';

const REQUEST_TIMEOUT_MS = 30_000;

const ChatRequestSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1) }))
    .min(1),
  repoSource: z.string().min(1).optional(),
  topK: z.number().int().positive().optional(),
});

export interface ChatCapableRequest {
  body: unknown;
}

export interface ChatCapableResponse extends SseCapableResponse {
  writableFinished: boolean;
  json(body: unknown): unknown;
  on(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
}

export interface ChatRouteDeps {
  db: Db;
  connectionString: string;
  embedModel: string;
  genModel: string;
  embedClient?: EmbedClient;
  genClient?: GenClient;
}

// res.on('close') fires on a clean finish too, not just a client disconnect — a naive
// `() => controller.abort()` would cancel every successful request. Only a response that
// never actually finished represents a real disconnect (CLAUDE.md).
export function shouldAbortOnClose(res: { writableFinished: boolean }): boolean {
  return !res.writableFinished;
}

export function createChatHandler(deps: ChatRouteDeps) {
  return async function chatHandler(req: ChatCapableRequest, res: ChatCapableResponse): Promise<void> {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400);
      res.json({ error: parsed.error.message });
      return;
    }

    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

    const onClose = (): void => {
      if (shouldAbortOnClose(res)) controller.abort();
    };
    res.on('close', onClose);

    const sse = openSse(res);

    try {
      for await (const event of answerQuestion(
        {
          messages: parsed.data.messages,
          signal,
          ...(parsed.data.repoSource !== undefined ? { repoSource: parsed.data.repoSource } : {}),
          ...(parsed.data.topK !== undefined ? { topK: parsed.data.topK } : {}),
        },
        {
          connectionString: deps.connectionString,
          embedModel: deps.embedModel,
          genModel: deps.genModel,
          db: deps.db,
          ...(deps.embedClient !== undefined ? { embedClient: deps.embedClient } : {}),
          ...(deps.genClient !== undefined ? { genClient: deps.genClient } : {}),
        },
      )) {
        sse.send(event);
      }
    } catch (error) {
      // A client-side abort is a normal outcome, not a bug — classify it before it can reach
      // the error boundary as a 500 (CLAUDE.md).
      if (!(error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
    } finally {
      res.off('close', onClose);
      sse.close();
    }
  };
}
