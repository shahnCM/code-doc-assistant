import type { Db } from '../index/db.js';
import type { EmbedClient } from '../index/embedClient.js';
import { searchChunks } from '../retrieve/search.js';
import type { AssembledChunkTrace, ChatEvent, ChatMessage } from '../shared/types.js';
import { assembleContext } from './assemble.js';
import { parseCitations, validateCitations } from './citations.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, realGenClient, type GenClient } from './llmClient.js';
import { buildContents, buildSystemPrompt, REFUSAL_SENTENCE } from './prompt.js';
import { estimateTokens } from '../tokens.js';

const CANCEL_NOTE =
  'Cancellation is best-effort: aborting stops us reading further output, but the ' +
  'service may keep generating (and billing) regardless.';

export interface AnswerRequest {
  messages: ChatMessage[];
  repoSource?: string;
  topK?: number;
  signal?: AbortSignal;
}

export interface AnswerDeps {
  connectionString: string;
  embedModel: string;
  genModel: string;
  db?: Db;
  embedClient?: EmbedClient;
  genClient?: GenClient;
  tokenBudget?: number;
}

function lastUserMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user') return message;
  }
  return undefined;
}

export async function* answerQuestion(
  request: AnswerRequest,
  deps: AnswerDeps,
): AsyncGenerator<ChatEvent, void, undefined> {
  const startedAt = Date.now();
  const genClient = deps.genClient ?? realGenClient(deps.genModel);

  const question = lastUserMessage(request.messages);
  if (!question) {
    yield { type: 'error', message: 'no user message to answer' };
    return;
  }

  const retrieveStarted = Date.now();
  const searchResult = await searchChunks(question.content, deps.connectionString, deps.embedModel, {
    ...(request.repoSource !== undefined ? { repoSource: request.repoSource } : {}),
    ...(request.topK !== undefined ? { topK: request.topK } : {}),
    ...(deps.db !== undefined ? { db: deps.db } : {}),
    ...(deps.embedClient !== undefined ? { embedClient: deps.embedClient } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });
  const retrieveMs = Date.now() - retrieveStarted;

  if (!searchResult.ok) {
    if (searchResult.error.kind === 'aborted') {
      yield { type: 'cancelled', elapsedMs: Date.now() - startedAt, estimatedTokensNotGenerated: 0, note: CANCEL_NOTE };
      return;
    }
    yield { type: 'error', message: searchResult.error.message };
    return;
  }

  const retrieved = searchResult.value;
  const assembled = assembleContext(
    retrieved,
    deps.tokenBudget !== undefined ? { tokenBudget: deps.tokenBudget } : {},
  );

  const includedIds = new Set(assembled.included.map((chunk) => chunk.id));
  const trace: AssembledChunkTrace[] = retrieved.map((chunk) => ({
    id: chunk.id,
    filePath: chunk.filePath,
    symbolName: chunk.symbolName,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    language: chunk.language,
    chunkerKind: chunk.chunkerKind,
    denseRank: chunk.denseRank,
    lexicalRank: chunk.lexicalRank,
    fusedScore: chunk.fusedScore,
    included: includedIds.has(chunk.id),
  }));

  yield { type: 'trace', chunks: trace, retrieveMs, contextTokens: estimateTokens(assembled.text) };

  if (assembled.included.length === 0) {
    yield { type: 'token', text: REFUSAL_SENTENCE };
    yield { type: 'citations', valid: [], invalid: [] };
    yield { type: 'done', finishReason: 'REFUSED', generateMs: 0, totalMs: Date.now() - startedAt };
    return;
  }

  const contents = buildContents(request.messages, assembled.text);
  const systemInstruction = buildSystemPrompt();

  const generateStarted = Date.now();
  let accumulatedText = '';
  let finishReason = 'STOP';
  let cancelled = false;

  const streamParams = {
    systemInstruction,
    contents,
    ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
  };

  for await (const chunkResult of genClient.stream(streamParams)) {
    if (!chunkResult.ok) {
      if (chunkResult.error.kind === 'aborted') {
        cancelled = true;
        break;
      }
      yield { type: 'error', message: chunkResult.error.message };
      return;
    }
    accumulatedText += chunkResult.value.text;
    finishReason = chunkResult.value.finishReason ?? finishReason;
    if (chunkResult.value.text) {
      yield { type: 'token', text: chunkResult.value.text };
    }
  }

  if (cancelled) {
    const estimatedTokensNotGenerated = Math.max(0, DEFAULT_MAX_OUTPUT_TOKENS - estimateTokens(accumulatedText));
    yield {
      type: 'cancelled',
      elapsedMs: Date.now() - startedAt,
      estimatedTokensNotGenerated,
      note: CANCEL_NOTE,
    };
    return;
  }

  const citations = parseCitations(accumulatedText);
  const validation = validateCitations(citations, assembled.included);
  yield { type: 'citations', valid: validation.valid, invalid: validation.invalid };

  yield {
    type: 'done',
    finishReason,
    generateMs: Date.now() - generateStarted,
    totalMs: Date.now() - startedAt,
  };
}
