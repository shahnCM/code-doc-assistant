import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '../shared/types.js';
import { openSse, type SseCapableResponse } from './sse.js';

function fakeRes(): { res: SseCapableResponse; calls: ReturnType<typeof makeCalls> } {
  const calls = makeCalls();
  const res: SseCapableResponse = {
    status(code) {
      calls.statusCode = code;
      return res;
    },
    set(headers) {
      calls.headers = headers;
      return res;
    },
    flushHeaders() {
      calls.flushCount += 1;
    },
    write(chunk) {
      calls.writes.push(chunk);
      return true;
    },
    end() {
      calls.endCount += 1;
    },
    get writableEnded() {
      return calls.endCount > 0;
    },
  };
  return { res, calls };
}

function makeCalls() {
  return {
    statusCode: undefined as number | undefined,
    headers: undefined as Record<string, string> | undefined,
    flushCount: 0,
    writes: [] as string[],
    endCount: 0,
  };
}

describe('openSse', () => {
  it('[29] sets SSE headers and calls flushHeaders before any event is written', () => {
    const { res, calls } = fakeRes();

    openSse(res);

    expect(calls.statusCode).toBe(200);
    expect(calls.headers).toMatchObject({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    expect(calls.flushCount).toBe(1);
    expect(calls.writes).toEqual([]);
  });

  it('[30] serializes an event to exactly one data: line, even when the payload text contains a blank line', () => {
    const { res, calls } = fakeRes();
    const sse = openSse(res);
    const event: ChatEvent = { type: 'token', text: 'line one\n\nline two' };

    sse.send(event);

    expect(calls.writes).toHaveLength(1);
    const frame = calls.writes[0] ?? '';
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    const body = frame.slice('data: '.length, -2);
    expect(body).not.toContain('\n');
    expect(JSON.parse(body)).toEqual(event);
  });

  describe('heartbeat and teardown', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('[31] writes a heartbeat comment on its interval, and close() clears the interval exactly once', () => {
      const { res, calls } = fakeRes();
      const sse = openSse(res, { heartbeatMs: 1000 });

      vi.advanceTimersByTime(1000);
      expect(calls.writes).toHaveLength(1);
      expect(calls.writes[0]).toMatch(/^: /);

      sse.close();
      const writesAfterClose = calls.writes.length;
      vi.advanceTimersByTime(2000);
      expect(calls.writes).toHaveLength(writesAfterClose);
    });

    it('close() ends the response exactly once, even when called twice', () => {
      const { res, calls } = fakeRes();
      const sse = openSse(res, { heartbeatMs: 1000 });

      sse.close();
      sse.close();

      expect(calls.endCount).toBe(1);
    });
  });
});
