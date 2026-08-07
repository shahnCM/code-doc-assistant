import type { Content } from '@google/genai';
import type { ChatMessage } from '../shared/types.js';

export const MAX_HISTORY_TURNS = 8;

export const CITATION_FORMAT = 'path/to/file.ts:120-145';
export const REFUSAL_SENTENCE = 'not found in the indexed code';
export const CONTEXT_MARKER = '--- retrieved context ---';

export function buildSystemPrompt(): string {
  return [
    'You are a code documentation assistant. Answer only using the retrieved context blocks',
    'attached to the conversation — never from general knowledge or prior training.',
    '',
    `Cite every claim with a reference in the exact format ${CITATION_FORMAT}, using the file`,
    "path and line range from the cited context block's header.",
    '',
    'If the retrieved context does not answer the question, say so plainly and end the reply',
    `with the exact sentence: "${REFUSAL_SENTENCE}". Never invent a file path, line range, or`,
    'fact that is not present in the retrieved context.',
  ].join('\n');
}

export function buildContents(messages: readonly ChatMessage[], contextText: string): Content[] {
  const capped = messages.slice(-MAX_HISTORY_TURNS);
  const lastUserIndex = capped.map((message) => message.role).lastIndexOf('user');

  return capped.map((message, index) => {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const text =
      index === lastUserIndex
        ? `${CONTEXT_MARKER}\n${contextText}\n\n${message.content}`
        : message.content;
    return { role, parts: [{ text }] };
  });
}
