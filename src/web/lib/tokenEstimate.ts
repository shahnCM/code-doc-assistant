import { estimateTokens } from '../../tokens.js';

// Pinned to DEFAULT_MAX_OUTPUT_TOKENS in src/generate/llmClient.ts:5 — the client can never
// receive the server's own `cancelled` event on a client-initiated Stop (plans/05-frontend.md,
// Verified 7), so this mirrors its formula locally rather than reading a value off the wire.
const MIRRORED_MAX_OUTPUT_TOKENS = 2048;

export function estimateTokensNotGenerated(accumulatedText: string): number {
  return Math.max(0, MIRRORED_MAX_OUTPUT_TOKENS - estimateTokens(accumulatedText));
}
