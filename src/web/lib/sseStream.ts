import type { ChatEvent } from '../../shared/types.js';

const FRAME_SEPARATOR = '\n\n';

export async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<ChatEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf(FRAME_SEPARATOR);
    while (separatorIndex !== -1) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + FRAME_SEPARATOR.length);

      const event = parseFrame(frame);
      if (event) yield event;

      separatorIndex = buffer.indexOf(FRAME_SEPARATOR);
    }
  }
}

// A comment (heartbeat) frame starts with ':' and carries no JSON — see src/server/sse.ts.
function parseFrame(frame: string): ChatEvent | null {
  if (frame.startsWith(':') || !frame.startsWith('data:')) return null;
  return JSON.parse(frame.slice('data:'.length).trim()) as ChatEvent;
}
