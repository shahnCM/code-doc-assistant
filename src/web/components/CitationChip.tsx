import type { Citation, CitationProblem } from '../../shared/types.js';

export interface CitationRange {
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface CitationChipProps {
  citation: Citation;
  valid: boolean;
  reason: CitationProblem | null;
  onSelect?: ((range: CitationRange) => void) | undefined;
}

const REASON_LABEL: Record<CitationProblem, string> = {
  'unknown-file': 'cited file was not part of the retrieved context',
  'range-not-retrieved': 'cited range was not part of the retrieved context',
};

export function CitationChip({ citation, valid, reason, onSelect }: CitationChipProps) {
  if (!valid) {
    return (
      <span
        className="rounded border border-dashed border-gray-300 px-1 font-mono text-xs text-gray-400"
        title={reason ? REASON_LABEL[reason] : undefined}
      >
        {citation.raw}
      </span>
    );
  }

  function handleClick(): void {
    onSelect?.({ filePath: citation.filePath, startLine: citation.startLine, endLine: citation.endLine });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded border border-gray-300 px-1 font-mono text-xs text-accent underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {citation.raw}
    </button>
  );
}
