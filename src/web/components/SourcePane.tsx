import { useEffect, useState } from 'react';
import type { SourceRange } from '../../shared/types.js';
import { isAbortError } from '../hooks/useChatStream.js';
import type { CitationRange } from './CitationChip.js';

export interface SourcePaneProps {
  repoSource: string;
  selection: CitationRange | null;
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

export function SourcePane({ repoSource, selection }: SourcePaneProps) {
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

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-gray-200 px-3 py-2 text-xs font-semibold text-gray-500">Source</div>
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
          <div className="p-4 font-mono text-xs">
            {mergeBlocksAndGaps(range).map((segment, index) =>
              segment.kind === 'gap' ? (
                <p key={index} className="my-1 text-gray-400 italic">
                  ⋯ lines {segment.startLine}-{segment.endLine} not indexed ⋯
                </p>
              ) : (
                <pre key={index} className="whitespace-pre-wrap">
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
