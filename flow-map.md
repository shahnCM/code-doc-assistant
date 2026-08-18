# Flow map — code-doc-assistant

Both pipelines, file by file. Diagrams are Mermaid — they render on GitHub, and in any editor
with a Mermaid-aware Markdown preview.

**Reading the arrows**

```
──▶   solid   = a call going out
┈┈▶   dotted  = a result coming back
1·2·3          = order in time, across all diagrams
◇ = a decision      ⬭ = outside the process
```

---

## A · Two paths, one table

They never import each other. `ts-morph` parsing is synchronous CPU work — in a request handler
it would freeze every open SSE stream, so ingest is a CLI.

```mermaid
flowchart TD
  ING["<b>INGEST</b><br/>offline, CLI<br/>ingest/ + index/"]
  DB[("Postgres<br/>chunks")]
  QRY["<b>QUERY</b><br/>online, HTTP<br/>retrieve/ + generate/"]
  ING -->|"writes rows"| DB
  DB -->|"reads rows"| QRY
```

---

## B · Ingest — steps 1–9

```mermaid
flowchart TD
  N1["1 · cli.ts<br/>--repo"]
  N2["2 · acquire.ts<br/>path or clone"]
  N3["3 · walk.ts<br/>candidate<br/>or skipped"]
  N4["4 · classify.ts<br/>ext to language"]
  N5{"5 · chunkers<br/>/index.ts<br/>supports?"}
  N6["6a · ts-morph.ts<br/>ts tsx js jsx"]
  N7["6b · generic.ts<br/>everything else"]
  N8["7 · enrich.ts<br/>header + hash"]
  N9["8 · embed.ts"]
  CA[("cache<br/>.cache/embeddings")]
  GEM(["Gemini<br/>embedding-2"])
  N10["9 · store.ts<br/>replaceChunks<br/>DELETE then INSERT<br/>in one txn"]
  DB[("Postgres<br/>chunks")]

  N1 --> N2 --> N3 --> N4 --> N5
  N5 -->|"TS / JS"| N6
  N5 -->|"else"| N7
  N6 --> N8
  N7 --> N8
  N8 --> N9
  N9 -->|"look up hash"| CA
  CA -.->|"hit, free"| N9
  N9 -->|"miss, costs"| GEM
  GEM -.->|"768 floats"| N9
  N9 --> N10 --> DB

  style N7 stroke:#8F5510,stroke-width:2px
  style N10 stroke:#1F6F43,stroke-width:2px
```

**Orange — why generic is last.** Its `supports()` returns `true` for everything, same as a 404
handler at the bottom of an Express router. Put it first and `ts-morph` never runs.

**Green — step 9 used to be the one open defect.** It was
`INSERT ... ON CONFLICT (repo_source, content_hash) DO NOTHING`, and the hash excludes
`start_line`. Add an import at the top of a file, everything below shifts, content is unchanged,
hash is unchanged — the database kept the old line numbers, and the citation validator checked
against those same stale numbers, so a wrong citation was reported *valid*. Fixed by Block 9;
before and after in [section G](#g--what-block-9-changed-at-step-9).

---

## C · Query, retrieval half — steps 1–11

```mermaid
flowchart TD
  A["1 · useChatStream.ts<br/>POST /api/chat"]
  B["2 · routes/chat.ts<br/>zod + AbortSignal"]
  C["3 · sse.ts<br/>headers, flush"]
  D["4 · answer.ts<br/>answerQuestion"]
  E["5 · search.ts<br/>searchChunks"]
  F["6 · embedClient.ts<br/>embedBatch"]
  G(["Gemini<br/>embedding-2"])
  H["8 · fusion.ts<br/>HYBRID_SQL<br/>9 params"]
  I[("Postgres<br/>dense + lexical<br/>+ RRF")]
  J["10 · search.ts<br/>toRetrievedChunk<br/>string to number"]

  A --> B
  B --> C
  B -->|"for await"| D
  D --> E
  E --> F
  F --> G
  G -.->|"7 · 768 floats"| E
  E --> H
  H --> I
  I -.->|"9 · rows"| J
  J -.->|"11 · RetrievedChunk[]"| D

  style H stroke:#2E4A9E,stroke-width:2px
```

---

## D · Query, generation half — steps 12–20

```mermaid
flowchart TD
  D["answer.ts<br/>the generator"]
  K["12 · assemble.ts<br/>dedupe by file<br/>sort, budget"]
  T["14 · yield trace<br/>via sse.ts"]
  L["15 · prompt.ts<br/>system + contents"]
  M["16 · llmClient.ts<br/>stream"]
  N(["Gemini<br/>3.6-flash"])
  TK["18 · yield token<br/>via sse.ts"]
  O["19 · citations.ts<br/>parse, validate"]
  Z["20 · yield citations<br/>then done"]
  W(["browser"])

  D --> K
  K -.->|"13 · included[] + text"| D
  D --> T --> W
  D --> L
  L --> M
  M --> N
  N -.->|"17 · partial text, looped"| M
  M -.->|"GenChunk"| D
  D --> TK --> W
  D --> O
  O -.->|"valid / invalid"| D
  D --> Z --> W

  style O stroke:#2E4A9E,stroke-width:2px
```

---

## E · The 20 steps as a list

| # | File | What happens |
|---|---|---|
| 1 | `useChatStream.ts:64` | POST with `{ messages, repoSource }` |
| 2 | `routes/chat.ts:47` | zod validates; `AbortSignal.any` of disconnect + 30 s |
| 3 | `sse.ts:36` | headers written and flushed, heartbeat starts |
| 4 | `answer.ts:47` | last `user` message pulled out |
| 5 | `search.ts:79` | hands the question to the embed client |
| 6 | `embedClient.ts` | one call out to Gemini |
| 7 | ◀ back | 768 floats, already L2-normalised |
| 8 | `fusion.ts:36` | nine params, dense + lexical + RRF in one statement |
| 9 | ◀ back | rows, each with a dense rank, a lexical rank, or both |
| 10 | `search.ts:40` | `ROW_NUMBER()` arrives as a string, coerced to number |
| 11 | ◀ back | `RetrievedChunk[]` reaches the generator |
| 12 | `assemble.ts:57` | one chunk per file, sorted, packed to 8000 tokens |
| 13 | ◀ back | included list plus the rendered context text |
| 14 | `answer.ts:93` | `trace` goes out **before** generation starts |
| 15 | `prompt.ts:24` | context attached to the last user turn only |
| 16 | `llmClient.ts` | second call out to Gemini |
| 17 | ◀ back, looped | partial text, once per model chunk |
| 18 | `answer.ts:116` | each piece yielded as a `token` event |
| 19 | `citations.ts:22` | checked against `assembled.included` |
| 20 | `answer.ts:147` | `citations`, then `done` with timings |

---

## F · A real run, one file

Corpus: a single 12-line Express app whose only route is `/health`.
Question: *"how do we know if our app health is ok?"* Real embedding, real Gemini.

```
INGEST
  Files seen: 1 · Chunked: 0 · No declarations: 1
  kind=file  lines=1-13  symbol=NULL  signature=NULL

RETRIEVE                            825 ms
  id   dense  lex   fusedScore   file:lines
  174  1      -     0.016393     server.js:1-13

ANSWER                             5897 ms
  "...it returns a 200 HTTP status with the JSON
   response { status: 'ok' } server.js:6-8."

CITATIONS
  valid    server.js:6-8
```

**No declarations, and nothing lost.** `const app = express()` is not exported and `app.get(...)`
is an expression, not a declaration — so ts-morph found nothing to slice and fell to the whole-file
outcome. The file still got indexed, retrieved, and answered the question.

**The lexical leg returned nothing, for two separate reasons.** First,
`websearch_to_tsquery` ANDs the terms — it produced `'know' & 'app' & 'health' & 'ok'`, and *know*
appears nowhere in the file. Second, and sharper: searching `health` alone still misses, because
Postgres tokenises `/health` as a single *File or path name* lexeme, `'/health'`, which `health`
cannot reach inside. Same shape as `Math.sqrt` becoming a *Host* token. Code is full of strings
Postgres refuses to read as words — that is the concrete argument for keeping a dense leg.

```sql
-- verified
SELECT websearch_to_tsquery('english','how do we know if our app health is ok?');
--   'know' & 'app' & 'health' & 'ok'

SELECT alias, description, token FROM ts_debug('english', $$app.get('/health', req)$$);
--   host       | Host              | app.get
--   file       | File or path name | /health
```

**The citation is narrower than the chunk, and that is fine.** The model cited `server.js:6-8` from
a chunk spanning 1–13. Containment holds — `6 >= 1` and `8 <= 13` — so it validates.
`server.js:99-200` would come back `range-not-retrieved`; `other.js:1-5` would come back
`unknown-file`.

**Why the chunk says 1–13 when the file has 12 lines.** `wholeFileChunks` takes its end from
`sourceFile.getEndLineNumber()` (`ts-morph.ts:501`), and with a trailing newline the file's end
position sits on an empty line past the last statement. Reproduced directly:

```
trailing newline present → 2 lines of content, chunk reports 1-3
trailing newline absent  → 2 lines of content, chunk reports 1-2
```

Nearly every file in a real repo ends with a newline, so **every whole-file chunk over-reports
`end_line` by one.** Scope is narrow — declaration chunks take their bounds from the declaration
itself and are unaffected — but the consequence is real: a citation of `server.js:13` would pass
containment (`13 <= 13`) and point at a line that renders empty. Same family as everything else
here: small, silent, and it lands on the citation guarantee. Still open — deliberately left out of
Block 9, which fixed the store; this one lives in the chunker.

---

## G · What Block 9 changed, at step 9

Step 9 was insert-only. A re-ingest of unchanged content was free, and that property was the point
— but it was bought by skipping the whole row on conflict, including the columns the hash does not
cover.

**Before** — the row is skipped, and nothing anywhere reports it:

```mermaid
flowchart TD
  A["re-ingest<br/>content unchanged"] --> B["hash unchanged"]
  B --> C{"ON CONFLICT<br/>repo_source +<br/>content_hash"}
  C -->|"row exists"| D["DO NOTHING<br/>whole row skipped"]
  D --> E["stale start_line<br/>stale vector<br/>deleted code stays"]
  E --> F["citation checked<br/>against the stale row<br/>reported valid"]
  style F stroke:#A03328,stroke-width:2px
```

**After** — the post-condition is structural, so there is no per-column reasoning to get wrong:

```mermaid
flowchart TD
  A["re-ingest"] --> T["db.withTransaction<br/>one pooled client<br/>BEGIN"]
  T --> D["DELETE<br/>WHERE repo_source"]
  D --> I["INSERT every chunk<br/>DO NOTHING kept<br/>for same-run dupes"]
  I --> Q{"all ok?"}
  Q -->|"yes"| K["COMMIT"]
  Q -->|"no"| R["ROLLBACK<br/>corpus untouched"]
  K --> S["current lines<br/>current vectors<br/>no orphans"]
  style S stroke:#1F6F43,stroke-width:2px
  style R stroke:#8F5510,stroke-width:2px
```

### Before and after, attribute by attribute

| | Before | After |
|---|---|---|
| Statement | `INSERT ... ON CONFLICT DO NOTHING` | `DELETE ... RETURNING id`, then the same INSERT loop |
| Transaction | none — `pool.query('BEGIN')` lands on a different connection and silently does nothing | `db.withTransaction` holds one `pool.connect()` client for the whole step |
| Re-ingest, content unchanged | row skipped entire | row deleted and rewritten |
| `start_line` after a shift above it | stale | current |
| Vector after an embedding-model switch | stale; the new one is billed and discarded | current |
| Code deleted from the repo | row survives and stays retrievable | row gone |
| Failure mid-store | partial writes possible | `ROLLBACK`, corpus exactly as before |
| CLI report | `Upserted: 0` for both "nothing changed" and "everything rejected" | `Deleted: N` and `Inserted: N`, separately |
| `DO NOTHING` | what made re-ingest idempotent | only collapses duplicate hashes inside one run |

### Measured, on `./tmp/mini-demo`

13 chunks, 13/13 cache hits, zero Gemini calls in either run.

```
                        before Block 9        after Block 9
row ids after re-ingest  120-132 unchanged     175-187, all rewritten
CLI                      Upserted: 0           Deleted: 13, Inserted: 13

prepend 2 lines to src/api/client.ts, re-ingest:
  content_hash           5771efb8d3c8          5771efb8d3c8   (unchanged, as expected)
  PricingClient          4-20  (wrong)         6-22  (correct)
```

The hash staying identical while the lines move is the whole point — that is precisely the case
the old path could not see, and the case no error, warning, or metric would have surfaced.
