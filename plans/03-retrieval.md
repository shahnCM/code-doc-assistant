# Block 3 — Hybrid retrieval with RRF fusion

## Context

Blocks 1 and 2 (committed) turn `--repo <path|url>` into rows in a `chunks` table: a 768-dim
`embedding` column behind an HNSW cosine index, and a DB-generated `tsv` column behind a GIN index.
Nothing reads them back yet. `src/retrieve/` exists and is empty.

Block 3 closes that gap with the first half of the online path: given a natural-language question,
return the chunks most likely to answer it. Two legs — dense (pgvector cosine) and lexical
(`ts_rank` over `tsv`, plus an exact `symbol_name` boost) — fused with reciprocal rank fusion in one
SQL statement. Every returned chunk carries `denseRank`, `lexicalRank` and `fusedScore`, because
Block 5's trace panel shows all three and a fused score alone can't explain why a chunk surfaced.

Retrieval is language-agnostic here. Whether a chunk came from ts-morph or the generic chunker is
recorded in `chunker_kind` for the trace and nothing else — no weighting, no filtering. Call-graph
expansion (`symbol_edges`, TS/JS only) is Block 6 and deliberately absent.

No new dependencies. `src/retrieve/` may import `src/index/` (the `Db` seam, the embed client) and
never `src/ingest/`.

## Verified before planning (ran these, not recalled)

All read-only against the live dev database — `postgres://admin:admin@postgres-16:5432/codedocs`,
PostgreSQL 16.14, pgvector 0.8.6, current corpus 29 rows.

1. **The full fusion statement parses and executes.** `PREPARE hybrid (vector, text, int, text,
   float8, float8, int, float8, float8)` succeeded, and `EXECUTE` returned correct rows against real
   data. The statement in FILES below is the one that ran, not a sketch.
2. **RRF arithmetic matches hand computation to 7 decimals.** Query `session`, default weights:
   id 14 (dense 15, lexical 2) → `1/75 + 1/62 = 0.0294624`; id 16 (27, 1) → `1/87 + 1/61 =
   0.0278877`; id 15 (26, 3) → `1/86 + 1/63 = 0.0275009`.
3. **One-leg rows fuse correctly, with no NULL poisoning.** Same query returned ids 25/29/28 with
   `lexical_rank` NULL and `fused = 1/61, 1/62, 1/63` — `COALESCE(... , 0)` around each term is what
   makes a missing leg contribute zero instead of nulling the whole sum.
4. **A NULL `symbol_name` row survives the lexical leg.** id 28 (`symbol_name IS NULL`) ranked
   alongside boosted rows. The `CASE WHEN lower(symbol_name) = ... THEN $5 ELSE 0 END` form yields 0
   on a NULL comparison rather than NULL, so the boost adds without ever filtering.
5. **The exact-symbol boost works.** Query `add_one` put id 25 at lexical rank 1 with score 1.3380
   (= `ts_rank` 0.3380 + boost 1.0) and overall rank 1.
6. **Garbage input does not throw.** `websearch_to_tsquery('english', ':::  &&&')` returns an *empty
   tsquery* with a `NOTICE`, not an error; `@@` against it is false. `to_tsquery` would have raised
   a syntax error on the same input.
7. **HNSW is used, and window-function placement decides whether it is.** Unfiltered dense leg →
   `Index Scan using chunks_embedding_hnsw_idx`. Adding a `repo_source` predicate made the planner
   choose the existing unique btree + Sort — expected at 29 rows, and it confirms the filter is
   satisfiable from the leading column of `chunks_uniq_repo_source_content_hash` with no new index.
8. **`ROW_NUMBER()` is `bigint`.** `pg_typeof(ROW_NUMBER() OVER ())` → `bigint`, which `node-postgres`
   returns as a **string**, not a number. `pg_typeof` on the RRF expression → `double precision`, on
   `ts_rank` → `real`, on `<=>` → `double precision`; all three are parsed to JS numbers. So exactly
   two output columns need explicit coercion, and nothing in the type system would catch the miss.
9. **Tokenization.** `to_tsvector('english', 'upsertChunks createGeminiEmbedClient embed_text')` →
   `'upsertchunk':1 'creategeminiembedcli':2 'emb':3 'text':4`. camelCase is **one** lexeme;
   snake_case **splits** on the underscore. Query and document stem identically, so an exact symbol
   query still matches its own symbol.
10. **`ts_rank` normalization changes ordering.** Flag `0` (default) vs `1` (divide by log document
    length) reordered id 15 (content length 390) below id 14 (length 268) on the same query.
11. **Synthetic sparse vectors give exact cosine distances.** `[1,0,…]` against itself → 0.0,
    against `[0.6,0.8,0,…]` → 0.4, against `[0,…,1]` → 1.0, against `[-1,0,…]` → 2.0. A hand-written
    fixture therefore produces *known* dense ranks with zero API calls.
12. **The live corpus cannot exercise the chunker-kind contract.** All 29 rows are
    `chunker_kind: 'generic'`, `kind: 'block'`, one `repo_source`, `signature` NULL in 29/29 and
    `symbol_name` NULL in 24/29. `tmp/hono` is cloned but not ingested.

## Decisions

Settled with the human before writing this:

| Question | Decision |
|---|---|
| Where do the contract tests run, given fusion lives in SQL but the house rule is no real Postgres in `npm test`? | **A separate `npm run test:db`.** A fake `Db` can only return whatever fused score the test told it to return — it cannot verify arithmetic that executes inside Postgres, so faking the RRF test would make it decorative. Contract tests run against the real dev database via `vitest.db.config.ts` and a `*.db.test.ts` filename convention. `npm test` stays fully offline and green on a grader's machine with no database. |
| Repo scoping | **Optional `repoSource`, default all repos.** `WHERE ($4::text IS NULL OR c.repo_source = $4)`. Rides the leading column of the existing unique constraint — no new index (Verified 7). Doubles as the isolation mechanism for the seeded test fixture, and gives Block 4's server a per-request scope. |
| `ts_rank` normalization flag | **`1` — divide by log document length.** Unnormalized `ts_rank` systematically favours long chunks (Verified 10). Since generic chunks are uniform windows and ts-morph declaration chunks vary from a 3-line function to a 400-line class part, leaving it at 0 would tilt the lexical leg toward one chunker by size alone — exactly the starvation the fifth contract test exists to catch. |
| `websearch_to_tsquery` vs `plainto_tsquery` vs `to_tsquery` | **`websearch_to_tsquery`.** Never throws on arbitrary user input (Verified 6), and supports quoted phrases and `-exclusion` for free. `to_tsquery` raises a syntax error on unescaped punctuation, which is most code-shaped queries. |
| Per-leg weights | `denseWeight` / `lexicalWeight` params, both defaulting to `1.0`. At the defaults the expression is *exactly* standard RRF, so the hand-computed test stays standard. BUILD-PLAN Block 7 says each query category "tunes k, dense/lexical weight" — this is that knob, costing two params now instead of a rewrite later. |
| Lexical leg membership | `tsv @@ tsq **OR** lower(symbol_name) = lower(btrim($2))`. An exact symbol match enters the leg even when `websearch_to_tsquery`'s AND-semantics would exclude the row — "where is parseConfig defined" becomes `parseconfig & defin`, which the declaration itself may not satisfy. |
| Where `RetrievedChunk` lives | `src/shared/types.ts`. Block 5's trace panel consumes it, so it crosses the server/client boundary and the "all shared shapes live in `src/shared/types.ts`" rule applies. `RetrieveError` stays beside its implementation as a discriminated union, following the `EmbedError` precedent in `embedClient.ts`. |

## INTENT

Turn a natural-language question into a ranked `RetrievedChunk[]`, each carrying the evidence of how
it got there: its rank in the dense leg, its rank in the lexical leg, and the fused score that
ordered it. One embed call, one SQL round trip, no fusion arithmetic in JavaScript.

Out of scope: `symbol_edges` and call-graph expansion (Block 6), context assembly and generation
(Block 4), the eval harness (Block 7), any HTTP surface. `src/retrieve/` must not import from
`src/ingest/`.

## Extensibility / design

```
src/retrieve/fusion.ts   HYBRID_SQL + constants   the single statement; pure string, zero I/O
                         buildParams()            options → positional params, defaults applied
src/retrieve/search.ts   searchChunks()           embed → query → map; the one export Block 4 calls
                         toRetrievedChunk()       row → RetrievedChunk, exported for tests
```

The split exists so the statement is inspectable without a database and the orchestration is
testable without one. `fusion.ts` has no imports beyond types, which is what lets Slice 1's tests
assert structural invariants (`<=>` and never `<->`, per-leg `LIMIT`, window placement) in the
offline suite where they will actually be run on every commit.

`searchChunks` follows the `indexChunks` seam exactly: an all-optional options bag defaulted with
`??`, and ownership tracking so an injected `db` is never `end()`ed while a self-created pool always
is. Block 4's Express route injects a long-lived `Db` rather than minting a pool per request —
`createPgDb` builds a fresh `Pool(max: 10)` on every call and is a factory, not a singleton.

No `src/retrieve/types.ts`. `RetrievedChunk` goes in `src/shared/types.ts`; `RetrieveError` and
`RetrieveOptions` live in `search.ts` beside the function that returns and accepts them.

## FILES

**New — `src/retrieve/`**

| File | Responsibility |
|---|---|
| `fusion.ts` | `HYBRID_SQL` (below), tuning constants `RRF_K = 60`, `PER_LEG_LIMIT = 30`, `DEFAULT_TOP_K = 10`, `SYMBOL_BOOST = 1.0`, and `buildParams(vectorLiteral, query, options)` → the 9-element positional param array. Pure; no imports beyond types. |
| `search.ts` | `searchChunks(query, connectionString, embedModel, options)` → `Promise<Result<RetrievedChunk[], RetrieveError>>`. Embeds via `embedBatch([query])`, serializes `value[0]` with `toVectorLiteral`, runs `HYBRID_SQL` once, maps rows. Exports `toRetrievedChunk(row)` and the `RetrieveError` / `RetrieveOptions` types. |

**Modified**

- `src/shared/types.ts` — add `RetrievedChunk`. `denseRank` and `lexicalRank` are `number | null`:
  a chunk found by only one leg genuinely has no rank in the other, and `0` would be a lie the
  trace panel would render as a real rank.
- `src/index/db.ts` — export `toVectorLiteral(vector: readonly number[]): string`, moved up from
  `src/index/store.ts` where it is currently module-private. It is a pg serialization concern and
  `db.ts` is the shared pg boundary; duplicating the literal format in `src/retrieve/` would be two
  places to get `[a,b,c]` wrong.
- `src/index/store.ts` — import `toVectorLiteral` from `./db.js` instead of declaring it. No
  behaviour change.
- `vitest.config.ts` — `exclude` gains `'**/*.db.test.ts'` so the offline suite stays offline.
- `package.json` — `scripts` gains
  `"test:db": "node --env-file=.env node_modules/.bin/vitest run --config vitest.db.config.ts"`,
  mirroring how the existing `migrate` script loads `.env` under Node 24's native `--env-file`.
- `vitest.db.config.ts` (new) — `include: ['src/**/*.db.test.ts']` and `fileParallelism: false`.
  The fixture seeds and deletes rows in one shared table under one sentinel `repo_source`; parallel
  files would race each other's teardown.

**Tests** — `*.test.ts` beside each source file for the offline suite, plus
`src/retrieve/fusion.db.test.ts` for the contract suite. Hand-rolled fakes throughout, no `vi.mock`,
per the standing rule. The fixture is defined inline in the `.db.test.ts` file, following the
`testChunk()` builder precedent in `src/index/store.test.ts` rather than adding a data file under
`tests/fixtures/` (which holds a sample *repo*, not test data).

### The fusion statement (`src/retrieve/fusion.ts`)

Executed as written against the live database (Verified 1, 2).

```sql
WITH dense AS (
  SELECT id, dist, ROW_NUMBER() OVER (ORDER BY dist ASC, id ASC) AS dense_rank
  FROM ( SELECT c.id, c.embedding <=> $1 AS dist
         FROM chunks c
         WHERE $4::text IS NULL OR c.repo_source = $4
         ORDER BY c.embedding <=> $1
         LIMIT $3 ) d
),
lexical AS (
  SELECT id, score, ROW_NUMBER() OVER (ORDER BY score DESC, id ASC) AS lexical_rank
  FROM ( SELECT c.id,
                ts_rank(c.tsv, websearch_to_tsquery('english', $2), 1)
                  + CASE WHEN lower(c.symbol_name) = lower(btrim($2)) THEN $5 ELSE 0 END AS score
         FROM chunks c
         WHERE ($4::text IS NULL OR c.repo_source = $4)
           AND ( c.tsv @@ websearch_to_tsquery('english', $2)
                 OR lower(c.symbol_name) = lower(btrim($2)) )
         ORDER BY score DESC, c.id ASC
         LIMIT $3 ) l
)
SELECT c.id, c.repo_source, c.file_path, c.symbol_name, c.kind, c.signature,
       c.start_line, c.end_line, c.language, c.chunker_kind, c.content,
       d.dense_rank, l.lexical_rank, d.dist AS dense_distance, l.score AS lexical_score,
       COALESCE($8 / ($6 + d.dense_rank), 0)
         + COALESCE($9 / ($6 + l.lexical_rank), 0) AS fused_score
FROM dense d
FULL OUTER JOIN lexical l USING (id)
JOIN chunks c ON c.id = COALESCE(d.id, l.id)
ORDER BY COALESCE($8 / ($6 + d.dense_rank), 0)
       + COALESCE($9 / ($6 + l.lexical_rank), 0) DESC, c.id ASC
LIMIT $7;
```

| Param | Meaning | Default |
|---|---|---|
| `$1` | query embedding, `[a,b,c]` literal cast to `vector` | — |
| `$2` | raw query text | — |
| `$3` | per-leg limit | `30` |
| `$4` | `repoSource`, or SQL NULL for all repos | `null` |
| `$5` | exact-symbol boost added to `ts_rank` | `1.0` |
| `$6` | RRF `k` | `60` |
| `$7` | fused result limit | `10` |
| `$8` | dense weight | `1.0` |
| `$9` | lexical weight | `1.0` |

Four things that are easy to get wrong and are the reason the statement looks like this:

- **Each leg nests `ORDER BY … LIMIT` in a subquery, with `ROW_NUMBER()` applied outside.** Window
  functions are evaluated before the enclosing `ORDER BY`/`LIMIT`, so writing both in one SELECT
  makes Postgres rank the *entire* table before limiting — which throws away the HNSW top-k
  pushdown. The nested form keeps the index scan (Verified 7).
- **`COALESCE` wraps each RRF term separately**, not the sum. A chunk in only one leg has a NULL
  rank there; `$8 / ($6 + NULL)` is NULL, and `NULL + 0.016` is NULL, so a single outer `COALESCE`
  would silently zero the score of every one-leg chunk instead of crediting the leg that found it.
- **`FULL OUTER JOIN … USING (id)`** merges the key to `COALESCE(d.id, l.id)`, and the re-join to
  `chunks` uses that expression so one-leg rows still get their columns.
- **`ORDER BY` repeats the fusion expression** rather than referencing the `fused_score` alias.
  Postgres permits the alias; repeating it keeps the ordering explicit and independent of the select
  list, which matters when Block 6 wraps this statement for expansion.

`embedding`, `tsv` and `embed_text` are never selected — reading `embedding` back returns a string
(no pgvector type parser is registered), and CLAUDE.md's rule against large synchronous payloads
applies to every one of them.

### `RetrievedChunk` (`src/shared/types.ts`)

```ts
export interface RetrievedChunk {
  id: number;
  repoSource: string;
  filePath: string;
  symbolName: string | null;
  kind: ChunkKind;
  signature: string | null;
  startLine: number;
  endLine: number;
  language: string;
  chunkerKind: string;
  content: string;
  denseRank: number | null;
  lexicalRank: number | null;
  denseDistance: number | null;
  lexicalScore: number | null;
  fusedScore: number;
}
```

`denseDistance` and `lexicalScore` are beyond the brief's three required fields, and are here
because the trace panel showing `denseRank: 4` without the underlying cosine distance can't
distinguish "close fourth" from "distant fourth". They cost nothing — both are already computed in
the legs.

`toRetrievedChunk` must `Number()` the two rank columns. `ROW_NUMBER()` is `bigint` and
`node-postgres` hands int8 back as a **string** (Verified 8); `Db.query` returns
`Record<string, unknown>`, so nothing in the type system catches this and a string rank would flow
all the way to the trace panel and sort wrongly. Test 8 exists specifically for it.

### The fixture (`src/retrieve/fusion.db.test.ts`)

Six rows seeded under `repo_source = 'test://rrf-fixture'` via the existing `upsertChunks` — no new
insert SQL — and removed in `afterEach` with
`DELETE FROM chunks WHERE repo_source = 'test://rrf-fixture'`. Every query in the contract suite
passes `repoSource: 'test://rrf-fixture'`, so the fixture is invisible to the real corpus and the
real corpus is invisible to the tests.

Vectors are hand-written sparse 768-dim arrays built by a local `sparseVector()` helper, chosen so
cosine distance to the query vector `[1,0,0,…]` is exact and the dense ordering is fully determined
(Verified 11) — no embedding API call anywhere in the suite.

| Row | `chunker_kind` | `symbol_name` | vector | cosine dist | dense rank |
|---|---|---|---|---|---|
| B | `generic` | `null` | `[1,0,0,…]` | 0.0 | 1 |
| C | `ts-morph` | `loadSettings` | `[0.8,0.6,0,…]` | 0.2 | 2 |
| D | `generic` | `null` | `[0.6,0.8,0,…]` | 0.4 | 3 |
| E | `ts-morph` | `formatOutput` | `[0,1,0,…]` | 1.0 | 4 |
| F | `generic` | `null` | `[0,0,1,…]` | 1.0 | 5 |
| A | `ts-morph` | `parseConfig` | `[-1,0,0,…]` | 2.0 | 6 |

Row A is the point of the design. It is the only row whose content or symbol contains
`parseConfig`, and its vector is *anti*-parallel to the query, so it ranks **last** on the dense leg
at distance 2.0 — a value no non-negative embedding could produce, which removes any dependence on
id tie-breaking. A query of `parseConfig` therefore reaches rank 1 only if the exact-symbol boost
did the work. Seeding it at dense rank 1 would have produced a test that passes with the boost
deleted.

## TESTS

Written before the implementation in each slice, per the standing rule. The five required by the
brief are marked **[REQ]**.

### Slice 1 — fusion SQL

1. `HYBRID_SQL` contains `<=>` and does **not** contain `<->`. Guards the exact silent-degradation
   mode CLAUDE.md names — L2 returns plausible, worse results and nothing errors.
2. `buildParams` applies defaults in the documented positional order: `$3 = 30`, `$5 = 1.0`,
   `$6 = 60`, `$7 = 10`, `$8 = 1.0`, `$9 = 1.0`.
3. An omitted `repoSource` produces JS `null` at `$4` — never `undefined` and never the string
   `'null'`. `undefined` would bind as NULL by accident today and is one `pg` version away from
   throwing; the string would match no repo and silently return nothing.
4. Explicit overrides reach the right positions — a call with `{ rrfK: 10, topK: 3, denseWeight: 0 }`
   puts `10` at `$6`, `3` at `$7`, `0` at `$8`, and leaves the others at their defaults.
5. The statement carries `LIMIT $3` **twice** (once per leg) and `ROW_NUMBER() OVER` **twice**, each
   outside its limited subquery. Structural, but it is the regression that quietly costs the HNSW
   pushdown and would otherwise only show up as a slow query on a large corpus.

### Slice 2 — searchChunks orchestration

Hand-rolled fake `Db` and fake `EmbedClient`; no database, no network.

6. `searchChunks` calls `embedBatch` exactly once, with `[query]` as a single-element array, and
   binds `value[0]` at `$1` in `[a,b,c]` literal form.
7. Row mapping is complete and correct — every snake_case column lands on its camelCase field, for
   a row with all fields populated.
8. `dense_rank` and `lexical_rank` arrive as **strings** and are coerced to numbers. The fake `Db`
   returns `{ dense_rank: '6', lexical_rank: '1' }` (what `node-postgres` actually does with int8,
   Verified 8) and the test asserts `denseRank === 6`, `lexicalRank === 1` — strictly, so `'6'`
   fails.
9. A row absent from the lexical leg maps `lexical_rank: null` → `lexicalRank: null`, not `0`.
   `0` would render in the trace panel as a rank better than 1.
10. **[REQ]** An empty rowset returns `{ ok: true, value: [] }` and does not throw.
11. An embed failure short-circuits: the result is `{ ok: false, error: { kind: 'embed' } }` and the
    fake `Db` recorded **zero** queries — no point issuing SQL with no vector to bind.
12. An injected `db` is never `end()`ed; with no injected `db` a pool is created and ended even when
    the query rejects. Mirrors the ownership tracking in `src/index/embed.ts`.

### Slice 3 — contract tests against real Postgres (`npm run test:db`)

Seeded fixture above; every query scoped to `repoSource: 'test://rrf-fixture'`.

13. **[REQ] An exact symbol name query returns that symbol at rank 1.** Query `parseConfig`. Row A
    is dense rank 6 of 6 and lexical rank 1 (boost), fusing to `1/66 + 1/61 ≈ 0.0315450` against
    row B's dense-only `1/61 ≈ 0.0163934`, so A is result 0. Asserted on `results[0].symbolName`.
14. **[REQ] A purely conceptual query returns results the lexical leg alone would miss.** A query
    whose terms appear in no chunk's `tsv` still returns the dense neighbours; assert at least one
    result has `lexicalRank === null` and `denseRank !== null`. Already observed on the live corpus
    (Verified 3), asserted here deterministically.
15. **[REQ] RRF fusion against hand-computed ranks.** With `denseWeight`/`lexicalWeight` at their
    `1.0` defaults, assert exact scores for three known shapes: both legs `(6, 1) → 1/66 + 1/61`;
    dense-only `(1, null) → 1/61`; dense-only `(5, null) → 1/65`. Compared with `toBeCloseTo(…, 12)`
    — float8 round-trips through the driver, and asserting bit-identical doubles across a language
    boundary would be testing IEEE-754, not fusion.
16. **[REQ] Both chunker kinds are returned; neither is systematically starved.** A query matching
    content in both a `ts-morph` row and a `generic` row returns both kinds in the fused top-K, and
    a `generic` row with `symbol_name: null` has `lexicalRank !== null` — the nullable-boost
    requirement, asserted rather than assumed.
17. An empty scope returns `[]` from the real statement — the database-side counterpart of test 10,
    proving the `FULL OUTER JOIN` over two empty CTEs yields no rows rather than one all-NULL row.

Worth stating plainly, because it shapes what test 17 can mean: **the dense leg has no predicate on
the query text.** It returns up to `perLegLimit` rows whenever the scope is non-empty, however
unrelated the question. A genuinely empty result means an empty scope, not an unmatched query — and
that is correct behaviour for a RAG retriever, whose job is to return the best available candidates
and let generation decide they are insufficient.

## RISKS

- **HNSW plus a `repo_source` filter can under-return at scale.** `hnsw.iterative_scan = off` and
  `hnsw.ef_search = 40` in this database: a filtered dense leg asking for 30 may get fewer once the
  corpus is large enough for the planner to actually choose the HNSW index, because the filter is
  applied after the index returns its candidates. Unprovable at 29 rows (Verified 7). Mitigation if
  it appears: `SET hnsw.iterative_scan = relaxed_order` as a separate statement before the query —
  a session GUC, which does not violate "fusion in a single SQL statement".
- **camelCase symbols are a single lexeme.** `upsertChunks` is findable whole, but "upsert chunks"
  will not match it; snake_case splits and does (Verified 9). Accepted for this block — fixing it
  means a custom text-search configuration and a migration that rebuilds `tsv` for every row.
- **`file_path` and `js_doc` are not in `tsv`.** The generated column covers `symbol_name`,
  `signature` and `content` only, so a path-shaped query ("what's in src/retrieve/fusion.ts")
  reaches the dense leg alone. Changing it is a migration, out of scope here, and worth revisiting
  before Block 7's eval set is written rather than after.
- **Query embeddings have no cache and spend free-tier request budget on every search.**
  `EmbedCache` is keyed by chunk `contentHash` and has no key shape for a query string. Block 7's
  eval sweep is where this bites first — the same sweep CLAUDE.md already warns must be paced.
  Deliberately not solved here; a query-string cache is a small, separable addition.
- **No `taskType` split.** `embedClient` sends neither `RETRIEVAL_QUERY` nor `RETRIEVAL_DOCUMENT`,
  so question and code are embedded symmetrically. Asymmetric embedding usually helps retrieval, but
  adding it widens `GenAILike` and invalidates every stored vector — a separate change with a
  re-ingest attached, not a line in this block.
- **The contract tests sit outside `npm test` and can rot unnoticed.** That is the cost of the
  decision above. Mitigated only by process: Verification below requires `npm run test:db` alongside
  `npm test` before the block is done, and Block 4 should not start on a red `test:db`.
- **The live corpus cannot exercise test 16 today** — 29 rows, all `generic` (Verified 12). The
  seeded fixture makes the test real and deterministic, but it proves the *SQL* is fair, not that
  the corpus is. Ingesting `tmp/hono` for genuine TS/JS coverage is worth doing before Block 7.
- **`denseWeight: 0` still returns dense-only rows**, scored `0.0` and sorted last, rather than
  excluding them — observed while validating the weights. Harmless at the `1.0`/`1.0` defaults, and
  noted here so Block 7 is not surprised when it starts sweeping weights toward zero.
- **`ts_rank` normalization flag `1` is a judgement call, not a measured optimum.** It is the right
  default for mixed-size chunks, but it is one constant, and the eval harness in Block 7 is the
  first thing that could actually tell us whether `1`, `0`, or `2` retrieves better.

## TASKS

Tests first within every slice. One slice at a time; do not start the next unprompted. Each slice
ends with `npm test` and `npm run typecheck` clean, then a conventional commit.

**Slice 1 — fusion SQL**
1. Tests 1, 2, 3, 4, 5.
2. `src/retrieve/fusion.ts`.
   → `feat(retrieve): RRF fusion SQL for dense + lexical legs`

**Slice 2 — searchChunks orchestration**
3. Tests 6, 7, 8, 9, 10, 11, 12.
4. `src/retrieve/search.ts`; `src/shared/types.ts` gains `RetrievedChunk`; `src/index/db.ts` exports
   `toVectorLiteral` and `src/index/store.ts` imports it from there instead of declaring it.
   → `feat(retrieve): hybrid dense + lexical retrieval with RRF`

**Slice 3 — contract tests against real Postgres**
5. Tests 13, 14, 15, 16, 17.
6. `src/retrieve/fusion.db.test.ts` with the inline fixture; new `vitest.db.config.ts`;
   `vitest.config.ts` `exclude` gains `'**/*.db.test.ts'`; `package.json` gains the `test:db` script.
   → `test(retrieve): RRF and leg-fairness contract tests against seeded Postgres`

## Verification

Per-slice: `npm test` and `npm run typecheck` both clean.

End of block:

```bash
npm test          # offline suite — must be green with no database reachable
npm run typecheck # both tsconfigs
npm run lint
npm run test:db   # contract tests against postgres-16
```

Then a manual spot-check via `psql -h postgres-16 -U admin -d codedocs`, using the `PREPARE hybrid`
form from Verified 1, against the real ingested corpus rather than the fixture:

- A symbol query and a conceptual query both return rows with `dense_rank`, `lexical_rank` and
  `fused_score` populated — and at least one row where `lexical_rank` is NULL, proving the legs are
  genuinely independent.
- The fused ordering is **not** identical to the dense ordering. If it is, fusion is contributing
  nothing and either the lexical leg is empty or a weight is wrong.
- `EXPLAIN` on the dense leg still shows `Index Scan using chunks_embedding_hnsw_idx` when
  unfiltered.
- Confirm `SELECT count(*) FROM chunks WHERE repo_source = 'test://rrf-fixture'` returns `0` after
  `npm run test:db` — teardown left nothing behind.

**Commit.** `feat(retrieve): hybrid dense + lexical retrieval with RRF`
