// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../shared/types.js';
import { estimateTokensNotGenerated } from '../lib/tokenEstimate.js';
import { useChatStream } from './useChatStream.js';

function sseFrame(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function fakeStream() {
  let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
  });
  return {
    stream,
    push: (event: unknown) => controllerRef.enqueue(sseFrame(event)),
    close: () => controllerRef.close(),
    error: (err: unknown) => controllerRef.error(err),
  };
}

function fakeFetchFor(handle: ReturnType<typeof fakeStream>): typeof fetch {
  return (async (_url, init) => {
    init?.signal?.addEventListener('abort', () => {
      handle.error(new DOMException('The operation was aborted.', 'AbortError'));
    });
    return { ok: true, status: 200, body: handle.stream } as Response;
  }) as typeof fetch;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const messages: ChatMessage[] = [{ role: 'user', content: 'how does chunking work?' }];

describe('useChatStream', () => {
  it('transitions idle to streaming and grows partialText with each token event', async () => {
    const handle = fakeStream();
    globalThis.fetch = fakeFetchFor(handle);

    const { result } = renderHook(() => useChatStream());
    expect(result.current.state.status).toBe('idle');

    act(() => {
      void result.current.send(messages, '');
    });
    await waitFor(() => expect(result.current.state.status).toBe('streaming'));

    handle.push({ type: 'token', text: 'Files route' });
    await waitFor(() => expect(result.current.state.partialText).toBe('Files route'));

    handle.push({ type: 'token', text: ' by extension.' });
    await waitFor(() => expect(result.current.state.partialText).toBe('Files route by extension.'));
  });

  it('attaches the resolved trace and citations once done', async () => {
    const handle = fakeStream();
    globalThis.fetch = fakeFetchFor(handle);

    const { result } = renderHook(() => useChatStream());
    act(() => {
      void result.current.send(messages, '');
    });
    await waitFor(() => expect(result.current.state.status).toBe('streaming'));

    handle.push({ type: 'trace', chunks: [], retrieveMs: 12, contextTokens: 340 });
    handle.push({ type: 'token', text: 'answer' });
    handle.push({ type: 'citations', valid: [], invalid: [] });
    handle.push({ type: 'done', finishReason: 'STOP', generateMs: 5, totalMs: 20 });
    handle.close();

    await waitFor(() => expect(result.current.state.status).toBe('done'));
    expect(result.current.state.trace).toEqual({ chunks: [], retrieveMs: 12, contextTokens: 340 });
    expect(result.current.state.citations).toEqual({ valid: [], invalid: [] });
  });

  it('stop() aborts mid-stream, keeps partialText, and computes cancel info locally', async () => {
    const handle = fakeStream();
    globalThis.fetch = fakeFetchFor(handle);

    const { result } = renderHook(() => useChatStream());
    act(() => {
      void result.current.send(messages, '');
    });
    await waitFor(() => expect(result.current.state.status).toBe('streaming'));

    handle.push({ type: 'token', text: 'partial answer' });
    await waitFor(() => expect(result.current.state.partialText).toBe('partial answer'));

    act(() => {
      result.current.stop();
    });

    await waitFor(() => expect(result.current.state.status).toBe('cancelled'));
    expect(result.current.state.partialText).toBe('partial answer');
    expect(result.current.state.cancelInfo).not.toBeNull();
    expect(result.current.state.cancelInfo?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.current.state.cancelInfo?.estimatedTokensNotGenerated).toBe(
      estimateTokensNotGenerated('partial answer'),
    );
  });

  it('a type: error frame lands in status error with a message', async () => {
    const handle = fakeStream();
    globalThis.fetch = fakeFetchFor(handle);

    const { result } = renderHook(() => useChatStream());
    act(() => {
      void result.current.send(messages, '');
    });
    await waitFor(() => expect(result.current.state.status).toBe('streaming'));

    handle.push({ type: 'error', message: 'generation failed' });
    handle.close();

    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(result.current.state.errorMessage).toBe('generation failed');
  });

  it('a network-level fetch rejection lands in status error with a message', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network down');
    }) as typeof fetch;

    const { result } = renderHook(() => useChatStream());
    await act(async () => {
      await result.current.send(messages, '');
    });

    expect(result.current.state.status).toBe('error');
    expect(result.current.state.errorMessage).toBe('network down');
  });
});
