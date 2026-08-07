// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
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
});
