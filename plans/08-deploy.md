# Block 8 — Deployment ready

## Context

Blocks 1-5 close the whole online + UI path; the app only runs today via `tsx` against the dev
container's `postgres-16` Postgres and a hand-run `npm run migrate`. Nothing packages it for
anyone who isn't inside this exact dev container. Block 6 (call-graph expansion) and Block 7
(query routing + evals) are explicitly skipped by the human's decision. Block 8 makes
`docker compose up` alone — from a clean clone, `.env.example` copied to `.env`, Gemini key
filled in — bring up a fully working, ready-to-query app: build, migrate, serve, healthcheck,
graceful shutdown, and CI. Block 9 (README + screenshots) depends on this working end to end.

Planned and executed as **one slice** per the human's instruction — no per-sub-step pauses for
confirmation — but landed as several small conventional commits at natural boundaries (build
step; health/shutdown; Docker; compose; CI), each still "one idea," rather than one giant commit.

## Verified before planning (read the actual source, not recalled)

1. **`src/config.ts`** already zod-validates `DATABASE_URL`, `GEMINI_API_KEY`, `EMBED_MODEL`,
   `GEN_MODEL`, `PORT` (default 8080) via `loadEnv()` → `Result<Env,string>`, and **already names
   the missing var** in the error message. `src/config.test.ts` already has a test asserting
   exactly this (`toContain('GEMINI_API_KEY')`). **The TESTS bullet "env validation rejects a
   missing key" is already satisfied — no new work needed there**, just confirmed by re-running
   the existing suite.
2. **`/health` and `/ready` already exist** (`src/server/routes/health.ts`, wired in `app.ts:23-24`).
   `/health` is a bare `{status:'ok'}` liveness check. `/ready` currently only runs `SELECT 1` —
   it does **not** check migrations. No `health.test.ts` exists yet. The TESTS bullet "`/ready`
   returns 503 when migrations are pending" is genuinely unbuilt.
3. **SIGTERM/SIGINT are already handled** (`src/server/index.ts:75-81`): the handler calls
   `started.close()` and awaits it before `process.exit(0)`. `close` (lines 62-65) is
   `await new Promise(resolve => server.close(() => resolve())); await pgDb.end();` — Node's
   `server.close()` callback only fires once every open connection (including a streaming SSE
   response, which is never idle while tokens are flowing) ends naturally, so **in-flight SSE
   already survives a SIGTERM today**, it's just silent about it and gives no readiness signal to
   stop new traffic while draining.
4. **`node --env-file=.env` is baked into `serve`/`dev:server`/`ingest`/`migrate` in
   `package.json`.** That flag reads a literal file at that path — inside a container there is no
   `.env` file (compose injects env vars into the process directly via `env_file:`), so **none of
   these npm scripts can be used unmodified as container commands** — Node throws ENOENT on the
   missing file. Docker/compose commands must invoke the underlying binaries directly
   (`node dist/server/index.js`, `node node_modules/.bin/node-pg-migrate up`, etc.), never
   `npm run serve` / `npm run migrate` / `npm run ingest`.
5. **No build output exists.** Root `tsconfig.json` has `noEmit: true` (typecheck-only); dev runs
   raw `.ts` via `tsx`. `package.json` has no `build` script. `"main": "index.js"` is stale/unused.
   A slim runtime image needs compiled JS — `tsx` is a devDependency and the brief requires "no
   dev deps in the final image."
6. **`node-pg-migrate@9.0.0` bundles its own `typescript` dependency** (confirmed in its
   `package.json`) and ships prebuilt `dist/bundle` + `dist/legacy` — it runs `migrations/*.ts`
   directly with no `tsx`/`ts-node` needed alongside it. **But `node-pg-migrate` itself is
   currently a devDependency** in this repo's `package.json` — after `npm ci --omit=dev` in a
   slim runtime image it would be missing entirely, breaking the migrate service. It needs to move
   to `dependencies`.
7. Only one migration exists: `migrations/001_init.ts` (creates `chunks` + pgvector). No
   `.node-pg-migraterc`; node-pg-migrate defaults to reading `DATABASE_URL` and tracking applied
   migrations in table `pgmigrations` (columns include `name`, one row per applied file, by
   basename minus extension).
8. **No `Dockerfile`, `docker-compose.yml`, `.dockerignore`, or `.github/workflows/` exist yet.**
   `.env.example` has `DATABASE_URL`/`GEMINI_API_KEY`/`EMBED_MODEL`/`GEN_MODEL` (no `PORT`). `.env`
   itself is a protected file (CLAUDE.md) — **not touched**; only `.env.example` is edited.
9. `src/config.ts` reads purely from `process.env` (via zod) — no hardcoded `postgres-16`/
   `localhost` anywhere in `src/`. Safe to point `.env.example`'s `DATABASE_URL` at a
   compose-network service name (`postgres`, not the dev container's `postgres-16`) with zero
   code changes required.
10. `node:24.18.0-slim` images ship a built-in non-root `node` user (uid 1000) — no need to
    create one by hand.
11. Node 24 has global `fetch` — an app-service Docker healthcheck can be a one-line
    `node -e "fetch(...)"` against `/health`, no `curl`/`wget` package needed in the slim image.
12. `npm test` (`vitest run --passWithNoTests`) needs no DB — that's what the separate
    `test:db` script is for. CI's `test` job needs no Postgres service container.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Compiled JS vs. `tsx` in the runtime image | **Compile.** New `tsconfig.build.json` (extends root, `noEmit: false`, `outDir: "dist"`, excludes `*.test.ts`/`src/web`/`tests`), new `"build": "tsc -p tsconfig.build.json"` script. Runtime `CMD` is `node dist/server/index.js`. | Satisfies "no dev deps in the final image" literally — `tsx` never ships to prod. Root `tsconfig.json` (typecheck) is untouched. |
| Do local dev scripts (`serve`, `dev:server`, `ingest`, `migrate`) change? | **No.** They stay exactly as today, `tsx`-based, `--env-file=.env`. CLAUDE.md's documented commands (`npm run ingest -- --repo ...`, `npm run migrate`) keep working unchanged for local dev. | CLAUDE.md is protected and documents these commands generically ("index a repo") without pinning an implementation — only the *container's own commands* bypass npm scripts, not the scripts themselves. |
| How does the compose "ingest" quick-start work, given `npm run ingest` can't run in-container? | Document it as `docker compose exec app node dist/ingest/cli.js --repo <url>` instead of `npm run ingest -- --repo <url>`. | Same reason as above (Verified 4) — `--env-file=.env` would ENOENT in the container. Functionally identical one-liner, just not routed through the npm script. |
| `node-pg-migrate` devDependency → dependency? | **Move it.** | It's a real runtime dependency of the new `migrate` compose service once dev deps are excluded from the image (Verified 6). |
| Separate build stage for the `migrate` service? | **No — reuse the same runtime image.** `migrate`'s `command:` overrides the app's `CMD`. | `node-pg-migrate` is now a regular dependency and migration files are copied into the runtime image alongside `dist/` — no need for a second, heavier stage. |
| `/ready`'s migrations-pending check | Read expected migration names from a `migrationsDir` (default `path.resolve(process.cwd(), 'migrations')`, injectable for tests), `SELECT name FROM pgmigrations`, 503 if any expected name is missing from the result (or if the query itself throws — table not created yet). | A real check against the actual applied-migrations table, not a proxy on a specific table name that would drift as migrations are added. |
| Readiness during shutdown | `startServer` owns a `shuttingDown` flag; `close()` sets it **before** awaiting `server.close()`; `createReadyHandler` takes an `isShuttingDown: () => boolean` accessor and short-circuits to 503 `{status:'shutting-down'}` without touching the DB. | Lets compose/an orchestrator's healthcheck stop routing new traffic the instant SIGTERM arrives, while the already-correct drain (Verified 3) finishes in the background. |
| App's Docker `HEALTHCHECK` — `/health` or `/ready`? | **`/health`** (plain liveness). | `/ready`'s DB+migration check is redundant once `migrate` has already gated the app's own start via `service_completed_successfully`; `/health` is the standard "is the process alive" signal Compose/orchestrators expect for restart decisions. |
| `.dockerignore` | New file: `node_modules`, `.git`, `tmp/`, `dist/`, `coverage`, `*.log`, `.env` (never bake secrets into an image layer). | Standard hygiene; `.env` exclusion is the one that actually matters. |

## FILES

**New**
| File | Responsibility |
|---|---|
| `tsconfig.build.json` | Extends root; `noEmit: false`, `outDir: "dist"`; excludes `**/*.test.ts`, `src/web`, `tests`. |
| `Dockerfile` | Multi-stage: `build` (`node:24.18.0-slim`, `npm ci`, `npm run build`) → `runtime` (`node:24.18.0-slim`, `apt-get install -y --no-install-recommends git` + clean lists, `npm ci --omit=dev`, copy `dist/` + `migrations/` from `build`, non-root `node` user, `CMD ["node","dist/server/index.js"]`). |
| `docker-compose.yml` | `postgres` (`pgvector/pgvector:0.8.6-pg16`, named volume, `pg_isready` healthcheck) · `migrate` (build `.`, `depends_on: postgres: service_healthy`, `command` runs `node-pg-migrate` directly, `restart: "no"`) · `app` (build `.`, `depends_on:` postgres `service_healthy` + migrate `service_completed_successfully`, `env_file: .env`, port 8080, `/health`-based healthcheck via Node's global `fetch`). |
| `.dockerignore` | Per Decisions table above. |
| `.github/workflows/ci.yml` | Two jobs on push+PR: `test` (setup-node 24.18.0, `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`), `docker-build` (`docker build .`, no push/registry). |
| `src/server/routes/health.test.ts` | New — covers the shutdown short-circuit and the migrations-pending 503 (TESTS below). |
| `tests/fixtures/migrations/001_init.ts`, `002_fake.ts` | Empty placeholder files — a deterministic 2-file "expected migrations" fixture so the pending-migration test doesn't depend on the real `migrations/` dir's current count. |

**Modified**
| File | Change |
|---|---|
| `package.json` | + `"build": "tsc -p tsconfig.build.json"`. Move `node-pg-migrate` devDependencies → dependencies. No other script changes. |
| `src/server/routes/health.ts` | `createReadyHandler(db, options?: { isShuttingDown?: () => boolean; migrationsDir?: string })` — shutdown short-circuit, then DB reachability, then migrations-applied check, in that order. |
| `src/server/app.ts` | `AppDeps` gains `isShuttingDown?: () => boolean`; passed through to `createReadyHandler`. |
| `src/server/index.ts` | Owns the `shuttingDown` flag; `close()` sets it first; passes `() => shuttingDown` into `createApp`; adds a log line on shutdown start/finish. |
| `.env.example` | Add `PORT` (currently missing); confirm `DATABASE_URL` shape documented for the compose case (`postgres://admin:admin@postgres:5432/codedocs` — service name `postgres`, distinct from the dev container's `postgres-16`). |

**Not modified**: `CLAUDE.md`, `README.md`, `.env` (protected — flagged, not touched). No changes
to `src/ingest/`, `src/retrieve/`, `src/generate/`, or any existing route logic beyond the
`/ready` handler and the shutdown-flag plumbing above.

## TESTS

Written before implementation, per the standing rule.

1. *(Already exists, re-verified, not new)* `src/config.test.ts` — missing-key rejection names the
   var. **[REQ]**
2. **[REQ]** `createReadyHandler`: `isShuttingDown()` returns `true` → 503
   `{status:'shutting-down'}`, and the injected `db.query` mock is **never called** (asserts the
   short-circuit happens before any DB work).
3. `createReadyHandler`: DB query rejects (simulates unreachable DB / no `pgmigrations` table yet)
   → 503 `{status:'not-ready', ...}`.
4. **[REQ]** `createReadyHandler`, using the `tests/fixtures/migrations/` 2-file fixture as
   `migrationsDir`: DB mock's `SELECT name FROM pgmigrations` returns only 1 of the 2 expected
   names → 503, error message names the missing migration.
5. `createReadyHandler`, same fixture: DB mock returns both expected names → 200
   `{status:'ready'}`.

## RISKS

- **Shutdown has no bounded timeout.** A SIGTERM'd server still waits indefinitely for an SSE
  stream to finish naturally before exiting (Verified 3) — correct for "don't kill in-flight
  work," but if a client never closes its connection, shutdown could hang until the container
  orchestrator's own `stop_grace_period` forces a SIGKILL. Not adding a manual force-timeout here;
  flagged as a known, disclosed limitation rather than solved, to keep this block's scope bounded.
- **`docker compose up` itself cannot be run or verified from inside this container** (no docker
  CLI here, per CLAUDE.md — "Anything needing `docker compose` is run by the human in a host
  terminal"). Everything up to that point (build script, compiled output, image build via
  `docker build` if available, unit tests, typecheck) is verified directly; the actual
  `docker compose up` end-to-end gate needs the human to run it in a host terminal and report
  back pass/fail.
- **`.env.example`'s compose-facing `DATABASE_URL` (service name `postgres`) differs from the dev
  container's live `.env` (`postgres-16`).** Intentional (Decisions/Verified 9) but worth a clear
  comment in `.env.example` so it isn't mistaken for a typo later.
- **CI's `docker-build` job has never actually run** (no GitHub Actions execution available from
  this container) — its YAML will be written carefully against the real Dockerfile paths, but
  first real execution happens on the human's next push.

## TASKS (single slice)

1. `tsconfig.build.json` + `"build"` script; run `npm run build`, confirm `dist/server/index.js`
   and `dist/ingest/cli.js` exist and are runnable with plain `node`.
2. Move `node-pg-migrate` to `dependencies` in `package.json`.
   → commit: `chore(build): add production build output, move node-pg-migrate to dependencies`
3. Tests 2-5 (`src/server/routes/health.test.ts`, `tests/fixtures/migrations/*`), then
   `src/server/routes/health.ts` (shutdown short-circuit + migrations check),
   `src/server/app.ts` (`isShuttingDown` plumbing), `src/server/index.ts` (own the flag, log
   shutdown).
   → commit: `feat(server): readiness gate on migrations + graceful-shutdown signal`
4. `Dockerfile`, `.dockerignore`.
   → commit: `feat(deploy): multi-stage Dockerfile`
5. `docker-compose.yml`, `.env.example` update.
   → commit: `feat(deploy): docker-compose with migrate gating and healthchecks`
6. `.github/workflows/ci.yml`.
   → commit: `ci: typecheck, lint, test, docker build on push and PR`

## Verification

Inside this container (everything that doesn't need the docker CLI):

```bash
npm run build       # tsc -p tsconfig.build.json — confirm dist/ output, no errors
node dist/server/index.js &   # sanity: compiled JS boots (will exit 1 on missing env — expected
                               # without a real .env; confirms the "loud, named" failure path)
npm test             # full suite including new health.test.ts
npm run typecheck    # both tsconfigs, unchanged
npm run lint
```

Then, handed to the human (cannot run here — no docker CLI in this container):

```bash
cp .env.example .env   # fill in GEMINI_API_KEY
docker compose up      # must build app image, start postgres, run migrate to completion,
                        # then bring up app — healthy, /health and /ready both 200
docker compose exec app node dist/ingest/cli.js --repo <url>   # one-off ingest
curl localhost:8080/ready   # 200 once migrate has completed
```

STOP WHEN `docker compose up` alone brings up a fully working, ready-to-query app from a clean
clone — confirmed by the human, then commit/report closes Block 8.
