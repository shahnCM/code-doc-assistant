# Code Documentation Assistant

RAG over TypeScript codebases. AST-level chunking via ts-morph, hybrid dense + lexical
retrieval in Postgres, answers cited back to `file:line`.

> **Protected files — never edit these without being asked explicitly:** `CLAUDE.md`,
> `README.md`, `BUILD-PLAN.md`, `.env`, `.mcp.json`, anything under `.claude/`. Their contents
> were verified against the running environment or written by hand. A `PreToolUse` hook blocks
> writes to them; if a change is genuinely needed, say so and let the human make it.
> Target ~200 lines; if this file grows past that, something belongs in a skill instead.

## Stack

TypeScript (strict, ESM) · Node 24.18.0 · Express 5 · React + Vite + Tailwind ·
Postgres 16 + pgvector 0.8.6 · Gemini (`gemini-embedding-2` 768d, `gemini-3.6-flash`) ·
vitest · pino

## Commands

```
npm test              vitest run          (never bare `vitest` — watch mode hangs hooks/CI)
npm run typecheck     tsc --noEmit for both server and client configs
npm run lint          eslint
npm run ingest        index a repo:  -- --repo ./tmp/hono
npm run eval          retrieval eval against evals/golden.json
npm run migrate       node-pg-migrate up
```

API on `:8080`. Vite dev server on `:5173`. Run `npm run migrate` before the first ingest —
the schema is not created at boot.

## Environment

Development runs **inside the `workstation` container** (VS Code attached, user `dev`,
project at `/projects/code-doc-assistant`). This is settled — do not offer host-side variants.

- `DATABASE_URL` is always `postgres://admin:admin@postgres-16:5432/codedocs`. Read it from
  `.env`; never hardcode a host or port.
- There is no docker CLI in this container. Use `psql -h postgres-16 -U admin` directly.
  Anything needing `docker compose` is run by the human in a host terminal.
- Embeddings and generation both go through **Google Gemini** (`@google/genai`), read from
  `GEMINI_API_KEY` — one provider, one key, free tier. Do NOT import `openai` or
  `@anthropic-ai/sdk`; neither is a dependency of this project.
- Verified models: `gemini-embedding-2` (768 dims, auto-normalized) and `gemini-3.6-flash`.
  Both read from `.env` (`EMBED_MODEL`, `GEN_MODEL`) — never hardcode an id. Model availability
  differs by account age; `gemini-2.5-flash` already 404s for new keys, so a grader's list will
  not match yours.
- Gemini's free tier is rate-limited by RPM/RPD as well as tokens. Embedding batches can run
  concurrently (TPM headroom is large); generation calls in a loop — eval sweeps especially —
  must be paced or they 429.
- Ports 8000-8099, 3000-3010 and 5173-5180 are published to the host. Servers must bind
  `0.0.0.0`, not localhost, or the published port never reaches the browser.
- pgvector 0.8.6 confirmed in the dev database (`SELECT extversion FROM pg_extension`).

## Architecture

```
src/ingest/     walk files → ts-morph parse → declaration chunks → enrichment headers
src/index/      embed (cached by contentHash) → pgvector + tsvector
src/retrieve/   dense + lexical → RRF fusion → call-graph expansion
src/generate/   context assembly → LLM → citation parsing/validation
src/server/     express routes, SSE streaming
src/web/        react client (own tsconfig — browser lib, bundler resolution)
src/shared/     types ONLY — zero runtime, imported by both server and client
src/config.ts   env parsing (process.env, zod) — Node-only, never imported from src/web
src/logger.ts   pino — Node-only, never imported from src/web
```

Two paths only: **ingest** (offline, CLI) and **query** (online, API). Keep them separate;
nothing in `src/retrieve/` may import from `src/ingest/`.

One package, two entry points. Root `tsconfig.json` covers server + shared and excludes
`src/web`; `src/web/tsconfig.json` extends it for the client. `npm run typecheck` runs both.

## Conventions

- ESM throughout. `module: nodenext`. Relative imports carry the `.js` extension even when
  the file on disk is `.ts` — `import { chunk } from './chunker.js'`.
- `src/shared/` compiles under both tsconfigs, so it holds **types only** — no runtime code at
  all. No `process`, no `document`, no `fs`, no imports of anything Node- or browser-specific.
  Runtime helpers that need env or a logger go in `src/config.ts` / `src/logger.ts`.
- No `any`. No non-null assertions. Discriminated unions over optional-field soup.
- `noUncheckedIndexedAccess` is on. Array access returns `T | undefined`; handle it.
- All shared shapes live in `src/shared/types.ts`. Never redeclare a shape locally, and never
  create a second types file inside a feature folder.
- Errors return `Result<T, E>`; only the Express error boundary throws.
- Tests sit beside source as `*.test.ts`. Fixtures in `tests/fixtures/`.
- No inline comments unless the *why* is non-obvious. Never comment the *what*.
- Conventional commits. One idea per commit.

## Gotchas

- Express 5: async handlers forward rejections natively. Do NOT write try/catch + `next(err)`.
- Express 5 dropped regex sub-expressions in paths — `/:id(\d+)` no longer parses.
- SSE: exclude `/api/chat` from compression middleware or the stream buffers and never flushes.
  Always `res.flushHeaders()` and clean up on `req.on('close')`.
- Cancellation: `res.on('close')` fires on success too. Only abort when `!res.writableFinished`.
- `AbortError` is a normal outcome, not a 500. Classify it before the error handler sees it.
- `node-postgres` ignores `AbortSignal`. Check `signal.aborted` before issuing a query.
- `@google/genai` is NOT the old `@google/generative-ai`. There is no `getGenerativeModel()` and
  no `model.generateContent()`. It is always `const ai = new GoogleGenAI({})` then
  `ai.models.generateContent(...)` / `ai.models.generateContentStream(...)`, with settings in
  `config: {}`, not a separate `generationConfig`. Training data is full of the old shape —
  if you find yourself writing `getGenerativeModel`, stop and check the docs.
- `new GoogleGenAI({})` picks up `GEMINI_API_KEY` from the environment automatically in Node.
- Gemini's `abortSignal` is **client-side only**. Aborting stops us reading the stream; the
  service keeps generating and still bills the tokens. Same shape as the `node-postgres`
  limitation above — say so in the trace and the README rather than implying a true cancel.
- Never `res.json()` a large payload — `JSON.stringify` is synchronous and blocks the loop.
  Trace data goes down the SSE stream.
- ts-morph parsing is synchronous CPU work. It belongs in the ingest CLI, never in a request
  handler.
- Vite dev server needs `--host 0.0.0.0` (or `server.host: true`). Express defaults are fine.
- pgvector cosine is `<=>`. `<->` is L2 and will silently return worse results.
- ts-morph: use `getStructure()` for signatures, not `getText()` — the latter drags in trivia.
- Migration 001 must `CREATE EXTENSION IF NOT EXISTS vector`. The dev database already has it;
  a grader's fresh container does not.
- Embedding dims live in one config constant, read by the migration. `outputDimensionality`
  must be sent **per request** — omit it and you silently get 3072-dim vectors and a
  `different vector dimensions` error from pgvector on insert.
- **`gemini-embedding-2` aggregates a list of plain strings into ONE embedding.** Passing
  `contents: ['a','b','c']` returns 1 vector, not 3 — silently, no error. Every batch call must
  wrap each item: `contents: texts.map(t => ({ parts: [{ text: t }] }))`. Verified: wrapped
  returns 3, and response order matches input order.
- Response shape is `res.embeddings[i].values`, not `res.embedding.values`.
- `gemini-embedding-2` auto-normalizes at 768 (L2 norm measured at 1.0000), so no manual
  normalization step. `gemini-embedding-001` would need one — another reason not to swap the
  model id without re-checking.
- Embedding calls burn free-tier request budget. Always check the contentHash cache first.
- The demo corpus lives in `./tmp/` and is gitignored. Never index `node_modules`.
- Never `docker compose down -v` — that deletes `volumes/vol-postgres-16`.

## Rules

- Write the test before the implementation. Always.
- Work one slice of the current `plans/NN-name.md` at a time. Do not start the next slice
  unprompted.
- Stop when `npm test` and `npm run typecheck` are both clean.
- Do not add a dependency without asking first. This has already been used to decline tRPC
  and Next.js — the bar is real.
- Do not touch `README.md` — I write that myself. Same for the other protected files listed at
  the top. The hook will stop you; treat that as the answer, not an obstacle to route around.