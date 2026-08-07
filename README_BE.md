# Backend Architecture — code-doc-assistant

Contributor-facing doc for the server/RAG pipeline. Distinct from [`README.md`](README.md)
(human-authored, product-facing) and [`CLAUDE.md`](CLAUDE.md) (the house style guide read by
the assistant). This file covers: how the pieces fit together, how to work on one domain
without understanding the whole system, what's practically improvable, what's deliberately
deferred, and a concrete design proposal for making the AI provider layer pluggable.

Everything here was verified against the code at time of writing (Block 4 complete, Block 5
not started). Line numbers will drift — treat them as "look here," not as guarantees.

## 1. Architecture overview

Two paths, kept deliberately separate — `src/retrieve/` never imports `src/ingest/`:

```
                    OFFLINE (CLI, npm run ingest)
┌──────────────────────────────────────────────────────────────────────┐
│ acquire → walk → classify → chunk (ts-morph | generic) → enrich       │
│                                                     │                  │
│                                                     ▼                  │
│                                     embed (content-hash cache) → store │
└──────────────────────────────────────────────────────────────────────┘
                              Postgres + pgvector
┌──────────────────────────────────────────────────────────────────────┐
│  search (dense + lexical → RRF fusion) → assemble (token budget)      │
│       → prompt → Gemini stream → citation validation → SSE            │
└──────────────────────────────────────────────────────────────────────┘
                    ONLINE (Express API, npm run serve)
```

Five domains, plus crosscutting Node-only leaves and one zero-runtime types module:

```
src/ingest/     offline: acquire (local path | git clone) → walk → language router
                  ├ .ts/.tsx/.js/.jsx/.mts/.cts → ts-morph → declaration chunks
                  └ everything else             → generic structural chunker
                → enrichment headers (identical Chunk shape from both paths)
src/index/      embed (cached by contentHash) → pgvector + tsvector storage
src/retrieve/   dense + lexical → RRF fusion → /api/source range reconstruction
src/generate/   context assembly → Gemini stream → citation parsing/validation
src/server/     Express routes, SSE streaming, bootstrap
src/shared/     types.ts — zero runtime, imported by both server and client
src/config.ts   env parsing (zod) — Node-only, never imported from src/web
src/logger.ts   pino — Node-only, never imported from src/web
src/tokens.ts   estimateTokens — pure, no I/O, used by both ingest and generate
src/web/        React client — not yet built (Block 5); only tsconfig.json exists today
```

## 2. Domain tour

**`src/ingest/`** — `cli.ts` is the entry point (`npm run ingest -- --repo <path-or-url>`).
`acquire.ts` resolves a local path or `git clone --depth 1`s a public HTTPS URL into `./tmp/`.
`walk.ts` enumerates files, skipping `node_modules`, `.git`, lockfiles, binaries, anything over
1MB. `classify.ts` routes by file extension only (no content sniffing). `chunkers/ts-morph.ts`
produces AST-level declaration chunks for TS/JS; `chunkers/generic.ts` produces structural
chunks (`kind: 'block'`, `signature`/`jsDoc` left `null`) for everything else — both emit the
identical `Chunk` shape from `shared/types.ts`, so nothing downstream branches on which
chunker ran (that fact lives only in `chunkerKind`). `enrich.ts` adds headers; `hash.ts`
computes the content hash used for embedding-cache keys. `pipeline.ts` orchestrates the whole
run and calls into `src/index/embed.ts`.

**`src/index/`** — `embed.ts`'s `indexChunks()` groups chunks by content hash, checks
`cache.ts`'s `EmbedCache` (disk cache in `.cache/embeddings/`, keyed by hash + model) before
calling out, batches cache misses through `batch.ts`'s `embedTexts()` (concurrency + retry with
server-suggested backoff), and calls `store.ts`'s `upsertChunks()` to write pgvector rows +
`tsvector` lexical columns via `db.ts`'s `Db`/`PgDb`. `embedClient.ts` is the Gemini adapter
(see §9 for why this is the extension point for other providers). `constants.ts` holds
`EMBEDDING_DIM`.

**`src/retrieve/`** — `search.ts`'s `searchChunks()` embeds the query, then runs `fusion.ts`'s
`HYBRID_SQL` (dense `<=>` cosine + lexical `tsvector`, combined by Reciprocal Rank Fusion) to
return `RetrievedChunk[]` carrying `denseRank`/`lexicalRank`/`fusedScore`. `source.ts`'s
`fetchSourceRange()` backs `GET /api/source` — reconstructs a line range from stored chunks
only (no filesystem access), reporting `gaps` explicitly rather than pretending a file is
contiguous.

**`src/generate/`** — `assemble.ts`'s `assembleContext()` dedupes retrieved chunks by file,
orders by `fusedScore`, and truncates whole blocks from the tail against a token budget
(`estimateTokens` from `src/tokens.ts`). `prompt.ts` builds the system instruction (citation
format + refusal sentence) and renders history (capped at `MAX_HISTORY_TURNS = 8`, prompt.ts:4)
into Gemini's `Content[]` shape. `llmClient.ts` is the streaming Gemini adapter (see §9).
`citations.ts` parses `path:line-line` references from model output and validates them by
**containment** against the **included** (not merely retrieved) chunks. `answer.ts`'s
`answerQuestion()` is an `AsyncGenerator<ChatEvent>` orchestrating all of the above:
`trace → token* → citations → done`, or a direct refusal on empty retrieval (no LLM call), or
`cancelled` on abort.

**`src/server/`** — `app.ts`'s `createApp()` wires `express.json()`, `/health`, `/ready`,
`POST /api/chat`, `GET /api/source`, and one error boundary. `routes/chat.ts` validates the
body with zod, opens an SSE stream (`sse.ts`), threads one `AbortSignal` (client abort +
30s timeout) into `answerQuestion()`, and classifies `AbortError` before it can reach the error
boundary as a 500. `index.ts`'s `startServer()` is the testable bootstrap (everything
injectable — `env`, `dbFactory`, `embedClient`, `genClient`) with a thin top-level guard for
the real process, binding `0.0.0.0` per CLAUDE.md's port-publishing requirement.

## 3. Request/data lifecycle walkthroughs

**Ingest** (`npm run ingest -- --repo ./tmp/hono`): `cli.ts` parses argv →
`acquire.ts` resolves/clones the repo → `walk.ts` lists candidate files → `classify.ts` +
`chunkers/index.ts` route each file to ts-morph or generic → `enrich.ts` adds headers,
`hash.ts` computes `contentHash` → `pipeline.ts` collects all `Chunk[]` → `index/embed.ts`'s
`indexChunks()` checks the disk cache, batches misses through `index/batch.ts` to Gemini,
writes cache entries → `index/store.ts`'s `upsertChunks()` writes pgvector + tsvector rows via
`index/db.ts`.

**Chat** (`POST /api/chat`): `server/routes/chat.ts` zod-validates the body, builds an
`AbortSignal.any([clientAbort, timeout(30s)])`, opens SSE → `generate/answer.ts`'s
`answerQuestion()` calls `retrieve/search.ts`'s `searchChunks()` (embeds the query via
`index/embedClient.ts`, runs `retrieve/fusion.ts`'s hybrid SQL) → yields a `trace` event →
`generate/assemble.ts` builds token-budgeted context → `generate/prompt.ts` builds the
contents → `generate/llmClient.ts` streams from Gemini, yielding `token` events →
`generate/citations.ts` parses and validates citations against included chunks → yields
`citations` then `done` → `server/sse.ts` serializes every event as one `data: <JSON>\n\n`
frame.

## 4. Environment & configuration

Current `EnvSchema` (`src/config.ts`):

| Var | Type | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | `string` | — | `postgres://admin:admin@postgres-16:5432/codedocs` in this container |
| `GEMINI_API_KEY` | `string` | — | The one provider-specific key, currently unconditional (see §9) |
| `EMBED_MODEL` | `string` | — | e.g. `gemini-embedding-2` — already provider-agnostic by name |
| `GEN_MODEL` | `string` | — | e.g. `gemini-3.6-flash` — already provider-agnostic by name |
| `PORT` | `number` | `8080` | Must be in the host's published range (`8000-8099`) to be reachable |

§9 proposes adding `EMBED_PROVIDER`/`GEN_PROVIDER` (default `gemini`) so the core schema grows
only by provider *name*, never by provider-specific keys like `GEMINI_API_KEY`.

## 5. How to work on just one domain

Every domain boundary in this codebase is crossed through a narrow structural interface with
an optional-injected default — `Db`, `EmbedClient`, `GenClient`, `EmbedCache`. Isolating a
slice is never "mock a module" (no `vi.mock` anywhere in the suite); it's "pass a different
value for an already-optional parameter." That's what makes each row below testable alone.

| Want to touch | The seam that isolates it | Files to read | Proves it works |
|---|---|---|---|
| AST / chunking | The `Chunk` shape (`shared/types.ts`) is the entire contract with the rest of the system; chunkers are pure functions over file content — no DB, no network | `src/ingest/chunkers/`, `enrich.ts`, `classify.ts` | `npx vitest run src/ingest` — no Postgres, no Gemini key needed |
| Storage / embedding | `EmbedClient` (`embedClient.ts`) and `Db` (`db.ts`) are both injectable, both have hand-rolled test fakes | `src/index/embedClient.ts`, `batch.ts`, `cache.ts`, `store.ts`, `embed.ts` | `npx vitest run src/index`; `npm run test:db` only if touching `store.ts`'s real-Postgres path |
| Retrieval | `RetrieveOptions`/`fusion.ts`'s SQL builder is the seam between ranking logic and the `Db` it runs against; `SearchOptions.embedClient` decouples it from a live embed call | `src/retrieve/fusion.ts`, `search.ts`, `source.ts` | `npx vitest run src/retrieve/fusion.test.ts src/retrieve/search.test.ts` (pure); `npm run test:db` for `fusion.db.test.ts` |
| Serving / API | `AppDeps`/`ChatRouteDeps` take `Db`/`EmbedClient`/`GenClient` as injected fakes; nothing in `src/server/` talks to Gemini or Postgres directly | `src/server/app.ts`, `routes/*.ts`, `sse.ts` | `npx vitest run src/server` — fully faked deps, no live Gemini or Postgres |

Hard boundary to remember: `src/retrieve/` must never import `src/ingest/` (this is why
`estimateTokens` lives in the shared `src/tokens.ts` rather than under `src/ingest/`).

## 6. Testing strategy

- `npm test` — offline vitest suite (`vitest run --passWithNoTests`), no database, no network.
  Run this for any change.
- `npm run test:db` — loads `.env`, runs `vitest.db.config.ts` against the live Postgres
  container (`fileParallelism: false` — fixtures share one seeded table). Run when touching
  `store.ts`, `fusion.ts`'s DB-integration test, or anything issuing real SQL.
- `npm run typecheck` — `tsc --noEmit` for both the root (server + shared) and
  `src/web/tsconfig.json` (client) configs. Always run both before considering a change done.
- `npm run lint` — currently **broken** (`eslint.config.js` doesn't exist yet); do not treat
  its absence from a verification gate as an oversight.
- An `npm run eval` script (retrieval quality against a golden set) is described in
  `BUILD-PLAN.md` as Block 7 scope but **does not exist in `package.json` yet** — don't assume
  it runs today.

## 7. What's practically improvable

Concrete, code-grounded — not generic advice:

1. **Duplicated retry/error classification.** `classifyEmbedError`
   (`src/index/embedClient.ts:38-56`) and `classifyGenError`
   (`src/generate/llmClient.ts:63-80`) are near-identical: same `AbortError` check, same
   `429|RESOURCE_EXHAUSTED` regex, same `PerDay` split, same `retryDelay` parse
   (`parseRetryAfterMs`, duplicated verbatim in both files). One is a copy-paste of the other.
2. **Query embeddings are uncached on the hot path.** `EmbedCache` (`src/index/cache.ts`) is
   wired into `indexChunks()` only (`src/index/embed.ts:69,92`). `searchChunks()`
   (`src/retrieve/search.ts:79`) calls `embedClient.embedBatch([query])` fresh on every
   `/api/chat` request — a repeated or near-identical question re-embeds every time, unlike
   ingestion, which never re-embeds unchanged content.
3. **History cap is turn-count, not token-aware.** `MAX_HISTORY_TURNS = 8`
   (`src/generate/prompt.ts:4`) truncates by message count. Contrast with `assemble.ts`'s
   retrieved-context budget, which is genuinely token-counted via `estimateTokens`. Eight long
   turns can still blow a real token budget that eight short ones wouldn't.
4. **`GEMINI_API_KEY` is unconditionally required in the core `EnvSchema`**
   (`src/config.ts:6`), even though `EMBED_MODEL`/`GEN_MODEL` beside it were already named
   provider-agnostically. §9 removes this.
5. **Gemini instantiation is hardcoded inside the convenience wrapper, not the interface** —
   `new GoogleGenAI({})` at `embedClient.ts:90` and `llmClient.ts:149`. Everything upstream
   (`embed.ts`, `search.ts`, `answer.ts`, every route) already depends only on the narrow
   `EmbedClient`/`GenClient` interfaces, so this is a small, contained change (§9).
6. **Retry orchestration is already provider-agnostic**, and that's worth stating as a
   positive: `src/index/batch.ts`'s `embedBatchWithRetry`/`computeRetryDelayMs` depend only on
   `EmbedError.kind`/`retryAfterMs`, never anything Gemini-specific. A second provider needs
   zero changes there — only an honest `classify` function.

## 8. What's deliberately deferred, not a bug

- **Query-embedding caching is ingestion-only by design, today** (see §7.2). A query-side
  cache — keyed by normalized query text, on its own lifecycle separate from the content-hash
  ingest cache — is a scoped, well-understood follow-up, not an oversight.
- **`GET /api/source` is DB-backed, not repo-backed**, and reconstructs from stored chunks
  only (no filesystem access — works after `./tmp` is cleaned, works for remote repos, no
  path-traversal surface). On ts-morph-chunked repos this is lossy between declarations; the
  response's `gaps` array reports this explicitly and it must never render as contiguous.
- **Cancellation is client-side-only / best-effort on both axes.** Gemini's `abortSignal` stops
  us reading the stream, but the service may keep generating and still bills the tokens.
  `node-postgres` ignores `AbortSignal` outright — `src/retrieve/search.ts:91` only checks
  `signal.aborted` immediately before issuing the query. Neither is a true server-side cancel;
  the `cancelled` SSE event says so in words rather than implying one.
- **Call-graph expansion (`symbol_edges`) is TS/JS-only, by design.** Generic-chunked repos get
  retrieval without expansion — a defined, narrower feature, not a broken one.
- **Repo acquisition is public HTTPS `git clone --depth 1` only**, no auth, no SSH. Private
  repos are explicitly what local-path mode is for, not a half-implemented token flow.
- **Language routing is by file extension only**, no content sniffing or shebang parsing — a
  deliberate, cheap, right-often-enough heuristic.

## 9. LLD: pluggable AI provider layer

**This is a design proposal, not implemented.** Nothing in this section has been built —
`@google/genai` is still the only provider dependency, and adding another SDK is a separate
conversation per CLAUDE.md's "do not add a dependency without asking first" rule (the same bar
that already declined tRPC and Next.js).

### 9.1 The pattern to mirror, not reinvent

This codebase already uses one DI idiom three times — narrow structural interface, a
`create*(dependency, model)` factory that takes the client as a parameter, and a `real*()`
convenience wrapper that constructs the real thing:

- `src/index/db.ts` — `Db` interface, `createPgDb(connectionString)`.
- `src/index/embedClient.ts` — `EmbedClient`, `GenAILike` (structural, not the real SDK type),
  `createGeminiEmbedClient(ai, model)`, `realEmbedClient(model)`.
- `src/generate/llmClient.ts` — identical shape: `GenClient`, `createGeminiGenClient(ai, model)`,
  `realGenClient(model)`.

Every consumer (`embed.ts`, `search.ts`, `answer.ts`, `cli.ts`, `server/index.ts`, `app.ts`,
every route) already depends only on `EmbedClient`/`GenClient`/`Db` — never on Gemini directly.
The DI seam already exists; only the two `real*Client` wrappers hardcode the backend
(`embedClient.ts:89-91`, `llmClient.ts:148-150`). **`EmbedClient` and `GenClient` themselves
would not change** under this proposal — every existing call site keeps compiling unmodified.

### 9.2 Proposed file layout

```
src/providerRegistry.ts          NEW — cross-domain scaffolding, zero SDK deps:
                                  ProviderErrorKind, ProviderError, ErrorClassifier,
                                  ProviderModule<TClient>, ProviderRegistry<Name, TClient>

src/index/embedClient.ts         TRIMMED to: EmbedClient, EmbedError (= ProviderError alias),
                                  EmbedProviderName, embedProviderRegistry,
                                  realEmbedClient(model, provider)

src/index/providers/gemini.ts    NEW — everything Gemini-specific moved out of embedClient.ts:
                                  GenAILike, createGeminiEmbedClient, classify, envSchema

src/index/providers/openai.ts    FUTURE, NOT BUILT — same shape; adding it is a dependency
                                  conversation first (the openai SDK is not installed)

src/generate/llmClient.ts        TRIMMED, mirrors embedClient.ts

src/generate/providers/gemini.ts NEW — mirrors src/index/providers/gemini.ts

src/config.ts                    EXTENDED — EMBED_PROVIDER/GEN_PROVIDER enum (name only) in
                                  the core schema; loadEnv composes core + the selected
                                  provider's own env schema
```

This mirrors `src/ingest/chunkers/{ts-morph,generic}.ts` — a small directory per swappable
strategy sitting beside the domain that owns it, not a new cross-cutting top-level folder.

### 9.3 Shared contract

```ts
// src/providerRegistry.ts
export type ProviderErrorKind = 'rate-limit' | 'daily-quota' | 'aborted' | 'other';

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string;
  retryAfterMs?: number;
}

/** Contract each provider module's classify function must satisfy. Implementation is
 *  necessarily provider-specific — Gemini regex-parses a message string, a different SDK
 *  would read typed error subclasses or a Retry-After header — only the output shape is
 *  shared. */
export type ErrorClassifier = (error: unknown) => ProviderError;

export interface ProviderModule<TClient> {
  envSchema: import('zod').ZodTypeAny;
  create(model: string): TClient;
}

export type ProviderRegistry<Name extends string, TClient> = Record<Name, ProviderModule<TClient>>;
```

`EmbedError`/`GenError` become `type EmbedError = ProviderError` aliases — same name, same
import path, zero call-site churn, one canonical shape instead of two structurally-identical
declarations. Deliberately **not** shared: `parseRetryAfterMs` — Gemini's retry-after is a
regex over a JSON-shaped fragment inside `.message`; a different SDK's is typically a
`Retry-After` HTTP header or a typed field. Sharing the parser would mean sharing something
that isn't actually the same across providers.

### 9.4 Registry + `real*Client` (embed side; gen side mirrors it)

```ts
// src/index/embedClient.ts (trimmed)
import type { ProviderRegistry } from '../providerRegistry.js';
import { geminiEmbedProvider } from './providers/gemini.js';

export type EmbedProviderName = 'gemini'; // extend the union when a second provider ships

export interface EmbedClient {
  embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<Result<number[][], EmbedError>>;
}

const embedProviderRegistry: ProviderRegistry<EmbedProviderName, EmbedClient> = {
  gemini: geminiEmbedProvider,
};

export function realEmbedClient(model: string, provider: EmbedProviderName = 'gemini'): EmbedClient {
  return embedProviderRegistry[provider].create(model);
}
```

```ts
// src/index/providers/gemini.ts (new — moved wholesale from embedClient.ts)
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import type { ProviderError, ProviderModule } from '../../providerRegistry.js';
import type { EmbedClient } from '../embedClient.js';

export interface GenAILike { /* unchanged, moved as-is */ }
function classify(error: unknown): ProviderError { /* unchanged, moved as-is */ }
function createGeminiEmbedClient(ai: GenAILike, model: string): EmbedClient { /* unchanged, moved as-is */ }

export const geminiEmbedEnvSchema = z.object({ GEMINI_API_KEY: z.string().min(1) });

export const geminiEmbedProvider: ProviderModule<EmbedClient> = {
  envSchema: geminiEmbedEnvSchema,
  create: (model) => createGeminiEmbedClient(new GoogleGenAI({}), model),
};
```

The registry is a **plain, exhaustively-typed object literal**, not a class with
`.register()` — deliberately, to fit the house style (`noUncheckedIndexedAccess`,
discriminated unions over dynamic plugin systems). Indexing `embedProviderRegistry[provider]`
where `provider: EmbedProviderName` is exact, no `| undefined` — the compiler forces every
member of the `EmbedProviderName` union to have a matching registry key, so a provider name
added to the union without a registry entry is a compile error, not a silent runtime "unknown
provider." A refinement worth doing at implementation time: derive the zod enum in `config.ts`
from the registry's own keys, so the allow-list can't drift from the registry.

### 9.5 Threading the selection through (additive, non-breaking)

`embedProvider`/`genProvider` join the existing optional-override bags exactly the way
`embedClient`/`db`/`cache` already do — **not** a new positional parameter on
`indexChunks`/`searchChunks`, which would break well-tested call sites:

```ts
export interface IndexOptions {
  embedClient?: EmbedClient;
  embedProvider?: EmbedProviderName;   // NEW, defaults to 'gemini' inside the function
  cache?: EmbedCache;
  db?: Db;
  // ...unchanged
}

// inside indexChunks:
const embedClient = options.embedClient ?? realEmbedClient(embedModel, options.embedProvider ?? 'gemini');
```

Same shape for `SearchOptions` (`search.ts`) and `AnswerDeps` (`answer.ts`). Production wiring
flows exactly like `embedModel`/`genModel` already do: `config.EMBED_PROVIDER` →
`AppDeps.embedProvider` → `ChatRouteDeps.embedProvider` → `AnswerDeps.embedProvider` →
`searchChunks`'s options. Every call site that doesn't pass it keeps compiling and behaving
identically — "defaults to gemini, zero config changes" is literally true, not aspirational.

### 9.6 Env var scheme — keeping `EnvSchema` bounded

Today's `EnvSchema` unconditionally requires `GEMINI_API_KEY` — a provider-specific key living
in core config (§7.4). The fix: the core schema grows only by the **provider-name enum**, never
by provider-specific keys. Each provider module owns and validates its own env slice.

```ts
// src/config.ts (sketch)
const CoreEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  EMBED_MODEL: z.string().min(1),
  GEN_MODEL: z.string().min(1),
  EMBED_PROVIDER: z.enum(['gemini']).default('gemini'),   // grows by name only when a provider ships
  GEN_PROVIDER: z.enum(['gemini']).default('gemini'),
  PORT: z.coerce.number().int().positive().default(8080),
});

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Result<Env, string> {
  const core = CoreEnvSchema.safeParse(source);
  if (!core.success) return { ok: false, error: formatIssues(core.error) };

  const embedEnv = embedProviderRegistry[core.data.EMBED_PROVIDER].envSchema.safeParse(source);
  const genEnv = genProviderRegistry[core.data.GEN_PROVIDER].envSchema.safeParse(source);
  if (!embedEnv.success) return { ok: false, error: `EMBED_PROVIDER=${core.data.EMBED_PROVIDER}: ${formatIssues(embedEnv.error)}` };
  if (!genEnv.success) return { ok: false, error: `GEN_PROVIDER=${core.data.GEN_PROVIDER}: ${formatIssues(genEnv.error)}` };

  return { ok: true, value: { ...core.data, ...embedEnv.data, ...genEnv.data } };
}
```

Per-provider env vars a future provider module would define beside itself, never in
`config.ts`:

| Provider | Vars | Notes |
|---|---|---|
| `gemini` (today) | `GEMINI_API_KEY` | Moves from the core schema into `geminiEmbedEnvSchema`/`geminiGenEnvSchema`, required only when that provider is selected — no behavior change while both default to `gemini` |
| `openai` (future, not built) | `OPENAI_API_KEY`, `OPENAI_BASE_URL?` | `OPENAI_BASE_URL` optional, covers self-hosted/Azure-style endpoints without a separate schema; model name still comes from the existing `EMBED_MODEL`/`GEN_MODEL` vars, not a provider-specific model var, since those are already provider-agnostic |

Fail-fast still happens once at startup (`loadEnv` runs once in `server/index.ts`/`cli.ts`, not
per-request), and an unselected provider's missing keys are never an error — a `.env` with no
`OPENAI_API_KEY` is fine as long as `EMBED_PROVIDER=gemini`.

### 9.7 What this design explicitly does not do

- Does **not** add `openai` or any other SDK as a dependency. The `providers/openai.ts` files
  above are shown only as the shape a future module would take; actually adding one is a
  separate ask per CLAUDE.md's dependency rule.
- Does **not** change `EmbedClient`/`GenClient`/`Result<T,E>` — the entire retrieval, indexing,
  and generation pipeline is untouched; only the two `real*Client` factories and `config.ts`'s
  env composition change.
- Does **not** introduce a dynamic/runtime-registerable plugin system — the registry is a
  closed, compile-time-checked object literal, consistent with "discriminated unions over
  optional-field soup."
- Does **not** unify `EMBED_PROVIDER` and `GEN_PROVIDER` into one setting — they're independent
  axes on purpose (e.g. embed via one backend, generate via another), matching that
  `EMBED_MODEL`/`GEN_MODEL` are already independent today.
