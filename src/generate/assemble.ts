import type { RetrievedChunk } from '../shared/types.js';
import { estimateTokens } from '../tokens.js';

export const DEFAULT_CONTEXT_TOKEN_BUDGET = 8000;

export interface AssembleContextOptions {
  tokenBudget?: number;
}

export interface AssembledContext {
  text: string;
  included: RetrievedChunk[];
  dropped: RetrievedChunk[];
  budgetExceeded: boolean;
}

export function renderChunkBlock(chunk: RetrievedChunk): string {
  const symbolPart = chunk.symbolName ? ` (${chunk.symbolName})` : '';
  const header = `--- ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}${symbolPart} [${chunk.language}] ---`;
  return `${header}\n${chunk.content}`;
}

function dedupeByFile(chunks: readonly RetrievedChunk[]): {
  kept: RetrievedChunk[];
  dropped: RetrievedChunk[];
} {
  const bestByFile = new Map<string, RetrievedChunk>();
  const dropped: RetrievedChunk[] = [];

  for (const chunk of chunks) {
    const existing = bestByFile.get(chunk.filePath);
    if (!existing) {
      bestByFile.set(chunk.filePath, chunk);
    } else if (chunk.fusedScore > existing.fusedScore) {
      dropped.push(existing);
      bestByFile.set(chunk.filePath, chunk);
    } else {
      dropped.push(chunk);
    }
  }

  return { kept: [...bestByFile.values()], dropped };
}

/**
 * The unit of inclusion is the whole rendered block (header + content), so truncation can only
 * ever drop a complete block — never leave a header with no body. The highest-scoring block is
 * always kept whole even if it alone exceeds the budget; an empty context here would fire the
 * refusal path for a question we did retrieve results for.
 */
export function assembleContext(
  chunks: readonly RetrievedChunk[],
  options: AssembleContextOptions = {},
): AssembledContext {
  const tokenBudget = options.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;

  const { kept, dropped: dedupeDropped } = dedupeByFile(chunks);
  const ordered = [...kept].sort((a, b) => b.fusedScore - a.fusedScore);

  if (ordered.length === 0) {
    return { text: '', included: [], dropped: dedupeDropped, budgetExceeded: false };
  }

  const rendered = ordered.map((chunk) => ({ chunk, block: renderChunkBlock(chunk) }));
  const first = rendered[0];
  if (!first) {
    return { text: '', included: [], dropped: dedupeDropped, budgetExceeded: false };
  }

  const firstTokens = estimateTokens(first.block);
  const budgetExceeded = firstTokens > tokenBudget;

  const included = [first];
  let usedTokens = firstTokens;

  for (let i = 1; i < rendered.length; i++) {
    const next = rendered[i];
    if (!next) continue;
    const blockTokens = estimateTokens(next.block);
    if (usedTokens + blockTokens > tokenBudget) break;
    included.push(next);
    usedTokens += blockTokens;
  }

  const budgetDropped = rendered.slice(included.length).map((r) => r.chunk);

  return {
    text: included.map((r) => r.block).join('\n\n'),
    included: included.map((r) => r.chunk),
    dropped: [...dedupeDropped, ...budgetDropped],
    budgetExceeded,
  };
}
