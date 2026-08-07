import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../shared/types.js';
import { parseSseStream } from './sseStream.js';

function fakeReader(chunks: readonly string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    async read() {
      if (index >= chunks.length) return { done: true, value: undefined };
      const chunk = chunks[index];
      index += 1;
      return { done: false, value: encoder.encode(chunk) };
    },
  } as ReadableStreamDefaultReader<Uint8Array>;
}

async function collect(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of parseSseStream(reader)) events.push(event);
  return events;
}

describe('parseSseStream', () => {
  it('yields both events when one read contains two complete frames', async () => {
    const reader = fakeReader([
      `data: ${JSON.stringify({ type: 'token', text: 'a' })}\n\n` +
        `data: ${JSON.stringify({ type: 'token', text: 'b' })}\n\n`,
    ]);

    await expect(collect(reader)).resolves.toEqual([
      { type: 'token', text: 'a' },
      { type: 'token', text: 'b' },
    ]);
  });

  it('parses a frame whose bytes arrive split across two reads', async () => {
    const frame = `data: ${JSON.stringify({ type: 'token', text: 'hello' })}\n\n`;
    const splitAt = Math.floor(frame.length / 2);
    const reader = fakeReader([frame.slice(0, splitAt), frame.slice(splitAt)]);

    await expect(collect(reader)).resolves.toEqual([{ type: 'token', text: 'hello' }]);
  });

  it('ignores heartbeat comment lines between data frames', async () => {
    const doneEvent: ChatEvent = { type: 'done', finishReason: 'STOP', generateMs: 1, totalMs: 2 };
    const reader = fakeReader([`: heartbeat\n\ndata: ${JSON.stringify(doneEvent)}\n\n`]);

    await expect(collect(reader)).resolves.toEqual([doneEvent]);
  });

  it('ends cleanly on stream end without yielding a trailing partial frame', async () => {
    const reader = fakeReader([
      `data: ${JSON.stringify({ type: 'token', text: 'x' })}\n\ndata: {"type":"token","text":"unterm`,
    ]);

    await expect(collect(reader)).resolves.toEqual([{ type: 'token', text: 'x' }]);
  });
});
