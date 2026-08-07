import { useCallback, useRef, useState } from 'react';
import type {
  AssembledChunkTrace,
  ChatMessage,
  CitationValidation,
} from '../../shared/types.js';
import { parseSseStream } from '../lib/sseStream.js';
import { estimateTokensNotGenerated } from '../lib/tokenEstimate.js';

export type ChatStreamStatus = 'idle' | 'streaming' | 'done' | 'cancelled' | 'error';

export interface TraceInfo {
  chunks: AssembledChunkTrace[];
  retrieveMs: number;
  contextTokens: number;
}

export interface CancelInfo {
  elapsedMs: number;
  estimatedTokensNotGenerated: number;
}

export interface ChatStreamState {
  status: ChatStreamStatus;
  partialText: string;
  trace: TraceInfo | null;
  citations: CitationValidation | null;
  errorMessage: string | null;
  cancelInfo: CancelInfo | null;
}

export interface UseChatStream {
  state: ChatStreamState;
  send(messages: ChatMessage[], repoSource: string): Promise<void>;
  stop(): void;
}

const IDLE_STATE: ChatStreamState = {
  status: 'idle',
  partialText: '',
  trace: null,
  citations: null,
  errorMessage: null,
  cancelInfo: null,
};

export function useChatStream(): UseChatStream {
  const [state, setState] = useState<ChatStreamState>(IDLE_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef(0);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(async (messages: ChatMessage[], repoSource: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    startedAtRef.current = Date.now();

    setState({ ...IDLE_STATE, status: 'streaming' });

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, ...(repoSource ? { repoSource } : {}) }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          errorMessage: `request failed with status ${response.status}`,
        }));
        return;
      }

      const reader = response.body.getReader();

      for await (const event of parseSseStream(reader)) {
        switch (event.type) {
          case 'trace':
            setState((prev) => ({
              ...prev,
              trace: { chunks: event.chunks, retrieveMs: event.retrieveMs, contextTokens: event.contextTokens },
            }));
            break;
          case 'token':
            setState((prev) => ({ ...prev, partialText: prev.partialText + event.text }));
            break;
          case 'citations':
            setState((prev) => ({ ...prev, citations: { valid: event.valid, invalid: event.invalid } }));
            break;
          case 'done':
            setState((prev) => ({ ...prev, status: 'done' }));
            return;
          case 'cancelled':
            // Unreachable on a client-initiated Stop (the AbortError branch below handles that
            // case) — this only fires if the server cancels for its own reason, e.g. its
            // deadline, while we are still reading normally.
            setState((prev) => ({
              ...prev,
              status: 'cancelled',
              cancelInfo: {
                elapsedMs: event.elapsedMs,
                estimatedTokensNotGenerated: event.estimatedTokensNotGenerated,
              },
            }));
            return;
          case 'error':
            setState((prev) => ({ ...prev, status: 'error', errorMessage: event.message }));
            return;
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        // A client-initiated abort errors the response reader immediately, per the Fetch spec —
        // the server's own `cancelled` event, sent after it notices the disconnect, never
        // reaches us. Compute the same figures locally instead of waiting for it.
        setState((prev) => ({
          ...prev,
          status: 'cancelled',
          cancelInfo: {
            elapsedMs: Date.now() - startedAtRef.current,
            estimatedTokensNotGenerated: estimateTokensNotGenerated(prev.partialText),
          },
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'unknown error',
      }));
    }
  }, []);

  return { state, send, stop };
}

// Per the WHATWG spec, DOMException does not extend Error — true in real browsers and in
// jsdom, unlike Node's own DOMException, which does. `instanceof Error` alone would
// misclassify every user-initiated Stop as a generic error once this ships to a browser.
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}
