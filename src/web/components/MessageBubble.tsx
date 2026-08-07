import type { ChatMessage, CitationValidation } from '../../shared/types.js';
import { buildCitationLookup, splitWithCitations } from '../lib/citations.js';
import { CitationChip, type CitationRange } from './CitationChip.js';

export interface MessageBubbleProps {
  message: ChatMessage;
  citations?: CitationValidation | null;
  onCitationSelect?: ((range: CitationRange) => void) | undefined;
}

const BUBBLE_CLASS_NAME = 'inline-block rounded-lg px-3 py-2 text-sm whitespace-pre-wrap';

export function MessageBubble({ message, citations, onCitationSelect }: MessageBubbleProps) {
  if (message.role === 'user') {
    return <p className={`${BUBBLE_CLASS_NAME} bg-accent text-white`}>{message.content}</p>;
  }

  const lookup = buildCitationLookup(citations ?? null);
  const segments = splitWithCitations(message.content, lookup);

  return (
    <p className={`${BUBBLE_CLASS_NAME} bg-gray-100 text-gray-900`}>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <CitationChip
            key={index}
            citation={segment.citation}
            valid={segment.valid}
            reason={segment.reason}
            onSelect={onCitationSelect}
          />
        ),
      )}
    </p>
  );
}
