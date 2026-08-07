import { useEffect, useState } from 'react';
import type { SourceRange } from '../../shared/types.js';
import { isAbortError } from '../hooks/useChatStream.js';
import type { CitationRange } from './CitationChip.js';

export interface SourcePaneProps {
  repoSource: string;
  selection: CitationRange | null;
  onClose?: (() => void) | undefined;
}

type SourcePaneStatus = 'empty' | 'missing-repo-source' | 'loading' | 'success' | 'no-results' | 'error';

interface RenderSegment {
  kind: 'block' | 'gap';
  startLine: number;
  endLine: number;
  content?: string;
}

// Blocks and gaps never overlap (a gap is exactly the span between blocks — see
// src/retrieve/source.ts), so sorting the two arrays together by startLine reproduces the
// original line order without needing a real merge.
function mergeBlocksAndGaps(range: SourceRange): RenderSegment[] {
  const segments: RenderSegment[] = [
    ...range.blocks.map((block) => ({ kind: 'block' as const, ...block })),
    ...range.gaps.map((gap) => ({ kind: 'gap' as const, ...gap })),
  ];
  return segments.sort((a, b) => a.startLine - b.startLine);
}

export function SourcePane({ repoSource, selection, onClose }: SourcePaneProps) {
  const [status, setStatus] = useState<SourcePaneStatus>('empty');
  const [range, setRange] = useState<SourceRange | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!selection) {
      setStatus('empty');
      setRange(null);
      return;
    }

    if (!repoSource) {
      setStatus('missing-repo-source');
      setRange(null);
      return;
    }

    const controller = new AbortController();
    setStatus('loading');

    const params = new URLSearchParams({
      repoSource,
      filePath: selection.filePath,
      startLine: String(selection.startLine),
      endLine: String(selection.endLine),
    });

    fetch(`/api/source?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) {
          setStatus('no-results');
          return;
        }
        if (!response.ok) {
          setStatus('error');
          setErrorMessage(`request failed with status ${response.status}`);
          return;
        }
        setRange((await response.json()) as SourceRange);
        setStatus('success');
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setStatus('error');
        setErrorMessage(error instanceof Error ? error.message : 'unknown error');
      });

    return () => controller.abort();
  }, [repoSource, selection?.filePath, selection?.startLine, selection?.endLine]);

  // On mobile the pane is a slide-up drawer, out of the document flow (`fixed`) and hidden below
  // the viewport until a citation is selected; at `md` and up it becomes a normal static side
  // pane instead. Deriving "open" from `selection` means no separate open/closed state to keep
  // in sync (plans/05-frontend.md Decisions).
  const isOpenOnMobile = selection !== null;

  return (
    <div
      className={[
        'fixed inset-x-0 bottom-0 z-20 flex max-h-[70dvh] flex-col overflow-hidden rounded-t-lg border-t border-gray-200 bg-white shadow-lg transition-transform duration-200',
        isOpenOnMobile ? 'translate-y-0' : 'translate-y-full',
        'md:static md:z-auto md:h-full md:max-h-none md:w-96 md:flex-shrink-0 md:translate-y-0 md:rounded-none md:border-t-0 md:border-l md:shadow-none',
      ].join(' ')}
    >
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
        <span className="text-xs font-semibold text-gray-500">Source</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="close source pane"
            className="text-xs text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:hidden"
          >
            Close
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {status === 'empty' && <p className="p-4 text-sm text-gray-500">Select a citation to view its source.</p>}
        {status === 'missing-repo-source' && (
          <p className="p-4 text-sm text-gray-500">Enter a repo source above to load code.</p>
        )}
        {status === 'loading' && <p className="p-4 text-sm text-gray-500">Loading…</p>}
        {status === 'no-results' && <p className="p-4 text-sm text-gray-500">No source found for that range.</p>}
        {status === 'error' && (
          <p role="alert" className="p-4 text-sm text-red-600">
            {errorMessage ?? 'Failed to load source.'}
          </p>
        )}
        {status === 'success' && range && (
          <div className="p-4 text-xs">
            {mergeBlocksAndGaps(range).map((segment, index) =>
              segment.kind === 'gap' ? (
                <p key={index} className="my-1 text-gray-400 italic">
                  ⋯ lines {segment.startLine}-{segment.endLine} not indexed ⋯
                </p>
              ) : (
                <pre key={index} className="font-mono whitespace-pre-wrap">
                  <code>{segment.content}</code>
                </pre>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
