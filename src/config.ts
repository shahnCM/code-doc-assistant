import { z } from 'zod';
import type { Result } from './shared/types.js';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  EMBED_MODEL: z.string().min(1),
  GEN_MODEL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(8080),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Result<Env, string> {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return { ok: false, error: message };
  }
  return { ok: true, value: parsed.data };
}
