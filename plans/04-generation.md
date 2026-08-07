# Block 4 — Generation & API

## Context

Block 3 (committed) ends with `searchChunks()` returning a ranked `RetrievedChunk[]`, each row
carrying `denseRank`, `lexicalRank` and `fusedScore`. Nothing consumes it. There is no HTTP
surface at all: `src/generate/` and `src/server/` do not exist, and `express` is not a dependency
of this project.

Block 4 closes the online path. A question becomes a token-budgeted context, a Gemini call, and a
streamed answer whose citations are parsed into structured refs and checked against the line
ranges we actually put in front of the model. Trace data — chunks, ranks, scores, timings,
language, `chunkerKind` — rides the same SSE stream, because `res.json()` on a large payload
blocks the event loop and the trace is the largest thing we send.

Two properties carry most of the weight of this block, and both are about honesty. A question the
corpus cannot answer must produce `not found in the indexed code` rather than an invention. And a
citation pointing at a range we never retrieved is a bug we detect, not a quirk we tolerate.

Call-graph expansion (Block 6), the React client (Block 5) and the eval harness (Block 7) are all
out of scope. `src/generate/` and `src/server/` may import `src/retrieve/` and `src/index/`, and
never `src/ingest/`.

## Verified before planning (ran these, not recalled)

Live checks against this container, the dev database, the shipped `@google/genai` typings, and the
real Gemini API. Line numbers refer to `node_modules/@google/genai/dist/genai.d.ts`.

1. **`express` is not installed.** Dependencies are `@google/genai`, `pg`, `pino`, `ts-morph`,
   `zod`; devDependencies carry no HTTP library and no `@types/express`. The registry resolves
   `express@5.2.1`, `@types/express@5.0.6`, `compression@1.8.1`, `supertest@7.2.2`.
2. **Node is v24.18.0, and `AbortSignal.any` / `AbortSignal.timeout` are both present.**
   `AbortSignal.any([ctrl.signal, AbortSignal.timeout(n)])` aborts when the controller aborts, and
   `signal.reason.name === 'AbortError'`.
3. **`generateContentStream` returns `Promise<AsyncGenerator<GenerateContentResponse>>`**
   (`genai.d.ts:10087`). It must be `await`ed *before* `for await`. Confirmed at runtime:
   `typeof stream === 'object'` with a `Symbol.asyncIterator` function.
4. **`GenerateContentConfig.abortSignal` exists** (`genai.d.ts:5127`), and the SDK's own doc
   comment reads: *"AbortSignal is a client-only operation. Using it to cancel an operation will
   not cancel the request in the service. You will still be charged usage."* CLAUDE.md's warning,
   in the vendor's words.
5. **Aborting a live stream mid-read throws `AbortError`.** Real call against `gemini-3.6-flash`,
   `ctrl.abort()` after the second chunk: threw with `name === 'AbortError'` and
   `instanceof DOMException === true`. `instanceof Error` alone does not distinguish it from a
   genuine failure, so the classifier must key on `name`.
6. **`GenerateContentResponse.get text(): string | undefined`** (`genai.d.ts:5338`) — the accessor
   really can be `undefined` on a chunk, so `?? ''` is required rather than defensive noise.
7. **`gemini-3.6-flash` is a thinking model, and thought tokens are charged against
   `maxOutputTokens`.** Real call with `maxOutputTokens: 20`: one chunk, `text === ''`,
   `finishReason === 'MAX_TOKENS'`, `usageMetadata.thoughtsTokenCount: 16`,
   `candidatesTokenCount` absent. A budget that is merely *too small* produces a **silently empty
   answer**, not an error.
8. **`thinkingConfig: { thinkingBudget: 0 }` is rejected by this model** — HTTP 400
   `INVALID_ARGUMENT`. The widely-copied "disable thinking" recipe does not work here.
9. **`thinkingConfig: { thinkingLevel: 'MINIMAL' }` works and removes thinking entirely** —
   `thoughtsTokenCount: undefined`, `finishReason: 'STOP'`, `text: "OK"`, 1373 ms end to end.
   `'LOW'` still spent 75 thought tokens on the same one-word answer. `ThinkingLevel` is a real
   SDK enum (`genai.d.ts:13069`: `MINIMAL | LOW | MEDIUM | …`) and a different field from
   `thinkingBudget` (`genai.d.ts:13055-13064`).
10. **The `/api/source` range query runs.**
    `PREPARE src (text, text, int, int) AS SELECT … FROM chunks WHERE repo_source = $1 AND
    file_path = $2 AND end_line >= $3 AND start_line <= $4 ORDER BY start_line ASC, part_index ASC`
    prepared and executed against the live corpus. Full-file, narrow-range and unknown-file
    (0 rows, no error) all behave.
11. **Generic-chunked files are contiguous; ts-morph files are not.** `noxfile.py` covers
    1-2, 3-7, 8-9, 10-18, 19-31, 32-42, 43-54 — no gap. Measured across the 2188-chunk hono run
    sitting in `chunks.json`: of 388 ts-morph files, **234 have leading or interior gaps**, and
    **11,034 of 63,271 lines are covered by no chunk at all** (imports, blank regions between
    declarations). A DB-backed `/api/source` cannot pretend a file is contiguous.
12. **There is no `repos` table and no stored root directory.** `\dt` shows `chunks` and
    `pgmigrations` only; `repo_source` is the raw `--repo` argument verbatim
    (`./tmp/sampleproject` today, a GitHub URL for the remote path). Reconstructing a filesystem
    root would mean duplicating `parseInput`/`targetDir` from `src/ingest/acquire.ts`, which the
    query path may not import.
13. **`estimateTokens` lives in `src/ingest/tokens.ts`** and is imported by `ingest/enrich.ts`,
    `ingest/chunkers/ts-morph.ts`, `ingest/chunkers/generic.ts` and three test files. Context
    assembly needs it, and `src/generate/` importing `src/ingest/` would break the two-paths rule.
14. **`src/config.test.ts:16` asserts `expect(result.value).toEqual(validEnv)`** — exact equality
    over all four keys. Adding `PORT` to `EnvSchema` breaks that line. One-line update, recorded
    here so it is not a surprise mid-slice.
15. **`npm run lint` is broken today** — `ESLint couldn't find an eslint.config.(js|mjs|cjs) file`.
    Pre-existing, unrelated to Block 3 or Block 4. The Verification section below must not claim
    it passes.

## Decisions

Settled with the human before writing this:

| Question | Decision |
|---|---|
| Which dependencies does Block 4 add? | **`express@5` and `@types/express@5`, nothing else.** No `compression`, no `supertest`. The brief's "exclude `/api/chat` from compression middleware" is then satisfied because there is no compression middleware to exclude — recorded as a documented non-issue with a comment at the mount point, not silently dropped. HTTP tests use `app.listen(0)` plus global `fetch`; `supertest` buffers the entire response, which makes an SSE stream untestable by construction. |
| Where does `GET /api/source` read from? | **The `chunks` table only.** No filesystem access, so no path-traversal surface, no dependency on `./tmp` still existing, and no root-directory reconstruction for remote repos (Verified 12). The cost is real and measured (Verified 11) and is paid openly: the response carries an explicit `gaps` array. |
| Does `POST /api/chat` accept conversation history? | **Yes — `{ messages: [{ role, content }], repoSource?, topK? }`.** Retrieval runs on the last user message only; earlier turns go into the prompt for continuity. Block 5's chat UI then needs no API change, and the alternative (single-turn now) would have meant a breaking change one block later. |
| How is the block sliced? | **Five slices.** Assembly · prompt + citations · LLM adapter · orchestration · HTTP. Every Express and SSE gotcha lands in slice 5 alone, which keeps them in one reviewable commit instead of smeared across the block. |

Decided without asking, noted for review:

- **`thinkingConfig: { thinkingLevel: 'MINIMAL' }`, `maxOutputTokens: 2048`, `temperature: 0`.**
  Forced by Verified 7-9: thinking is not disableable on this model, thought tokens eat the output
  budget, and `MINIMAL` is the only setting that spends none of it. An extractive, citation-following
  answer is the wrong job for extended reasoning regardless of cost.
- **`finishReason === 'MAX_TOKENS'` with empty accumulated text is an error, not an empty answer.**
  Verified 7 is precisely what a mis-sized budget produces, and it is invisible from the outside —
  a blank reply and a 200. Surfacing it is the only way a future `maxOutputTokens` change fails loudly.
- **Citations validate against the *included* chunks, not everything retrieved.** A chunk that lost
  the budget truncation was never shown to the model, so a citation to it is fabricated by exactly
  the same standard as a citation to a file we never indexed.
- **Containment, not overlap.** `120-145` is valid only if some included chunk's range fully
  contains it. Citing `120-145` when we supplied `100-140` means lines 141-145 the model never saw —
  the precise failure the brief calls "a bug, not a quirk", and overlap semantics would wave it through.
- **The refusal path never calls the LLM.** Empty retrieval emits the refusal sentence directly:
  deterministic, testable without a network fake, and one request saved against a free-tier quota.
- **`answerQuestion` is an `AsyncGenerator<ChatEvent>`.** The SSE layer serializes whatever it
  yields and owns no logic of its own, so the entire generation path is testable without HTTP and
  the same generator can feed a future MCP transport (Block 7.5) unchanged.
- **`PORT` joins `EnvSchema` with `.default(8080)`** instead of being read ad-hoc in the bootstrap —
  env parsing stays in `src/config.ts` per the architecture note. `.env` is protected and stays
  unedited; a zod default needs no new key there. Costs the one-line `config.test.ts` update from
  Verified 14.

## INTENT

Turn a question and its conversation history into a streamed, cited answer over SSE, with every
citation checked against the line ranges we actually supplied, and with a refusal that fires when
the corpus has nothing to say. One HTTP surface, bound `0.0.0.0`, cancellable on client disconnect
and on a deadline — both best-effort, and labelled as such in the stream rather than implied to be
a true cancel.

Out of scope: call-graph expansion (Block 6), the React client (Block 5), the eval harness
(Block 7), authentication, and any persistence of conversations.

## Extensibility / design

```
src/tokens.ts              estimateTokens          moved up from src/ingest/tokens.ts; pure, no I/O
src/generate/assemble.ts   assembleContext()       dedupe by file → order by fusedScore → truncate
src/generate/prompt.ts     buildSystemPrompt()     citation format + refusal sentence
                           buildContents()         history render, context on the last user turn
src/generate/citations.ts  parseCitations()        text → Citation[]
                           validateCitations()     Citation[] × included chunks → valid / invalid
src/generate/llmClient.ts  GenClient               narrow streaming interface
                           createGeminiGenClient() adapter over generateContentStream
src/generate/answer.ts     answerQuestion()        AsyncGenerator<ChatEvent>; the one export routes call
src/retrieve/source.ts     fetchSourceRange()      the /api/source query; DB access stays in retrieve/
src/server/sse.ts          openSse()               flushHeaders, one-line frames, heartbeat, teardown
src/server/app.ts          createApp()             routes, zod, single error boundary
src/server/routes/         chat.ts source.ts health.ts
src/server/index.ts        bootstrap               loadEnv, one long-lived pool, listen, timeouts
```

`GenClient` copies the `EmbedClient` shape in `src/index/embedClient.ts` exactly — a narrow
interface, a `createGeminiGenClient(ai, model)` taking a structural `GenAILike`-style type, and a
`realGenClient(model)` factory. That is what lets slice 3 test the adapter against a hand-rolled
fake with no network, and what keeps `@google/genai` out of every other module.

`answerQuestion` being a generator rather than a callback-taking function is the load-bearing
choice of the block. The SSE layer becomes a `for await` loop with no branching, slice 4's tests
assert the full event sequence as an array with no HTTP at all, and Block 7.5's MCP server can
consume the same generator.

`src/server/` holds no SQL. `/api/source` needs the database, so its query lives in
`src/retrieve/source.ts` alongside the fusion statement — one place where chunk-reading SQL lives,
consistent with the Block 3 boundary.

No `src/generate/types.ts` and no `src/server/types.ts`. Shapes Block 5 parses go in
`src/shared/types.ts`; `GenError` stays beside `llmClient.ts`, following the `EmbedError`
precedent.

## FILES

**New — `src/generate/`**

| File | Responsibility |
|---|---|
| `assemble.ts` | `assembleContext(chunks, options)` → `{ text, included, dropped, budgetExceeded }`. Dedupes by `filePath` keeping the best `fusedScore`, orders by `fusedScore` descending, renders each chunk as a header block, and drops whole blocks from the tail until the budget holds. `DEFAULT_CONTEXT_TOKEN_BUDGET = 8000`. |
| `prompt.ts` | `buildSystemPrompt()` and `buildContents(messages, contextText, options)`. Owns the literal citation format and the exact refusal sentence as exported constants so tests and the refusal path share one source. `MAX_HISTORY_TURNS = 8`. |
| `citations.ts` | `parseCitations(text)` → `Citation[]`; `validateCitations(citations, included)` → `CitationValidation`. Pure, no I/O. |
| `llmClient.ts` | `GenClient`, `GenError`, `createGeminiGenClient(ai, model)`, `realGenClient(model)`. The only module that imports `@google/genai` on the query path. |
| `answer.ts` | `answerQuestion(request, deps)` → `AsyncGenerator<ChatEvent>`. Retrieve → assemble → stream → validate, with one `AbortSignal` threaded through all three. |

**New — `src/server/`**

| File | Responsibility |
|---|---|
| `sse.ts` | `openSse(res, options)` → `{ send, comment, close }`. Sets the headers, calls `flushHeaders()`, starts the 15 s heartbeat, and clears it exactly once on `close()`. |
| `app.ts` | `createApp(deps)` → `express.Application`. Mounts routes and the single error boundary. Takes its `Db` and clients by injection so tests never open a pool. |
| `routes/chat.ts` | `POST /api/chat`. Zod body, `AbortController`, `AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)])`, `res.on('close')` guarded by `!res.writableFinished`, teardown that removes its own listener. |
| `routes/source.ts` | `GET /api/source`. Zod query, calls `fetchSourceRange`, 404 on no rows, `res.json()` on a span-capped payload. |
| `routes/health.ts` | `GET /health` (liveness, no DB) and `GET /ready` (`SELECT 1`, 200 or 503). |
| `index.ts` | Bootstrap. `loadEnv()`, one `createPgDb` pool for the process, `app.listen(PORT, '0.0.0.0')`, raised timeouts, SIGTERM/SIGINT shutdown that closes the server then ends the pool. |

**New — elsewhere**

- `src/tokens.ts` — `estimateTokens`, moved verbatim from `src/ingest/tokens.ts`. It is a pure
  string function needed by both paths, and `src/shared/` is types-only so it cannot live there.
  Same shape of move as `toVectorLiteral` in Block 3.
- `src/retrieve/source.ts` — `fetchSourceRange(db, params)` running the Verified 10 statement.

**Modified**

- `src/ingest/tokens.ts` — deleted; `src/ingest/tokens.test.ts` moves to `src/tokens.test.ts`.
  Import sites updated in `ingest/enrich.ts`, `ingest/chunkers/ts-morph.ts`,
  `ingest/chunkers/generic.ts`, `ingest/chunkers/ts-morph.test.ts`,
  `ingest/chunkers/generic.test.ts`. Mechanical, no behaviour change.
- `src/shared/types.ts` — gains `ChatMessage`, `Citation`, `CitationValidation`,
  `AssembledChunkTrace`, `SourceRange` and the `ChatEvent` union (below).
- `src/index/embedClient.ts` — `EmbedClient.embedBatch(texts, signal?)`. Passed to
  `embedContent` as `config.abortSignal`.
- `src/index/batch.ts`, `src/index/embed.ts` — thread the optional signal through, and guard
  `cache.set` so an aborted batch writes no partial cache entries.
- `src/retrieve/search.ts` — `SearchOptions` gains `signal?: AbortSignal`. Checked before the
  query is issued, because `node-postgres` ignores it (CLAUDE.md, and the same shape as the
  Gemini limitation).
- `src/config.ts` — `EnvSchema` gains `PORT: z.coerce.number().int().positive().default(8080)`.
- `src/config.test.ts` — the `toEqual(validEnv)` assertion gains `PORT: 8080` (Verified 14).
- `package.json` — `express` and `@types/express` added; scripts gain
  `"serve": "tsx --env-file=.env src/server/index.ts"` and
  `"dev:server": "tsx watch --env-file=.env src/server/index.ts"`.

**Not modified.** `CLAUDE.md` is protected and its Commands block does not list a server script.
Once slice 5 lands, it wants a `npm run dev:server` line — flag it and let the human make the edit.

### The event stream (`src/shared/types.ts`)

```ts
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
  /** Exactly as the model wrote it, so the UI can highlight the original span. */
  raw: string;
}

export type CitationProblem = 'unknown-file' | 'range-not-retrieved';

export interface CitationValidation {
  valid: Citation[];
  invalid: Array<{ citation: Citation; reason: CitationProblem }>;
}

export interface AssembledChunkTrace {
  id: number;
  filePath: string;
  symbolName: string | null;
  startLine: number;
  endLine: number;
  language: string;
  chunkerKind: string;
  denseRank: number | null;
  lexicalRank: number | null;
  fusedScore: number;
  /** False when the chunk was retrieved but lost dedupe or budget truncation. */
  included: boolean;
}

export type ChatEvent =
  | { type: 'trace'; chunks: AssembledChunkTrace[]; retrieveMs: number; contextTokens: number }
  | { type: 'token'; text: string }
  | { type: 'citations'; valid: Citation[]; invalid: CitationValidation['invalid'] }
  | { type: 'done'; finishReason: string; generateMs: number; totalMs: number }
  | { type: 'cancelled'; elapsedMs: number; estimatedTokensNotGenerated: number; note: string }
  | { type: 'error'; message: string };

export interface SourceRange {
  repoSource: string;
  filePath: string;
  startLine: number;
  endLine: number;
  blocks: Array<{ startLine: number; endLine: number; content: string }>;
  /** Line spans inside [startLine, endLine] that no chunk covers. Never rendered as code. */
  gaps: Array<{ startLine: number; endLine: number }>;
}
```

`ChatEvent` is a discriminated union rather than an optional-field bag, per the house rule, and it
is the contract Block 5's client parses. `cancelled` carries a `note` string rather than a boolean
because the honest statement — the service kept generating and still billed us — does not fit in a
flag.

### The context block format (`src/generate/assemble.ts`)

Each included chunk renders as:

```
--- src/retrieve/fusion.ts:36-68 (buildParams) [typescript] ---
<chunk content verbatim>
```

The symbol parenthetical is omitted entirely when `symbolName` is null — the generic chunker leaves
it null and inventing one would be the same lie the chunker refuses to tell. The header is the
exact string the citation validator later matches against, which is why test 7 pins it.

The unit of inclusion is the **whole rendered block**, header and content together. Budget
accounting measures the rendered block, so truncation can only ever drop a complete block; it
cannot leave a header with no body or a body with no header. If the single highest-scoring block
alone exceeds the budget it is included whole and `budgetExceeded: true` is set — returning an
empty context there would fire the refusal path for a question we did retrieve results for, which
is a worse failure than one oversized prompt. Both chunkers cap chunks near 512 tokens, so this is
a guard, not a common path.

### The `/api/source` statement (`src/retrieve/source.ts`)

Executed as written (Verified 10).

```sql
SELECT file_path, start_line, end_line, content
FROM chunks
WHERE repo_source = $1
  AND file_path = $2
  AND end_line >= $3
  AND start_line <= $4
ORDER BY start_line ASC, part_index ASC;
```

Range overlap on purpose: a chunk straddling the requested boundary must come back, or a citation
landing near the edge of a chunk would render blank. Gaps between returned blocks are computed in
TypeScript and reported in `SourceRange.gaps` — on ts-morph repos those gaps are the norm, not the
exception (Verified 11), and the client must render them as elision rather than as code.

The requested span is capped at `MAX_SOURCE_LINES = 400` before the query runs, which is what keeps
`res.json()` legitimate here despite CLAUDE.md's rule — the payload is bounded by construction,
unlike the trace, which goes down the SSE stream.

## TESTS

Written before the implementation in each slice, per the standing rule. Hand-rolled fakes
throughout, no `vi.mock`. Tests marked **[REQ]** are the ones the brief names.

### Slice 1 — context assembly

1. The `estimateTokens` move is behaviour-preserving: the relocated `src/tokens.test.ts` passes
   unchanged, and no file under `src/generate/` imports from `src/ingest/`.
2. **[REQ]** Dedupe by file: two chunks sharing a `filePath` yield one included entry — the higher
   `fusedScore` one — and the loser appears in the trace with `included: false`.
3. Ordering is by `fusedScore` descending regardless of input order. Input deliberately
   pre-sorted the wrong way, so a missing sort cannot pass by accident.
4. **[REQ]** Budget truncation drops whole blocks from the tail. With a budget that fits two of
   three blocks, the output contains exactly two headers and two bodies, the third is absent
   entirely, and the rendered text does not end inside a header line.
5. A single top block larger than the whole budget is included whole with `budgetExceeded: true`.
   Returning an empty context here would fire a spurious refusal.
6. Empty input returns `{ text: '', included: [], dropped: [] }` and does not throw.
7. The header line is exactly `--- <filePath>:<startLine>-<endLine> (<symbolName>) [<language>] ---`,
   and the parenthetical is omitted when `symbolName` is null. Pinned because slice 2's validator
   and Block 5's UI both parse it.

### Slice 2 — prompt and citation validation

8. The system prompt contains the literal citation format `path/to/file.ts:120-145` and the exact
   refusal sentence `not found in the indexed code`, both read from the exported constants rather
   than re-typed in the test.
9. History renders in order, is capped at `MAX_HISTORY_TURNS`, and the retrieved context attaches
   to the **last user turn only** — asserted by finding the context marker exactly once.
10. **[REQ]** `parseCitations` extracts `src/a.ts:10-20` as `{ filePath: 'src/a.ts', startLine: 10,
    endLine: 20 }`, and a bare `src/a.ts:10` normalizes to `startLine === endLine === 10`.
11. `parseCitations` ignores non-citation colons: `http://example.com`, `Error: boom` and
    `10:30am` in one paragraph produce zero refs.
12. **[REQ]** A citation naming a file absent from the included set is `invalid` with reason
    `unknown-file`.
13. **[REQ]** A citation whose range escapes every included chunk is `invalid` with reason
    `range-not-retrieved` — included `100-140`, cited `120-145`. This is the fabricated-range case
    the brief calls a bug.
14. Containment, not overlap: `120-145` inside an included `100-200` is valid, and the exact
    boundary `100-200` is valid. A test that only asserted overlap would pass with test 13 broken.

### Slice 3 — streaming Gemini client

Hand-rolled fake `GenAILike`; no network.

15. The adapter calls `generateContentStream` exactly once, with `systemInstruction`,
    `temperature`, `maxOutputTokens`, `thinkingConfig.thinkingLevel: 'MINIMAL'` and `abortSignal`
    all inside `config: {}` — and the module source contains neither `getGenerativeModel` nor
    `generationConfig`. Training data is full of the old shape (CLAUDE.md), so this is asserted,
    not trusted.
16. One `GenChunk` is yielded per SDK chunk, with `text` defaulting to `''` when the accessor is
    `undefined` (Verified 6).
17. `finishReason: 'MAX_TOKENS'` with empty accumulated text surfaces as an error, not as a
    successful empty answer. This is exactly what Verified 7 produced against the live API.
18. A 429 classifies as `rate-limit` or `daily-quota` on the same `PerDay` discriminator
    `classifyEmbedError` uses, and a parsed `retryDelay` reaches `retryAfterMs`.
19. **[REQ]** An `AbortError` from the SDK classifies as `kind: 'aborted'`, never `'other'`.
    Keyed on `error.name` (Verified 5), because `instanceof Error` is true for both.

### Slice 4 — answer orchestration

Fake `GenClient`, fake `Db`, fake `EmbedClient`, fake `EmbedCache`. No network, no database.

20. **[REQ]** Empty retrieval fires the refusal path: the emitted text contains
    `not found in the indexed code`, and the fake `GenClient` recorded **zero** calls.
21. Event order is `trace` → one or more `token` → `citations` → `done`, asserted on the collected
    array rather than on individual events.
22. The `trace` event carries `fusedScore`, `denseRank`, `lexicalRank`, `language`, `chunkerKind`
    and `included` for every retrieved chunk — including the ones dedupe and truncation dropped,
    which is the whole point of showing a trace.
23. **[REQ]** Abort propagates to the mocked LLM client: the signal handed to `stream()` reports
    `aborted === true`, and a `cancelled` event carries `elapsedMs` and
    `estimatedTokensNotGenerated`.
24. An already-aborted request issues **zero** SQL — the fake `Db` records no queries — because
    `node-postgres` ignores `AbortSignal` and the check must happen before the call.
25. **[REQ]** A cancelled embedding batch writes no partial entries to the content-hash cache: the
    fake `EmbedCache` records zero `set` calls when the batch aborts mid-flight.

### Slice 5 — Express 5 API and SSE

`createApp` with injected fakes, exercised over a real socket via `app.listen(0)` and global
`fetch`. No `supertest`.

26. `GET /health` returns 200 with an injected `Db` whose `query` throws — liveness must not touch
    the database.
27. `GET /ready` returns 503 when the DB check rejects and 200 when it resolves.
28. **[REQ]** `POST /api/chat` with a malformed body returns 400 from zod, with
    `content-type: application/json` — it never opens a stream, and never reaches
    `answerQuestion`.
29. SSE response headers carry `text/event-stream`, `Cache-Control: no-cache, no-transform` and
    `X-Accel-Buffering: no`, and `flushHeaders()` runs before the first event is written.
30. Every event serializes to exactly one `data:` line: a token whose text contains `\n\n` does not
    split the frame, because `JSON.stringify` escapes it.
31. The heartbeat comment is written on its interval, and the interval is cleared exactly once on
    `close()` — asserted by advancing fake timers past two intervals after close and observing no
    further writes.
32. **[REQ]** No listeners remain on `res` after abort: `res.listenerCount('close') === 0` once
    teardown has run.
33. **[REQ]** `AbortError` does not reach the error boundary as a 500. The boundary is a spy that
    records invocations; after a client disconnect it recorded none, and the response ended
    normally.
34. A **successful** response does not abort. `res.on('close')` fires on success too
    (CLAUDE.md), so the test asserts the controller is still unaborted after a clean finish —
    this is the guard that a naive `res.on('close', () => ctrl.abort())` would fail.
35. `GET /api/source` returns stitched blocks in `start_line` order and reports uncovered spans in
    `gaps`; an unknown file returns 404 rather than an empty 200.
36. `GET /api/source` caps the requested span at `MAX_SOURCE_LINES`, so an unbounded range request
    cannot produce an unbounded `res.json()` payload.
37. The server binds `0.0.0.0` — asserted on `server.address()` after `listen(0)`, not on a
    string in the source.

## RISKS

- **`/api/source` is DB-backed and lossy on ts-morph repos.** 234 of 388 files and ~17% of lines
  have no chunk covering them (Verified 11). The `gaps` array makes this visible rather than
  silent, but a user asking to see line 12 of a file whose first chunk starts at line 26 gets a
  gap marker, not code. Serving from disk would fix it and costs a `repos` table plus a
  path-containment check — a deliberate deferral, not an oversight.
- **Thinking tokens are charged against `maxOutputTokens` and cannot be disabled on
  `gemini-3.6-flash`** (Verified 7-9). `thinkingLevel: 'MINIMAL'` is a model-specific finding: if
  `GEN_MODEL` changes, re-run the check rather than assuming it carries, exactly as CLAUDE.md
  already says for the embedding model.
- **Both cancellation paths are best-effort, and the code says so.** Gemini's `abortSignal` is
  client-side only and still bills (Verified 4); `node-postgres` ignores `AbortSignal` entirely, so
  the pre-query check leaves an in-flight query running to completion. `pg_cancel_backend(pid)` is
  the real fix and needs the backend pid tracked per connection — future work, named in the README
  rather than implied away.
- **No `compression` dependency**, so the brief's "exclude `/api/chat`" requirement is vacuously
  satisfied today. `Cache-Control: no-transform` and `X-Accel-Buffering: no` are the
  standards-based guards that actually ship. A comment at the middleware mount point records the
  rule for whoever adds compression later; nothing in the test suite can enforce it.
- **Query embeddings are still uncached** (carried from Block 3). That was an eval-sweep concern
  there; here it is on the hot path of every single chat request, against a free-tier RPD budget
  this project has already exhausted once.
- **History is capped at 8 turns and counted before the context budget**, so a long conversation
  cannot crowd out retrieved code. The cap is a judgement call, not a measurement.
- **The 30 s deadline is a guess.** One trivial generation took 1373 ms at `MINIMAL` (Verified 9);
  a long grounded answer over an 8000-token context has not been timed. If it proves tight the
  fix is a constant, but the failure mode — a truncated answer that looks like a cancel — is
  confusing enough to be worth watching on the first real run.
- **Validating against *included* rather than *retrieved* chunks is deliberately strict** and will
  flag citations that look reasonable to a human reading the trace panel, because the trace shows
  dropped chunks too. That is the correct trade, but expect it to look like a false positive the
  first time it fires.
- **`npm run lint` cannot be part of the gate** until `eslint.config.js` exists (Verified 15).
  Pre-existing and out of scope for this block; worth fixing before Block 8 packages the project
  for a grader.
- **The corpus is still 29 rows of Python from `./tmp/sampleproject`.** The end-of-block `curl`
  gate will exercise generation honestly, but not TS/JS chunking, `signature` rendering, or
  ts-morph gaps in `/api/source`. Ingesting `tmp/hono` — already chunked to `chunks.json`, never
  embedded — is the fix, and remains flagged from Block 3.

## TASKS

Tests first within every slice. One slice at a time; do not start the next unprompted. Each slice
ends with `npm test` and `npm run typecheck` clean, then a conventional commit.

**Slice 1 — context assembly**
1. Tests 1-7.
2. `src/tokens.ts` created and `src/ingest/tokens.ts` deleted, with the six import sites and the
   relocated test updated; `src/generate/assemble.ts`.
   → `feat(generate): token-budgeted context assembly`

**Slice 2 — prompt and citation validation**
3. Tests 8-14.
4. `src/generate/prompt.ts`, `src/generate/citations.ts`; `src/shared/types.ts` gains
   `ChatMessage`, `Citation`, `CitationProblem`, `CitationValidation`.
   → `feat(generate): citation parsing validated against retrieved ranges`

**Slice 3 — streaming Gemini client**
5. Tests 15-19.
6. `src/generate/llmClient.ts`.
   → `feat(generate): streaming Gemini client with abort classification`

**Slice 4 — answer orchestration**
7. Tests 20-25.
8. `src/generate/answer.ts`; `src/shared/types.ts` gains `AssembledChunkTrace` and `ChatEvent`;
   `EmbedClient.embedBatch` gains an optional signal, threaded through `batch.ts` and guarded
   around `cache.set` in `embed.ts`; `SearchOptions` gains `signal`.
   → `feat(generate): answer orchestration with best-effort cancellation`

**Slice 5 — Express 5 API and SSE**
9. Tests 26-37.
10. `npm i express && npm i -D @types/express`; `src/retrieve/source.ts`, `src/server/sse.ts`,
    `src/server/app.ts`, `src/server/routes/{chat,source,health}.ts`, `src/server/index.ts`;
    `PORT` added to `EnvSchema` and asserted in `src/config.test.ts`; `serve` and `dev:server`
    scripts.
    → `feat(server): Express 5 API with SSE streaming and cancellation`

## Verification

Per-slice: `npm test` and `npm run typecheck` both clean.

End of block:

```bash
npm test          # offline suite — green with no database and no network
npm run typecheck # both tsconfigs
npm run test:db   # Block 3 contract tests still green
```

`npm run lint` is excluded deliberately — it has no config file and fails for reasons predating
this block (Verified 15).

Then the BUILD-PLAN gate, run **from a host terminal, not inside this container**. That is what
proves the `0.0.0.0` bind and the published port range in one shot; running it from inside would
pass even with a `localhost` bind and prove nothing.

```bash
curl -s localhost:8080/health
curl -s localhost:8080/ready
curl -N -X POST localhost:8080/api/chat -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"How does the ingest pipeline route files to a chunker?"}]}'
curl -N -X POST localhost:8080/api/chat -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What is the airspeed velocity of an unladen swallow?"}]}'
```

Expected, and worth checking rather than glancing at:

- The answerable question streams `trace` first, then tokens, and its `citations` event carries an
  **empty `invalid` array**. A non-empty one means the model cited a range we never supplied and
  the validator caught it — interesting, but not a pass.
- The unanswerable question produces `not found in the indexed code` rather than an invention.
  This is the gate BUILD-PLAN calls out explicitly.
- Disconnecting mid-stream (Ctrl-C on the `curl`) produces a `cancelled` event in the server log
  with a non-zero `elapsedMs`, and **no 500** in the error boundary.
- `SELECT count(*) FROM chunks WHERE repo_source LIKE 'test://%'` is still `0` — the HTTP tests
  must not have leaked fixture rows.

**Commit + tag.** After slice 5: `git tag v0.1-working`.
