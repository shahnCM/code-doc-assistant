import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { ChatMessage, CitationValidation } from '../../shared/types.js';
import { useChatStream } from '../hooks/useChatStream.js';
import type { CitationRange } from './CitationChip.js';
import { MessageBubble } from './MessageBubble.js';

export interface ChatPaneProps {
  repoSource: string;
  onCitationSelect?: ((range: CitationRange) => void) | undefined;
}

export function ChatPane({ repoSource, onCitationSelect }: ChatPaneProps) {
  const { state, send, stop } = useChatStream();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  // Keyed by the assistant message's index in `history` — the hook resets its own `citations`
  // on every new send(), so a prior turn's resolved citations must live here to still render as
  // chips once a later turn is in flight. ChatMessage itself carries no id to key by instead.
  const [citationsByIndex, setCitationsByIndex] = useState<Record<number, CitationValidation>>({});
  const [input, setInput] = useState('');
  const previousStatusRef = useRef(state.status);

  // The hook owns only the current turn's stream; once it settles, fold it into the
  // committed history so the next send() carries it as context.
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = state.status;
    const justFinished =
      previousStatus === 'streaming' && (state.status === 'done' || state.status === 'cancelled');
    if (!justFinished) return;

    const newIndex = history.length;
    const citations = state.citations;
    setHistory((prev) => [...prev, { role: 'assistant', content: state.partialText }]);
    if (citations) {
      setCitationsByIndex((prev) => ({ ...prev, [newIndex]: citations }));
    }
  }, [state.status, state.partialText, state.citations, history.length]);

  useEffect(() => stop, [stop]);

  const isStreaming = state.status === 'streaming';
  const isEmpty = history.length === 0 && !isStreaming;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const content = input.trim();
    if (!content || isStreaming) return;

    const nextHistory: ChatMessage[] = [...history, { role: 'user', content }];
    setHistory(nextHistory);
    setInput('');
    void send(nextHistory, repoSource);
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>): void {
    setInput(event.target.value);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-4" aria-label="conversation">
        {isEmpty ? (
          <p className="text-sm text-gray-500">
            Ask a question about the indexed repository to get started.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {history.map((message, index) => (
              <li key={index} className={message.role === 'user' ? 'text-right' : 'text-left'}>
                <MessageBubble
                  message={message}
                  citations={citationsByIndex[index] ?? null}
                  onCitationSelect={onCitationSelect}
                />
              </li>
            ))}
            {isStreaming && (
              <li className="text-left">
                <MessageBubble
                  message={{ role: 'assistant', content: state.partialText || '…' }}
                  citations={null}
                />
              </li>
            )}
          </ul>
        )}
        {state.status === 'error' && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {state.errorMessage ?? 'Something went wrong.'}
          </p>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-gray-200 p-3">
        <input
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-2 focus:outline-accent"
          value={input}
          onChange={handleInputChange}
          placeholder="Ask a question…"
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={stop}
            className="rounded bg-gray-900 px-4 py-2 text-sm font-semibold text-white focus:outline-2 focus:outline-accent"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white focus:outline-2 focus:outline-offset-2 focus:outline-accent"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
