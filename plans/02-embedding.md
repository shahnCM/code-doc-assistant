# Block 2 — Embedding pipeline and pgvector storage

## Context

Block 1 (`src/ingest/`, committed) turns `--repo <path|url>` into `Chunk[]` plus an `IngestReport`.
Nothing is persisted yet — `chunks.json` is a debugging artifact, not a database. Block 2 closes
that gap: embed every chunk via Gemini and store it in Postgres/pgvector, so Block 3 (hybrid
retrieval) has a `chunks` table with a vector column, a tsvector column, and stable identity to
query against. This is the first block to touch the network (Gemini) or a stateful external system
(Postgres), and the first to need runtime env access at all — `src/config.ts` and `src/logger.ts`
are created here, minimally, scoped to what this block needs.

No new architectural surface beyond what CLAUDE.md already commits to: `pg`, `zod`, `pino`, and
`node-pg-migrate` are all named as settled choices in CLAUDE.md's Stack, Commands, and Architecture
sections already — this block installs them, it doesn't decide to use them.

## Verified before planning (ran/read these, not recalled)

1. **`node-pg-migrate@9.0.0` loads every migration file through `jiti`** (`createJiti(cwd).import(path)`
   in its `migrationLoader`), unconditionally — so a `.ts` migration file works with zero build step
   and can `import` a plain relative module. This resolves the "share the 768 constant between the
   migration and runtime code" problem cleanly: both sides import `src/index/constants.ts` directly.
2. **`createIndex`'s `method` option type is `'btree' | 'hash' | 'gist' | 'spgist' | 'gin'` — no
   `'hnsw'`.** The typed API cannot build an HNSW index; it has to be `pgm.sql('CREATE INDEX ...
   USING hnsw ...')`.
3. **`ColumnDefinition` supports `expressionGenerated: string`**, compiled to `GENERATED ALWAYS AS
   (<expr>) STORED`. The `tsv` column is declared inline in `createTable`, no follow-up `ALTER
   TABLE`.
4. **`ColumnDefinition.type` is a raw string, passed through verbatim.** `type: 'vector(768)'`
   needs no shorthand registration — only requires the extension to already exist, which the same
   migration creates first.
5. **`pg@8.x` ships no bundled types; `@types/pg` is required as a separate devDependency.**
   `node-pg-migrate@9`'s peerDependencies confirm both are in range.
6. **Node 24 has native `--env-file`.** `node --env-file=.env node_modules/.bin/node-pg-migrate up`
   loads `.env` with no `dotenv` dependency — confirms the Commands table's implicit assumption.
7. **`Chunk.contentHash` already includes `filePath`** (`sha256(chunkerKind, filePath, symbolName,
   partIndex, content)`), so two chunks can only collide *within one repo* if every hashed field is
   byte-identical. They **can** collide *across two different repos* sharing a file path and
   content (e.g. an identical `LICENSE` or a trivial barrel `index.ts`) — the hash carries no repo
   identity. Block 1's own Verification section ingests two different repos in sequence, so this
   isn't hypothetical.
8. Also confirmed, by direct inspection of this repo: `pg`, `zod`, `pino`, `node-pg-migrate` are
   all absent from `package.json` despite being named in CLAUDE.md; `src/config.ts`, `src/logger.ts`
   don't exist; `src/index/` exists and is empty; `.env`/`.env.example` already carry `DATABASE_URL`,
   `GEMINI_API_KEY`, `EMBED_MODEL`, `GEN_MODEL`; no Postgres MCP tool is available in this
   environment (BUILD-PLAN's Block 2 VERIFY text assumes one — Verification below uses `psql`
   instead, per CLAUDE.md's own stated workaround for this container).

## Decisions

Settled with the human before writing this:

| Question | Decision |
|---|---|
| New dependencies | `pg`, `zod`, `pino` (deps), `node-pg-migrate`, `@types/pg` (devDeps) — approved. Already named as settled in CLAUDE.md; this block installs, doesn't decide. |
| `ingest` → `index` import direction | CLAUDE.md's actual, current rule is narrower than Block 1's plan text: only "`src/retrieve/` may [not] import from `src/ingest/`" is stated. `src/ingest/cli.ts` **may** import `src/index/` — one `npm run ingest` does chunk → embed → store end to end, matching the Commands table exactly. `src/index/` never imports `src/ingest/`; it only ever sees plain `Chunk[]`. |
| Migration language | TypeScript, loaded by node-pg-migrate's built-in `jiti` — verified working, no separate compile step, lets the migration import the same `EMBEDDING_DIM` constant runtime code uses. |
| HNSW index construction | Raw `pgm.sql(...)`, not `pgm.createIndex` — the typed API's `method` union excludes `'hnsw'`. |
| `content_hash` uniqueness scope | `UNIQUE(repo_source, content_hash)`, with a new `repo_source` column populated from the raw `--repo` argument. A bare `UNIQUE(content_hash)` would let two different repos silently overwrite each other's row on a coincidental collision. |
| Upsert conflict behavior | `ON CONFLICT (repo_source, content_hash) DO NOTHING` — matches "content_hash unique" literally. First-write-wins; a chunk whose content is unchanged but whose line numbers shifted elsewhere in the file keeps its stale `start_line`/`end_line` until the row is cleared and re-inserted. Named directly in RISKS, not hidden. |
| Concurrency primitive | Hand-rolled worker-pool semaphore (~15 lines) in `src/index/batch.ts`. No `p-limit` — the dependency bar in CLAUDE.md is real, and this is small enough not to need one. |
| Disk cache vs. DB uniqueness | Both, for different reasons. `UNIQUE(repo_source, content_hash)` prevents duplicate *rows*; it does nothing to prevent a *re-embed* of the same content during iterative development (a migration reset drops all rows but the disk cache survives). The disk cache is what actually protects free-tier request budget across the Block 2–6 development cycle. |
| Retry scope | Only rate-limit-classified errors (HTTP 429 / `RESOURCE_EXHAUSTED`) retry with exponential backoff + jitter. Anything else (bad request, auth failure) fails the batch immediately — no point burning retry budget on a non-transient error. |
| Client/DB/cache shape | Same DI pattern Block 1 established for `GitRunner` in `acquire.ts`: a small interface plus a `real*` factory, injected with a default, tests use hand-rolled fakes. No `vi.mock('@google/genai')`, no `vi.mock('pg')`, ever. |

## INTENT

Turn `Chunk[]` (already produced by `runPipeline`) into rows in a Postgres `chunks` table with a
768-dim pgvector `embedding` column and a generated `tsv` column, embedding each chunk's
`embedText` via Gemini, deduplicated and cached by `contentHash` so re-running ingest during
development never re-embeds unchanged content and never re-burns free-tier request budget. One
command — `npm run ingest -- --repo <x>` — does the whole offline path: acquire, chunk, embed,
store.

Out of scope: retrieval, ranking, `symbol_edges`, anything in `src/retrieve/` or `src/generate/`.
`src/index/` must not import from `src/ingest/`.

## Extensibility / design

```
src/index/constants.ts    EMBEDDING_DIM = 768        zero imports — shared by migration AND runtime
src/index/embedClient.ts  EmbedClient interface       Gemini call, wrapping, dimensionality
src/index/batch.ts        embedTexts()                batching + concurrency-5 + backoff/retry
src/index/cache.ts        EmbedCache interface        one file per contentHash, atomic write
src/index/db.ts           Db interface                thin pg.Pool wrapper
src/index/store.ts        upsertChunks()               parameterized INSERT ... ON CONFLICT DO NOTHING
src/index/embed.ts        indexChunks()                orchestrates the above; the one export cli.ts calls
```

No `src/index/types.ts` — each interface (`EmbedClient`, `EmbedCache`, `Db`) lives beside its real
implementation, the same precedent `chunkers/index.ts` set for `Chunker` in Block 1.

`indexChunks` is the only seam `src/ingest/cli.ts` touches. It takes plain `Chunk[]` and primitive
config values (connection string, model id) — no knowledge of chunkers, registries, or acquisition,
which is what keeps the one-directional import boundary real rather than nominal.

## FILES

**New — `src/index/`**

| File | Responsibility |
|---|---|
| `constants.ts` | `EMBEDDING_DIM = 768`. |
| `embedClient.ts` | `EmbedClient` interface, `GenAILike` structural subset of `@google/genai`, `createGeminiEmbedClient(ai, model)`, `realEmbedClient(model)`. Wraps every text as `{ parts: [{ text }] }` (never a bare string array — the aggregation bug), sets `config.outputDimensionality: EMBEDDING_DIM` on every call, reads `res.embeddings[i].values`. |
| `batch.ts` | `embedTexts(texts, client, options)`. Groups into batches (`batchSize` default 20 — unverified beyond the smoke-tested 3, isolated to one constant), runs groups through a concurrency-5 semaphore, retries only rate-limit-classified errors with exponential backoff + jitter, otherwise fails that batch immediately. On exhaustion or a non-retryable error, the whole call returns `{ ok: false }` — no partial success, so the caller never has to reconcile a half-embedded run. |
| `cache.ts` | `EmbedCache` interface (`get(hash, model)`, `set(hash, entry)`), `createFileEmbedCache(dir)`. One file per hash under `.cache/embeddings/<hash>.json`; `get` treats a stored `model` mismatch as a miss (guards a silent stale/wrong-dim vector after an `EMBED_MODEL` swap); `set` writes to `<path>.tmp` then renames — atomic, race-safe against a second concurrent ingest. |
| `db.ts` | `Db` interface (`query`), `createPgDb(connectionString)` — `pg.Pool` wrapper, explicit `max: 10`. |
| `store.ts` | `upsertChunks(db, repoSource, rows)` — one parameterized `INSERT ... ON CONFLICT (repo_source, content_hash) DO NOTHING` per row; `embedding` bound as `$n::vector` via a `toVectorLiteral` helper (`pg` has no native pgvector OID mapping). |
| `embed.ts` | `indexChunks(chunks, repoSource, connectionString, embedModel, options)` — dedup by `contentHash` → cache lookup → batch-embed misses → write cache → fan embedding back out to every chunk sharing that hash → `upsertChunks`. Returns an `IndexReport` (`totalChunks`, `uniqueHashes`, `cacheHits`, `embedded`, `upserted`). |

**New — top level**

| File | Responsibility |
|---|---|
| `src/config.ts` | `loadEnv(source: NodeJS.ProcessEnv = process.env): Result<Env, string>` — zod schema for `DATABASE_URL`, `GEMINI_API_KEY`, `EMBED_MODEL`, `GEN_MODEL`. Injectable `source` keeps it testable without real env. |
| `src/logger.ts` | `export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })`. Three lines — no transport, no request-id machinery; that belongs to the later Express/SSE block. |
| `migrations/001_init.ts` | `CREATE EXTENSION IF NOT EXISTS vector`, `chunks` table, indexes. Detail below. |

**Modified**

- `src/ingest/cli.ts` — after the existing `runPipeline` call and `chunks.json` write: `loadEnv(process.env)`, then `indexChunks(chunks, values.repo, env.value.DATABASE_URL, env.value.EMBED_MODEL)`; prints an embed/upsert summary; exits 1 with the error message on either failure.
- `package.json` — `dependencies`: `+pg`, `+zod`, `+pino`. `devDependencies`: `+node-pg-migrate`, `+@types/pg`. `scripts`: `+"migrate": "node --env-file=.env node_modules/.bin/node-pg-migrate up"`.
- `tsconfig.json` — `include` gains `"migrations"`.
- `.gitignore` — `+.cache/`.

**Tests** — `*.test.ts` beside each new source file, following Block 1's convention exactly (hand-rolled fakes, no `vi.mock`).

### The `chunks` table (`migrations/001_init.ts`)

Mirrors every `Chunk` field so nothing later block needs is lost, plus indexing/storage columns:

```
id             serial primary key
repo_source    text not null            -- raw --repo argument; scopes uniqueness, guards cross-repo collision
file_path      text not null
symbol_name    text
kind           text not null            -- label only, never branched on — same rule as chunkerKind
signature      text
js_doc         text
start_line     integer not null
end_line       integer not null
parent_symbol  text
is_exported    boolean not null
content_hash   text not null
language       text not null
chunker_kind   text not null
part_index     integer not null
part_total     integer not null
content        text not null
embed_text     text not null
embedding      vector(768) not null
tsv            tsvector generated always as (
                 to_tsvector('english', coalesce(symbol_name, '') || ' ' || coalesce(signature, '') || ' ' || content)
               ) stored
created_at     timestamptz not null default now()

unique (repo_source, content_hash)
```

Both nullable text fields feeding `tsv` are coalesced — not just `signature`, since generic chunks
(`kind: 'block'|'file'|'window'`) have `symbol_name: null` too. Indexes: GIN on `tsv`, btree on
`language`, HNSW on `embedding` (`vector_cosine_ops`, via raw SQL per Verified finding 2). `kind`
and `chunker_kind` stay plain `text` — no enum, no CHECK constraint, consistent with the "label
only" rule Block 1 already applied to `chunkerKind` in application code.

## TESTS

Written before the implementation in each slice, per the standing rule. The five required by the
brief are marked **[REQ]**.

### Slice 1 — config, embed client, batching

1. `config.loadEnv` returns `{ ok: false }` with a readable message when a required key is missing
   from the injected source object, `{ ok: true }` with all four values when present. No real
   `process.env`/`.env` needed.
2. **[REQ]** `embedTexts`: cache hit skips the API call — fake `EmbedClient` call-counter stays 0
   for a pre-cached hash (this test lives at the `indexChunks` level, where the cache is consulted;
   listed here as the cache-hit contract `batch.ts`'s caller relies on).
3. **[REQ]** Batching respects the concurrency cap — fake client tracks max concurrent in-flight
   calls across more than 5 batches, asserts the observed max is ≤ 5.
4. **[REQ]** A failed batch retries without corrupting the run — fake client fails a batch's first
   two calls with a rate-limit-tagged error then succeeds; final vectors are correct and in
   original order; sibling batches are each called exactly once (not re-run because of an unrelated
   batch's retry).
5. A non-retryable error fails fast — fake client throws a non-rate-limit error; `embedTexts`
   returns `{ ok: false }` after exactly one attempt for that batch, not `maxRetries` attempts.
6. `createGeminiEmbedClient` always wraps texts as `{ parts: [{ text }] }` (never a raw string
   array) and sets `config.outputDimensionality: EMBEDDING_DIM` on every call — asserted against
   captured call args on a fake `GenAILike`. Guards the aggregation bug directly.
7. `createGeminiEmbedClient` reads `res.embeddings[i].values` (not `res.embedding.values`) and
   preserves input order — fake `GenAILike` returns distinguishable vectors per index.

### Slice 2 — cache, db, store

8. Disk cache persists across two separately-constructed `createFileEmbedCache(sameDir)`
   instances — write via instance A, read via instance B, proving it's file-backed.
9. Disk cache treats a stored entry's `model` mismatch as a miss — written under `"model-a"`,
   `get(hash, "model-b")` returns `null`.
10. `upsertChunks` inserts a new row for a fresh `(repo_source, content_hash)` pair with every
    mapped column present — fake `Db` capturing executed SQL/params.
11. `upsertChunks` on a repeat `(repo_source, content_hash)` is a no-op — the existing row's
    `start_line`/`end_line` are unchanged even when the incoming row's differ, proving `DO NOTHING`
    per the confirmed decision.

### Slice 3 — orchestration, pipeline wiring

12. **[REQ]** `indexChunks` dedups two chunks sharing one `contentHash` within a single run — fake
    `EmbedClient` called exactly once for that hash; fake `Db` receives two upserts, both carrying
    the identical embedding.
13. `indexChunks`'s returned `IndexReport` accounts for the run: `totalChunks`, `uniqueHashes`,
    `cacheHits`, `embedded`, `upserted` reconcile against a small fixture with a mix of cached and
    fresh chunks.
14. `src/ingest/cli.ts`'s wiring is exercised with fakes end-to-end (fake `GitRunner`, fake
    `EmbedClient`, fake `Db`) — proves the full `--repo` → chunks → embed → store path without a
    real network call or real Postgres anywhere in the suite.

### Manual verification (not `npm test` — no real Postgres in the suite)

15. **[REQ]** Migration idempotency: `npm run migrate` run twice against real `postgres-16` —
    node-pg-migrate's own bookkeeping table (`pgmigrations`) makes the second run a no-op. Verified
    via `psql`, documented here rather than faked as a vitest case.
16. **[REQ]** A generic chunk (`signature: null`, `symbol_name: null`) produces a non-NULL `tsv` —
    `tsv` is a DB-generated column with no application-code surface to unit test; verified by
    inserting one such row via `psql` against the real schema and asserting `tsv IS NOT NULL`.

## RISKS

- **Cross-repo `content_hash` collision**, mitigated but not eliminated. `UNIQUE(repo_source,
  content_hash)` stops one repo's row from silently overwriting another's, but two chunks *within*
  the same repo run that hash identically (e.g. genuinely duplicated files) still collide by
  design — `DO NOTHING` on the second is correct there, since the content is provably the same.
- **`DO NOTHING` leaves stale `start_line`/`end_line`** when a file changes elsewhere in a way that
  shifts a chunk's position without changing its content. The row is not refreshed until manually
  cleared and re-inserted. Accepted per the confirmed decision, not silently absorbed — citations
  built on a stale row would point at the wrong lines until the table is reset.
- **`BATCH_SIZE` (default 20) is an unverified guess.** The smoke test only proved correctness at 3
  wrapped items, not an upper bound. Isolated to one constant in `batch.ts` so it's a one-line fix
  if the first large real ingest run reveals a lower ceiling.
- **Cache directory has no eviction.** Content-hash-keyed files never expire; documented as "delete
  `.cache/embeddings/` to reclaim space," matching Block 1's own deferred-cache-invalidation
  precedent rather than building LRU/TTL machinery nobody asked for.
- **No run-level circuit breaker for free-tier daily quota (RPD) exhaustion.** Backoff keeps
  retrying with growing delays near RPD exhaustion instead of failing fast with a clear "quota
  exhausted" message. Consistent with CLAUDE.md's already-stated rate-limit risk; not solved here.
- **jiti transpiles `migrations/*.ts` on the fly.** A type error in a migration file is only caught
  by `npm run typecheck` (once `migrations` is in `tsconfig.json`'s `include`), not by the migration
  run itself — `npm run migrate` would still apply a migration with a latent type bug if typecheck
  wasn't run first.
- **HNSW index build is cheap today only because it runs before any ingest.** The migration builds
  the index against an empty table. A future migration that adds an index to an already-populated
  `chunks` table would need to budget for build time — worth a README line once that's relevant.

## TASKS

Tests first within every slice. One slice at a time; do not start the next unprompted. Each slice
ends with `npm test` and `npm run typecheck` clean, then a conventional commit.

**Slice 1 — config, embed client, batching**
1. `src/config.ts`, `src/logger.ts`.
2. Tests 1, 2, 3, 4, 5, 6, 7.
3. `src/index/constants.ts`, `src/index/embedClient.ts`, `src/index/batch.ts`.
   → `feat(index): env config, logger, Gemini embed client with batching and retry`

**Slice 2 — cache, db, store, migration**
4. Tests 8, 9, 10, 11.
5. `src/index/cache.ts`, `src/index/db.ts`, `src/index/store.ts`, `migrations/001_init.ts`.
   Add `pg`, `zod`, `pino`, `node-pg-migrate`, `@types/pg` to `package.json`; add `migrate` script;
   `.gitignore` gains `.cache/`; `tsconfig.json` `include` gains `"migrations"`.
   → `feat(index): pgvector schema migration and content-hash disk cache`

**Slice 3 — orchestration, pipeline wiring**
6. Tests 12, 13, 14.
7. `src/index/embed.ts`; wire `src/ingest/cli.ts` to call `indexChunks` after `runPipeline`.
   → `feat(index): embedding orchestration wired into npm run ingest`

## Verification

Per-slice: `npm test` and `npm run typecheck` both clean.

End of block, per BUILD-PLAN:

```bash
npm run migrate
npm run ingest -- --repo ./tmp/hono
```

Then confirm by inspection via `psql -h postgres-16 -U admin -d codedocs` (no Postgres MCP tool
exists in this environment — BUILD-PLAN's Block 2 VERIFY text assumes one; CLAUDE.md's own stated
workaround for this container is `psql` directly):

- `chunks` has an HNSW index on `embedding` (`\d chunks` or a query against `pg_indexes`).
- Row count by `kind`, `language`, and `chunker_kind` — no zero-row surprises.
- One row's `embed_text`, truncated to 200 chars — never `SELECT *`.
- Manual tests 15 and 16 from the TESTS section.

**Commit.** `feat(index): embedding pipeline with content-hash cache`
