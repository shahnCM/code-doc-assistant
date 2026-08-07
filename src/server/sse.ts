import type { ChatEvent } from '../shared/types.js';

const DEFAULT_HEARTBEAT_MS = 15_000;

export interface SseCapableResponse {
  status(code: number): unknown;
  set(headers: Record<string, string>): unknown;
  flushHeaders(): void;
  write(chunk: string): unknown;
  end(): unknown;
  writableEnded: boolean;
}

export interface OpenSseOptions {
  heartbeatMs?: number;
}

export interface SseHandle {
  send(event: ChatEvent): void;
  comment(text: string): void;
  close(): void;
}

export function openSse(res: SseCapableResponse, options: OpenSseOptions = {}): SseHandle {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Without this, an intermediary proxy (nginx) can buffer the whole stream and never
    // flush it to the client — the same class of problem compression middleware causes.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  function comment(text: string): void {
    res.write(`: ${text}\n\n`);
  }

  const interval = setInterval(() => comment('heartbeat'), heartbeatMs);
  let closed = false;

  return {
    send(event) {
      // The whole event is one JSON-encoded data: line — JSON.stringify escapes any
      // newline inside event text, so a multi-line token can never split the SSE frame.
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    comment,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      if (!res.writableEnded) res.end();
    },
  };
}
