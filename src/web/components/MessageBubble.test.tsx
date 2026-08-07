// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, CitationValidation } from '../../shared/types.js';
import { MessageBubble } from './MessageBubble.js';

afterEach(cleanup);

describe('MessageBubble', () => {
  it('renders a resolved citation inline as a clickable chip wired to onCitationSelect', async () => {
    const message: ChatMessage = { role: 'assistant', content: 'see src/a.ts:10-20 for it' };
    const citations: CitationValidation = {
      valid: [{ filePath: 'src/a.ts', startLine: 10, endLine: 20, raw: 'src/a.ts:10-20' }],
      invalid: [],
    };
    const onCitationSelect = vi.fn();
    const user = userEvent.setup();

    render(<MessageBubble message={message} citations={citations} onCitationSelect={onCitationSelect} />);

    await user.click(screen.getByRole('button', { name: 'src/a.ts:10-20' }));
    expect(onCitationSelect).toHaveBeenCalledWith({ filePath: 'src/a.ts', startLine: 10, endLine: 20 });
  });

  it('renders citation-shaped text as plain text while citations have not resolved yet', () => {
    const message: ChatMessage = { role: 'assistant', content: 'see src/a.ts:10-20 for it' };

    render(<MessageBubble message={message} citations={null} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/see/)).toBeInTheDocument();
  });

  it('never parses citations out of a user message', () => {
    const message: ChatMessage = { role: 'user', content: 'what about src/a.ts:10-20?' };
    const citations: CitationValidation = {
      valid: [{ filePath: 'src/a.ts', startLine: 10, endLine: 20, raw: 'src/a.ts:10-20' }],
      invalid: [],
    };

    render(<MessageBubble message={message} citations={citations} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
