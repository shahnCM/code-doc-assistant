// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceRange } from '../../shared/types.js';
import { SourcePane } from './SourcePane.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

const selection = { filePath: 'src/a.ts', startLine: 10, endLine: 20 };

describe('SourcePane', () => {
  it('shows the empty state when nothing is selected', () => {
    render(<SourcePane repoSource="./tmp/hono" selection={null} />);
    expect(screen.getByText(/select a citation/i)).toBeInTheDocument();
  });

  it('shows an inline hint and issues no fetch when repoSource is empty', () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    render(<SourcePane repoSource="" selection={selection} />);

    expect(screen.getByText(/enter a repo source/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches GET /api/source with the exact query params and renders blocks, marking gaps as elision', async () => {
    const range: SourceRange = {
      repoSource: './tmp/hono',
      filePath: 'src/a.ts',
      startLine: 10,
      endLine: 20,
      blocks: [{ startLine: 10, endLine: 14, content: 'function a() {}' }],
      gaps: [{ startLine: 15, endLine: 20 }],
    };
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => range } as Response;
    }) as typeof fetch;

    render(<SourcePane repoSource="./tmp/hono" selection={selection} />);

    await waitFor(() => expect(screen.getByText('function a() {}')).toBeInTheDocument());

    const url = new URL(calledUrl, 'http://localhost');
    expect(url.pathname).toBe('/api/source');
    expect(url.searchParams.get('repoSource')).toBe('./tmp/hono');
    expect(url.searchParams.get('filePath')).toBe('src/a.ts');
    expect(url.searchParams.get('startLine')).toBe('10');
    expect(url.searchParams.get('endLine')).toBe('20');

    const gapMarker = screen.getByText(/15-20/);
    expect(gapMarker.closest('pre')).toBeNull();
    expect(gapMarker.closest('code')).toBeNull();
  });

  it('renders the no-results state on a 404', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch;

    render(<SourcePane repoSource="./tmp/hono" selection={selection} />);

    await waitFor(() => expect(screen.getByText(/no source found/i)).toBeInTheDocument());
  });

  it('renders the error state on a network failure', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('network down');
    }) as typeof fetch;

    render(<SourcePane repoSource="./tmp/hono" selection={selection} />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('network down'));
  });
});
