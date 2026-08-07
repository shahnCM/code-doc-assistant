import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../shared/types.js';
import {
  CITATION_FORMAT,
  CONTEXT_MARKER,
  MAX_HISTORY_TURNS,
  REFUSAL_SENTENCE,
  buildContents,
  buildSystemPrompt,
} from './prompt.js';

describe('buildSystemPrompt', () => {
  it('[8] contains the literal citation format and the exact refusal sentence, read from the exported constants', () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain(CITATION_FORMAT);
    expect(prompt).toContain(REFUSAL_SENTENCE);
  });
});

describe('buildContents', () => {
  it('[9] renders history in order, caps at MAX_HISTORY_TURNS, and attaches context to the last user turn only', () => {
    const messages: ChatMessage[] = Array.from({ length: MAX_HISTORY_TURNS + 3 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
    }));

    const contents = buildContents(messages, 'THE_CONTEXT_BODY');
    const capped = messages.slice(-MAX_HISTORY_TURNS);

    expect(contents).toHaveLength(MAX_HISTORY_TURNS);
    expect(contents.map((c) => c.role)).toEqual(
      capped.map((m) => (m.role === 'assistant' ? 'model' : 'user')),
    );

    const texts = contents.map((c) => c.parts?.[0]?.text ?? '');
    const withMarker = texts.filter((t) => t.includes(CONTEXT_MARKER));
    expect(withMarker).toHaveLength(1);

    const lastUserIndex = capped.map((m) => m.role).lastIndexOf('user');
    expect(texts[lastUserIndex]).toContain(CONTEXT_MARKER);
    expect(texts[lastUserIndex]).toContain('THE_CONTEXT_BODY');

    capped.forEach((m, i) => {
      if (i === lastUserIndex) return;
      expect(texts[i]).toBe(m.content);
    });
  });
});
