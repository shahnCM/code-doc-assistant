// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssembledChunkTrace } from '../../shared/types.js';
import { TracePanel } from './TracePanel.js';

afterEach(cleanup);

const includedChunk: AssembledChunkTrace = {
  id: 1,
  filePath: 'src/a.ts',
  symbolName: 'foo',
  startLine: 1,
  endLine: 10,
  language: 'typescript',
  chunkerKind: 'ts-morph',
  denseRank: 1,
  lexicalRank: 2,
  fusedScore: 0.842,
  included: true,
};

const droppedChunk: AssembledChunkTrace = {
  id: 2,
  filePath: 'src/b.py',
  symbolName: null,
  startLine: 5,
  endLine: 15,
  language: 'python',
  chunkerKind: 'generic',
  denseRank: null,
  lexicalRank: 3,
  fusedScore: 0.201,
  included: false,
};

describe('TracePanel', () => {
  it('shows a placeholder before any trace has arrived', () => {
    render(<TracePanel trace={null} cancelInfo={null} />);
    expect(screen.getByText(/no trace yet/i)).toBeInTheDocument();
  });

  it('shows fusedScore, denseRank, lexicalRank, and a language+chunkerKind badge per row, distinguishing dropped chunks', () => {
    render(
      <TracePanel
        trace={{ chunks: [includedChunk, droppedChunk], retrieveMs: 12, contextTokens: 340 }}
        cancelInfo={null}
      />,
    );

    const includedRow = screen.getByText('src/a.ts:1-10').closest('tr');
    if (!includedRow) throw new Error('expected included row');
    expect(within(includedRow).getByText('0.842')).toBeInTheDocument();
    expect(within(includedRow).getByText('1')).toBeInTheDocument();
    expect(within(includedRow).getByText('2')).toBeInTheDocument();
    expect(within(includedRow).getByText('typescript · ts-morph')).toBeInTheDocument();

    const droppedRow = screen.getByText('src/b.py:5-15').closest('tr');
    if (!droppedRow) throw new Error('expected dropped row');
    expect(within(droppedRow).getByText('python · generic')).toBeInTheDocument();

    expect(includedRow.className).not.toBe(droppedRow.className);
  });

  it('shows the locally computed cancel info when a Stop occurred', () => {
    render(
      <TracePanel
        trace={{ chunks: [includedChunk], retrieveMs: 12, contextTokens: 340 }}
        cancelInfo={{ elapsedMs: 820, estimatedTokensNotGenerated: 512 }}
      />,
    );

    expect(screen.getByText(/820ms/)).toBeInTheDocument();
    expect(screen.getByText(/512/)).toBeInTheDocument();
  });

  it('is collapsed by default and opens via the native <details> toggle', () => {
    render(
      <TracePanel trace={{ chunks: [includedChunk], retrieveMs: 12, contextTokens: 340 }} cancelInfo={null} />,
    );

    const details = screen.getByTestId('trace-panel');
    expect(details).toBeInstanceOf(HTMLDetailsElement);
    expect((details as HTMLDetailsElement).open).toBe(false);

    fireEvent.click(screen.getByText(/^Trace/));

    expect((details as HTMLDetailsElement).open).toBe(true);
  });
});
