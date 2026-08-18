# Block 9 — Replace semantics on ingest

## Status — read this first

**Implemented 2026-08-18. All four slices landed.** The sections below are kept as written, so
where the plan and the code disagree, the code is right and the deviations are listed here.

```
c4f1f2d  test(index): prove replace semantics against real Postgres   (Slice 4)
ea34b10  feat(ingest): report rows deleted and inserted separately    (Slice 3)
b1b6cf3  feat(index): replace upsertChunks with replaceChunks         (Slice 2)
1f7425f  feat(index): add withTransaction to the Db interface         (Slice 1)
```

The five preceding docs commits were fast-forwarded onto `develop` before coding started, so the
branch name now matches its contents.

**Three deviations from the plan as written:**

1. **The signature in FILES cannot typecheck.** It specifies
   `withTransaction<T, E>(fn) => Promise<Result<T, E>>` while also requiring a thrown error to
   become `{ ok: false, error: message }`. A `catch` only ever holds a string, so it cannot
   manufacture an arbitrary `E`. Shipped as `Promise<Result<T, E | string>>`; every current caller
   has `E = string`, so the union collapses and no call site changed.
2. **A new seam, `createDb(pool)`.** `createPgDb` builds its own `Pool`, leaving nothing to inject
   and no way to test the transaction offline. `createPgDb` keeps its signature and delegates.
3. **Verified 9 undercounts.** Widening `Db` broke **thirteen** construction sites across **ten**
   files, not nine files. `src/server/index.test.ts:17` builds its fake inline inside a `PgDb`
   literal with no `: Db` annotation, so it is contextually typed and invisible to a grep for the
   annotation — only the compiler found it.

**Verified against the live database with `./tmp/mini-demo`** (13 chunks, 13/13 cached, zero
Gemini calls): a re-ingest moved every row id and left the other three sources untouched.
Prepending two lines to `src/api/client.ts` moved `PricingClient` from 4-20 to 6-22 under an
unchanged `content_hash` — the exact scenario the old `[REQ]` test froze. CLI reported
`Deleted: 13, Inserted: 13`.

The Slice 4 rollback assertion was mutation-tested: bypassing `withTransaction` in
`replaceChunks` fails that test and only that test.

**Database state after this block (2026-08-18):**

```
chunks (live)              63 rows
  ./tmp/sampleproject      29
  is-plain-obj             20
  ./tmp/mini-demo          13
  ./tmp/health-app          1

chunks_backup_20260817     62 rows — still present, safe to drop by hand
```

`guard.sh` blocks `DROP TABLE` from an agent's Bash, so this one is owed to the human:
`psql "$DATABASE_URL" -c "DROP TABLE chunks_backup_20260817;"`. It predates the `./tmp/health-app`
ingest, so it was already a lossy restore point; every content hash in it is cached, making a
re-ingest free.

**Still open, deliberately not folded in:** whole-file chunks over-report `end_line` by one
whenever the source ends with a trailing newline, because `wholeFileChunks` reads
`sourceFile.getEndLineNumber()` (`ts-morph.ts:501`). Declaration chunks are unaffected. Documented
in `flow-map.md`, section F. It shares this block's theme — silent, small, lands on the citation
guarantee — but it lives in the chunker, not the store.

**Owed to the human:** `CLAUDE.md` and `README.md` are protected files. Both edits are drafted
verbatim in the [Protected-file drafts](#protected-file-drafts) appendix at the end of this file,
for hand-application.

## Context

Ingest is currently **insert-only and idempotent by content hash**. `upsertChunks` issues one
`INSERT ... ON CONFLICT (repo_source, content_hash) DO NOTHING` per chunk, so a re-ingest of a repo
whose code has not changed is a no-op — no writes, no cost. That is the property Block 2 was built
for, and it works.

The cost of that property was identified, named, and accepted. `content_hash` is computed from
`chunkerKind + filePath + symbolName + partIndex + content` (`src/ingest/hash.ts`). It deliberately
excludes everything else the row carries — `start_line`, `end_line`, `signature`, `js_doc`, `kind`,
`is_exported`, `parent_symbol`, `language`, `part_total`, `embed_text`, and `embedding`. When any of
those change without `content` changing, `DO NOTHING` fires and the database keeps the stale value.

`plans/02-embedding.md:232-235` says so directly, in its RISKS section: *"`DO NOTHING` leaves stale
`start_line`/`end_line` … Accepted per the confirmed decision, not silently absorbed — citations
built on a stale row would point at the wrong lines until the table is reset."*

**This block does not report a newly discovered defect. It revisits an accepted risk, because the
acceptance was mis-weighted.** What Block 2 recorded as an operational inconvenience — "until the
table is reset" — is in fact a correctness failure in the single guarantee the product makes, and it
is *undetectable from inside the system*. That second half is what the original acceptance missed.

Two consequences, in order of severity:

1. **Stale line numbers break citations, invisibly.** Add an import at the top of a file and every
   declaration below it shifts down. No `content` changed, so no hash changed, so `DO NOTHING` keeps
   the old `start_line`/`end_line`. The answer then cites `foo.ts:12-20` for a function that now
   lives at 14-22. `validateCitations` cannot catch this: it validates the model's cited range
   against the same stale numbers it was given, so the citation is reported *valid*. There is no
   error, no warning, and no metric that moves. A risk worth accepting is one you would notice
   firing; this one cannot fire visibly.
2. **Switching embedding models is a paid no-op.** Same content → same hash → `DO NOTHING`. Every
   vector is recomputed and billed, and none of them reach the table. The only signal is
   `Upserted: 0` in the CLI output.

A third defect is not caused by the hash at all but shares the fix: **the pipeline never deletes.**
Remove a function from the repo, re-ingest, and its row survives and stays retrievable. The LLM can
cite code that no longer exists.

Block 9 replaces upsert semantics with **replace semantics**: after a successful ingest, the rows
for that `repo_source` are exactly what the chunker just produced. Nothing stale, nothing orphaned,
no versioning.

Scope note: a `embed_model` column with multi-model coexistence was considered and **rejected**. It
solves model comparison, which is an evals concern, not this one. It doubles storage per model and
adds a mandatory `WHERE embed_model = $n` to every retrieval query. This block keeps one vector per
chunk — the most recent one.

No new dependencies. `src/index/` only; `src/retrieve/` and `src/ingest/chunkers/` are untouched.

## Verified before planning (ran these, not recalled)

Against the live dev database — `postgres://admin:admin@postgres-16:5432/codedocs`, PostgreSQL 16,
pgvector 0.8.6, corpus 62 rows across 3 repo sources. Sentinel rows used `test://` prefixes and were
deleted; the 62-row corpus was confirmed intact afterward.

1. **`Db` has no transaction support, and `Pool` makes the naive form silently wrong.**
   `src/index/db.ts` exposes exactly one method, `query`, implemented as `pool.query(...)` on a
   `new Pool({ max: 10 })`. `pool.query` acquires an arbitrary connection per call and releases it.
   `db.query('BEGIN')` followed by `db.query('DELETE ...')` therefore lands on different connections:
   the `BEGIN` opens and abandons a transaction on one connection, the `DELETE` autocommits on
   another, and the `COMMIT` warns `no transaction in progress`. **No error is raised.** Adding
   transaction support is the bulk of this block, not the `DELETE`.

2. **`ON CONFLICT DO NOTHING` discards the entire new row, embedding included.** Inserted
   `repo_source='test://model-switch'`, `content_hash='HASH_SAME'`, embedding `array_fill(0.1, 768)`.
   Re-inserted the identical key with `array_fill(0.9, 768)` and `ON CONFLICT ... DO NOTHING
   RETURNING id`. Result: `INSERT 0 0`, zero rows returned, and the stored embedding still began
   `[0.1,0.1,0.1,...`. Nothing partial occurs — the statement is skipped whole.

3. **A dimension change fails loudly; a same-dimension model change fails silently.** Inserting
   `array_fill(0.5, 3072)` into the `vector(768)` column raised
   `ERROR: expected 768 dimensions, not 3072` during tuple construction, *before* conflict handling.
   So only same-dimension swaps are silently lost. This block does not need a migration unless
   `EMBEDDING_DIM` changes.

4. **Recovery for the test corpus is free.** All 29 `content_hash` values for `./tmp/sampleproject`
   have a matching file in `.cache/embeddings/` (29/29). A destructive test against that repo costs
   zero Gemini calls to undo, because re-ingest hits the cache for every chunk.

5. **`--refresh` does not touch the database.** `src/ingest/acquire.ts:93` calls
   `git.fetchAndReset(targetDir)` when the clone already exists. It re-fetches the working tree only;
   there is no DB path. It is not a workaround for any of the above.

6. **`DO NOTHING` is currently load-bearing for within-run deduplication.** `indexChunks`
   (`src/index/embed.ts:97-103`) groups chunks by hash but then pushes **one row per chunk in the
   group**, all sharing the group's single embedding. If two chunks in one ingest produce the same
   hash, both reach `upsertChunks` and the unique constraint drops the second. Removing
   `ON CONFLICT DO NOTHING` would turn that into a duplicate-key error mid-ingest.

7. **The stale-line consequence was documented in Block 2 and accepted, not missed.**
   `plans/02-embedding.md:60` records the conflict behaviour as a confirmed decision — *"a chunk
   whose content is unchanged but whose line numbers shifted elsewhere in the file keeps its stale
   `start_line`/`end_line` until the row is cleared and re-inserted. Named directly in RISKS, not
   hidden."* — and `plans/02-embedding.md:232-235` spells out the citation consequence. This block
   reverses a judgement, not an oversight. The reversal's grounds are narrow and should be stated as
   such: the risk was weighed as an operational cost ("until the table is reset") without weighing
   that nothing in the system can detect it having fired.

8. **The stale-line-number behaviour is also an asserted requirement.**
   `src/index/store.test.ts:85` is titled
   `[REQ] a repeat (repo_source, content_hash) is a no-op — the existing row keeps its original
   start_line/end_line` and asserts `stored?.start_line).toBe(10)` after re-inserting the same chunk
   with `startLine: 55`. This block **inverts a `[REQ]` test**. That is a deliberate reversal of a
   written requirement and should be called out in review, not slipped in.

9. **`upsertChunks` has four call sites, but widening `Db` touches nine test files.** Two different
   blast radii, and the second is the one that sets the schedule.

   `upsertChunks` itself: `src/index/store.ts`, `src/index/embed.ts`, `src/index/store.test.ts`
   (5 tests, hand-rolled `fakeDb` that parses the SQL string), `src/retrieve/fusion.db.test.ts`
   (seeds its fixture with it).

   Adding a method to the `Db` interface breaks **every hand-rolled fake**, and there are nine:

   ```
   src/index/store.test.ts:11          src/generate/answer.test.ts:36
   src/index/embed.test.ts:34          src/server/app.test.ts:12
   src/ingest/cli.test.ts:47           src/server/routes/chat.test.ts:53
   src/retrieve/search.test.ts:22      src/server/routes/health.test.ts:28
   src/retrieve/source.test.ts:10
   ```

   Each needs one line — `withTransaction: async (fn) => fn(db)` — but nine files must be touched
   before `npm run typecheck` goes green again, and the change cannot be landed half-done.
   Budget for this; it is the single largest mechanical cost in the block.

10. **Baseline is green.** `npm test` → 212 passed, 39 files. `npm run typecheck` → clean, both
   configs. Backup taken: `chunks_backup_20260817`, 62 rows.

## Decisions

- **Replace, not upsert.** `DO UPDATE SET ...` would fix stale columns and stale vectors but leaves
  rows for deleted code in place forever, and requires every future column to be remembered in the
  update list — a standing invitation to reintroduce exactly this class of bug. Replace makes the
  post-condition structural: *after ingest, the rows for this `repo_source` are the chunker's
  output*. There is no per-column reasoning to get wrong.
- **`withTransaction` returns `Result`, it does not throw.** CLAUDE.md: errors return
  `Result<T, E>`; only the Express error boundary throws. The callback returns
  `Promise<Result<T, E>>`; an `ok: false` return triggers `ROLLBACK` and is passed through unchanged.
  A thrown exception also triggers `ROLLBACK` and is converted to `ok: false` — `upsertChunks`
  already catches and converts, so this preserves the existing contract.
- **`withTransaction` goes on `Db`, not on `PgDb`.** `indexChunks` accepts an injected `Db`, so a
  method on the owning `PgDb` would be invisible to callers and untestable through the seam. Fakes
  implement it in one line: run the callback against themselves. A fake needs no isolation.
- **Keep `ON CONFLICT DO NOTHING` on the INSERT.** Verified 6 — it is doing within-run dedupe. After
  the `DELETE` there is no cross-run conflict left for it to handle, so it becomes purely a
  same-batch guard. Removing it is a separate change with its own test.
- **Count deletions with `DELETE ... RETURNING id`.** `Db.query` returns `{ rows }` and no
  `rowCount`. Widening the interface for one counter is not worth it; 2188 integers is nothing.
- **`DELETE` runs after embedding succeeds.** Embedding is the only step that can fail slowly and
  expensively. `indexChunks` already completes `embedTexts` before it stores, so the transaction
  wraps the store call only. Ordering the `DELETE` any earlier makes a failed embed leave an empty
  corpus.

## INTENT

Given a repo source and the chunks the pipeline just produced, the database ends the run holding
exactly those chunks for that repo source, with current line numbers and current vectors, and
holding nothing for chunks that no longer exist. If any part of the store step fails, the database
is left exactly as it was before the run.

## FILES

### `src/index/db.ts`

`Db` gains one method. The type change is what forces every fake to be updated, which is the point —
a fake that silently lacks transaction semantics would hide the bug this block exists to fix.

```
export interface Db {
  query(text, params?): Promise<{ rows: Array<Record<string, unknown>> }>;
  withTransaction<T, E>(fn: (tx: Db) => Promise<Result<T, E>>): Promise<Result<T, E>>;
}
```

Real implementation acquires a dedicated client:

- `const client = await pool.connect()`
- `await client.query('BEGIN')`
- build a `tx: Db` whose `query` delegates to `client.query` (**not** `pool.query`)
- `const result = await fn(tx)`
- `result.ok` → `COMMIT`; `!result.ok` → `ROLLBACK`; both return `result`
- thrown error → `ROLLBACK`, return `{ ok: false, error: message }`
- `finally { client.release() }` — must run on every path, including a failed `ROLLBACK`

Two details that are easy to get wrong:

- **`ROLLBACK` can itself throw** if the connection died. It must be wrapped so the original error is
  the one reported and `release()` still runs.
- **The nested `tx.withTransaction`** must not open a second transaction on a pooled connection. It
  runs the callback inline against the same `tx`. Postgres has no true nested transactions;
  `SAVEPOINT` would be the real answer and is not needed here.

### `src/index/store.ts`

`upsertChunks` → `replaceChunks(db, repoSource, rows)`, returning
`Result<{ deleted: number; inserted: number }, string>`.

Body is one `db.withTransaction` call containing:

- `DELETE FROM chunks WHERE repo_source = $1 RETURNING id` — count the rows
- the existing per-row `INSERT ... ON CONFLICT (repo_source, content_hash) DO NOTHING RETURNING id`
  loop, unchanged
- return `{ deleted, inserted }`

`INSERT_SQL` and `paramsFor` are unchanged.

### `src/index/embed.ts`

`IndexReport` gains `deleted: number`. The `upsertChunks` call site becomes `replaceChunks`, and
`upserted` in the report becomes `inserted`. No other change — `indexChunks` already finishes
embedding before it stores.

### `src/ingest/cli.ts`

Output gains a line. The current report cannot distinguish "nothing changed" from "everything was
rejected" — that ambiguity is how the model-switch defect stayed invisible:

```
Unique hashes:   2188
Cache hits:      2188
Embedded:        0
Deleted:         2188      <- new
Inserted:        2188      <- was "Upserted"
```

## TESTS

Write the test before the implementation, per slice.

### Slice 1 — `withTransaction` on `Db`

Offline, against a fake `pg` client that records the statements it receives.

- commits when the callback returns `ok: true` — statement order is `BEGIN`, the callback's queries,
  `COMMIT`
- rolls back when the callback returns `ok: false`, and returns that same error unchanged
- rolls back when the callback throws, and converts to `ok: false`
- releases the client on all three paths
- releases the client even when `ROLLBACK` itself throws, and reports the original error
- the `tx` handed to the callback issues queries on the dedicated client, never on the pool

### Slice 2 — `replaceChunks`

Extend the existing `fakeDb` in `store.test.ts` with `withTransaction` (one line: run the callback
against itself) and teach it to handle `DELETE ... WHERE repo_source = $1`.

- deletes only rows matching `repo_source`; rows under a different `repo_source` survive
- inserts every supplied row and reports `inserted` equal to the row count
- **a re-ingest with shifted line numbers now yields the new `start_line`/`end_line`** — this is the
  direct inversion of the current `[REQ]` test at `store.test.ts:85`
- a re-ingest with a different embedding replaces the stored vector
- a chunk no longer present in the new set is gone after the run
- two chunks sharing a `content_hash` within one run still collapse to one row (Verified 6)
- a failure mid-insert leaves the table exactly as it was — nothing deleted, nothing inserted

### Slice 3 — report and CLI

- `IndexReport` carries `deleted` and `inserted`
- the CLI prints both

### Slice 4 — contract test against real Postgres (`npm run test:db`)

**`npm run test:db` runs against the dev database** (`--env-file=.env`, same `DATABASE_URL`). This
block's whole subject is a `DELETE` keyed on `repo_source`. A fixture bug here destroys real data.

- fixture `repo_source` is `test://replace-semantics`
- **a guard inside the fixture throws unless `repo_source.startsWith('test://')`**, evaluated before
  any `DELETE` is issued. This is new and does not exist for the current db tests.
- seed two rows, re-run `replaceChunks` with one changed row and one removed, assert the final table
  state
- assert `ROLLBACK` really rolls back — force a failure mid-transaction, confirm the seeded rows are
  untouched. This is the one assertion that cannot be made against a fake, and it is the reason this
  slice exists.
- `fileParallelism: false` already applies (`vitest.db.config.ts`)

## RISKS

- **Ingest becomes destructive.** A typo in `--repo` deletes that repo source's rows. Mitigated by
  the transaction and by `DELETE` running only after chunking and embedding have both succeeded, but
  the failure mode is new and should be named in the README.
- **`repo_source` is now an identity, not a label.** `./tmp/hono` and `/projects/.../tmp/hono` are
  distinct sources; ingesting one will not clear the other, and the corpus will hold two copies.
  Pre-existing, but replace semantics make it consequential.
- **Pool exhaustion.** `withTransaction` holds one of 10 connections for the whole store step. One
  ingest is fine. Concurrent ingests plus a serving API could starve the pool.
- **HNSW churn.** 2188 deletes plus 2188 inserts per full re-ingest, each mutating the graph index.
  Slower than the current no-op re-ingest, which is the price of correctness. Worth measuring on the
  first hono run.
- **`created_at` no longer means "first indexed".** Replace makes every row new. Nothing reads it
  today.
- **Inverting a `[REQ]` test** (Verified 8), and reversing an accepted risk from Block 2
  (Verified 7). Reviewers should see this called out, not discover it.
- **`CLAUDE.md` needs a new gotcha entry** describing replace semantics and the `Pool`/transaction
  trap. `CLAUDE.md` is protected — draft to scratchpad and let the human apply it.

## TASKS

1. Slice 1 — tests for `withTransaction`, then `db.ts`, then all **nine** fake `Db` implementations
   listed in Verified 9. Typecheck stays red until every one is updated.
2. Slice 2 — tests for `replaceChunks`, then `store.ts`. Invert the `[REQ]` test.
3. Slice 3 — report and CLI output.
4. Slice 4 — db contract test with the `test://` guard.
5. Run `npm run ingest -- --repo ./tmp/sampleproject` twice. Second run should report
   `Deleted: 29, Inserted: 29, Cache hits: 29, Embedded: 0`.
6. Draft the `CLAUDE.md` gotcha entry to scratchpad.

## Verification

- `npm test` green, `npm run typecheck` green (both configs).
- `npm run test:db` green, and the corpus row count is unchanged afterward.
- Manual: edit `./tmp/sampleproject`, insert a blank line above a chunked declaration, re-ingest, and
  confirm `start_line` in the database moved. This is the scenario the old `[REQ]` test froze.
- Manual: delete a declaration from `./tmp/sampleproject`, re-ingest, confirm its row is gone.
- Rollback if abandoned: `git checkout develop` and
  `TRUNCATE chunks; INSERT INTO chunks SELECT * FROM chunks_backup_20260817;`

All of the above ran green on 2026-08-18, with `./tmp/mini-demo` standing in for
`./tmp/sampleproject` as the manual corpus.

## Protected-file drafts

`CLAUDE.md` and `README.md` are protected; a `PreToolUse` hook blocks writes to both. These two
edits are what this block owes them. Apply by hand.

### 1. `CLAUDE.md` — add to Gotchas

Place after the `Never docker compose down -v` line:

```markdown
- Ingest is **destructive**. `replaceChunks` deletes every row for a `repo_source` and re-inserts
  the chunker's output inside one transaction, so after a successful run the table holds exactly
  what the chunker just produced — current line numbers, current vectors, nothing orphaned. The
  cost: a typo in `--repo` wipes that source's rows. The `DELETE` runs after embedding succeeds,
  so a failed embed leaves the corpus intact.
- `repo_source` is an **identity**, not a label. `./tmp/hono` and `/projects/.../tmp/hono` are two
  corpora; ingesting one will not clear the other.
- `Db.query` goes to `pool.query`, which takes an arbitrary connection per call — so
  `db.query('BEGIN')` and the next statement land on different connections, and the `COMMIT` warns
  `no transaction in progress` with no error raised. Anything transactional must go through
  `db.withTransaction`, which holds one `pool.connect()` client for the whole callback.
- `ON CONFLICT DO NOTHING` is still on the chunk INSERT, but only to collapse duplicate hashes
  within a single run. It is no longer what makes re-ingest idempotent — the `DELETE` is.
```

### 2. `README.md` — the destructive-ingest warning

The RISKS section of this plan requires this be named for users. Suggested wording, to place
wherever ingest is described:

```markdown
> **Ingest replaces, it does not merge.** Indexing a repo deletes everything previously indexed
> under that exact `repo_source` string and re-inserts the current chunks. This is what keeps
> line numbers and embeddings honest, and it means a mistyped `--repo` clears that source. The
> delete and the inserts share one transaction, so a failure part-way leaves the corpus as it was.
```
