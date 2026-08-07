// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPane } from './ChatPane.js';

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

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

async function sendQuestion(user: ReturnType<typeof userEvent.setup>, question: string): Promise<void> {
  await user.type(screen.getByPlaceholderText(/ask a question/i), question);
  await user.click(screen.getByRole('button', { name: /send/i }));
}

describe('ChatPane', () => {
  it('shows the empty state before any message is sent', () => {
    render(<ChatPane repoSource="" />);
    expect(screen.getByText(/ask a question about the indexed repository/i)).toBeInTheDocument();
  });

  it('renders the user message immediately and grows the assistant reply token by token', async () => {
    const handle = fakeStream();
    globalThis.fetch = (async () => ({ ok: true, status: 200, body: handle.stream }) as Response) as typeof fetch;
    const user = userEvent.setup();

    render(<ChatPane repoSource="" />);
    await sendQuestion(user, 'how does chunking work?');

    expect(screen.getByText('how does chunking work?')).toBeInTheDocument();

    handle.push({ type: 'token', text: 'Files route' });
    await waitFor(() => expect(screen.getByText('Files route')).toBeInTheDocument());

    handle.push({ type: 'token', text: ' by extension.' });
    await waitFor(() => expect(screen.getByText('Files route by extension.')).toBeInTheDocument());
  });

  it('Stop aborts the fetch and leaves the partial answer visible, restoring Send', async () => {
    const handle = fakeStream();
    globalThis.fetch = (async (_url, init) => {
      init?.signal?.addEventListener('abort', () => {
        handle.error(new DOMException('The operation was aborted.', 'AbortError'));
      });
      return { ok: true, status: 200, body: handle.stream } as Response;
    }) as typeof fetch;
    const user = userEvent.setup();

    render(<ChatPane repoSource="" />);
    await sendQuestion(user, 'question');

    handle.push({ type: 'token', text: 'partial answer' });
    await waitFor(() => expect(screen.getByText('partial answer')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /stop/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument());
    expect(screen.getByText('partial answer')).toBeInTheDocument();
  });

  it('renders an error state when the stream reports an error', async () => {
    const handle = fakeStream();
    globalThis.fetch = (async () => ({ ok: true, status: 200, body: handle.stream }) as Response) as typeof fetch;
    const user = userEvent.setup();

    render(<ChatPane repoSource="" />);
    await sendQuestion(user, 'question');

    handle.push({ type: 'error', message: 'generation failed' });
    handle.close();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('generation failed'));
  });

  it('renders a resolved citation as a chip and keeps it after a second turn starts', async () => {
    const handles = [fakeStream(), fakeStream()];
    let call = 0;
    globalThis.fetch = (async () => {
      const handle = handles[call];
      call += 1;
      return { ok: true, status: 200, body: handle?.stream } as Response;
    }) as typeof fetch;
    const onCitationSelect = vi.fn();
    const user = userEvent.setup();

    render(<ChatPane repoSource="./tmp/hono" onCitationSelect={onCitationSelect} />);
    await sendQuestion(user, 'how does chunking work?');

    const first = handles[0];
    if (!first) throw new Error('expected first fake stream');
    first.push({ type: 'token', text: 'see src/a.ts:10-20 for it' });
    first.push({
      type: 'citations',
      valid: [{ filePath: 'src/a.ts', startLine: 10, endLine: 20, raw: 'src/a.ts:10-20' }],
      invalid: [],
    });
    first.push({ type: 'done', finishReason: 'STOP', generateMs: 1, totalMs: 2 });
    first.close();

    await waitFor(() => expect(screen.getByRole('button', { name: 'src/a.ts:10-20' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'src/a.ts:10-20' }));
    expect(onCitationSelect).toHaveBeenCalledWith({ filePath: 'src/a.ts', startLine: 10, endLine: 20 });

    // A second turn resets the hook's own `citations` back to null — the chip from the first
    // turn must survive that via ChatPane's own citationsByIndex, not the hook's state.
    await sendQuestion(user, 'a follow-up question');
    await waitFor(() => expect(screen.getByText('a follow-up question')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'src/a.ts:10-20' })).toBeInTheDocument();
  });
});
