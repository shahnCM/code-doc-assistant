# Code Documentation Assistant

RAG over TypeScript codebases. AST-level chunking via ts-morph, hybrid dense + lexical
retrieval in Postgres, answers cited back to `file:line`.

> Run `/init`, then reconcile with this file — keep this version's facts where they conflict,
> they were verified against the running environment. Delete anything that stops being true.
> Target ~200 lines; if it grows past that, something belongs in a skill instead.

## Stack

TypeScript (strict, ESM) · Node 24.18.0 · Express 5 · React + Vite + Tailwind ·
Postgres 16 + pgvector 0.8.6 · vitest · pino

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
src/shared/     types, config, logger — single source of truth for shapes
```

Two paths only: **ingest** (offline, CLI) and **query** (online, API). Keep them separate;
nothing in `src/retrieve/` may import from `src/ingest/`.

One package, two entry points. Root `tsconfig.json` covers server + shared and excludes
`src/web`; `src/web/tsconfig.json` extends it for the client. `npm run typecheck` runs both.

## Conventions

- ESM throughout. `module: nodenext`. Relative imports carry the `.js` extension even when
  the file on disk is `.ts` — `import { chunk } from './chunker.js'`.
- `src/shared/` compiles under both tsconfigs, so it must stay free of DOM types *and*
  Node-only globals. No `process`, no `document`, no `fs`.
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
- Never `res.json()` a large payload — `JSON.stringify` is synchronous and blocks the loop.
  Trace data goes down the SSE stream.
- ts-morph parsing is synchronous CPU work. It belongs in the ingest CLI, never in a request
  handler.
- Vite dev server needs `--host 0.0.0.0` (or `server.host: true`). Express defaults are fine.
- pgvector cosine is `<=>`. `<->` is L2 and will silently return worse results.
- ts-morph: use `getStructure()` for signatures, not `getText()` — the latter drags in trivia.
- Migration 001 must `CREATE EXTENSION IF NOT EXISTS vector`. The dev database already has it;
  a grader's fresh container does not.
- Embedding dims live in one config constant, read by the migration. Never hardcode 1536.
- Embeddings cost money. Always check the contentHash cache before calling the API.
- The demo corpus lives in `./tmp/` and is gitignored. Never index `node_modules`.
- Never `docker compose down -v` — that deletes `volumes/vol-postgres-16`.

## Rules

- Write the test before the implementation. Always.
- Work one slice of the current `plans/NN-name.md` at a time. Do not start the next slice
  unprompted.
- Stop when `npm test` and `npm run typecheck` are both clean.
- Do not add a dependency without asking first. This has already been used to decline tRPC
  and Next.js — the bar is real.
- Do not touch `README.md` — I write that myself.
