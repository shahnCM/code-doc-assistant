import type { AssembledChunkTrace } from '../../shared/types.js';
import type { CancelInfo, TraceInfo } from '../hooks/useChatStream.js';

export interface TracePanelProps {
  trace: TraceInfo | null;
  cancelInfo: CancelInfo | null;
}

function chunkRangeLabel(chunk: AssembledChunkTrace): string {
  return `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
}

export function TracePanel({ trace, cancelInfo }: TracePanelProps) {
  const chunkCount = trace?.chunks.length ?? 0;
  const summary = trace
    ? `Trace — ${chunkCount} chunk${chunkCount === 1 ? '' : 's'} · ${trace.retrieveMs}ms retrieve · ${trace.contextTokens} tokens`
    : 'Trace';

  return (
    <details data-testid="trace-panel" className="border-t border-gray-200 text-xs">
      <summary className="cursor-pointer px-3 py-2 font-semibold text-gray-500 select-none">{summary}</summary>
      <div className="max-h-64 overflow-y-auto px-3 pb-3">
        {cancelInfo && (
          <p className="mb-2 text-gray-600">
            Stopped after {cancelInfo.elapsedMs}ms — ~{cancelInfo.estimatedTokensNotGenerated} tokens not
            generated (estimated client-side; the service may keep billing regardless).
          </p>
        )}
        {!trace ? (
          <p className="text-gray-400">No trace yet — ask a question to see retrieval details.</p>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="text-gray-400">
                <th className="pr-2 font-normal">Chunk</th>
                <th className="pr-2 font-normal">Lang / chunker</th>
                <th className="pr-2 font-normal">Dense</th>
                <th className="pr-2 font-normal">Lexical</th>
                <th className="pr-2 font-normal">Fused</th>
              </tr>
            </thead>
            <tbody>
              {trace.chunks.map((chunk) => (
                <tr key={chunk.id} className={chunk.included ? 'text-gray-900' : 'text-gray-400 opacity-60'}>
                  <td className="pr-2 font-mono">{chunkRangeLabel(chunk)}</td>
                  <td className="pr-2">
                    <span className="rounded bg-gray-100 px-1">
                      {chunk.language} · {chunk.chunkerKind}
                    </span>
                  </td>
                  <td className="pr-2">{chunk.denseRank ?? '—'}</td>
                  <td className="pr-2">{chunk.lexicalRank ?? '—'}</td>
                  <td className="pr-2">{chunk.fusedScore.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}
