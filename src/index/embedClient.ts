import { GoogleGenAI } from '@google/genai';
import type { Result } from '../shared/types.js';
import { EMBEDDING_DIM } from './constants.js';

export interface EmbedError {
  kind: 'rate-limit' | 'other';
  message: string;
}

export interface EmbedClient {
  embedBatch(texts: readonly string[]): Promise<Result<number[][], EmbedError>>;
}

export interface GenAILike {
  models: {
    embedContent(args: {
      model: string;
      contents: Array<{ parts: Array<{ text: string }> }>;
      config: { outputDimensionality: number };
    }): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
  };
}

function classifyEmbedError(error: unknown): EmbedError {
  const message = error instanceof Error ? error.message : String(error);
  const isRateLimit = /429|RESOURCE_EXHAUSTED/i.test(message);
  return { kind: isRateLimit ? 'rate-limit' : 'other', message };
}

export function createGeminiEmbedClient(ai: GenAILike, model: string): EmbedClient {
  return {
    async embedBatch(texts) {
      try {
        const res = await ai.models.embedContent({
          model,
          contents: texts.map((text) => ({ parts: [{ text }] })),
          config: { outputDimensionality: EMBEDDING_DIM },
        });
        const embeddings = res.embeddings;
        if (!embeddings) {
          return { ok: false, error: { kind: 'other', message: 'embedContent returned no embeddings' } };
        }
        const values: number[][] = [];
        for (const embedding of embeddings) {
          if (!embedding.values) {
            return { ok: false, error: { kind: 'other', message: 'embedContent returned an embedding with no values' } };
          }
          values.push(embedding.values);
        }
        return { ok: true, value: values };
      } catch (error) {
        return { ok: false, error: classifyEmbedError(error) };
      }
    },
  };
}

export function realEmbedClient(model: string): EmbedClient {
  return createGeminiEmbedClient(new GoogleGenAI({}), model);
}
