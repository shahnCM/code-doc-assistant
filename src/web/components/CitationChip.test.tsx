// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Citation } from '../../shared/types.js';
import { CitationChip } from './CitationChip.js';

afterEach(cleanup);

describe('CitationChip', () => {
  it('clicking a valid citation chip calls onSelect with exactly filePath/startLine/endLine', async () => {
    const citation: Citation = { filePath: 'src/a.ts', startLine: 10, endLine: 20, raw: 'src/a.ts:10-20' };
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(<CitationChip citation={citation} valid reason={null} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: citation.raw }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ filePath: 'src/a.ts', startLine: 10, endLine: 20 });
  });

  it('renders an invalid citation as non-interactive with the reason in its title', () => {
    const citation: Citation = {
      filePath: 'src/missing.ts',
      startLine: 1,
      endLine: 1,
      raw: 'src/missing.ts:1',
    };
    const onSelect = vi.fn();

    render(<CitationChip citation={citation} valid={false} reason="unknown-file" onSelect={onSelect} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    const chip = screen.getByText(citation.raw);
    expect(chip.getAttribute('title')).toMatch(/not part of the retrieved context/);

    fireEvent.click(chip);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('has a visible focus-visible outline utility class on the valid chip', () => {
    const citation: Citation = { filePath: 'src/a.ts', startLine: 1, endLine: 2, raw: 'src/a.ts:1-2' };

    render(<CitationChip citation={citation} valid reason={null} />);

    const chip = screen.getByRole('button', { name: citation.raw });
    expect(chip.className).toMatch(/focus-visible:outline/);
  });
});
