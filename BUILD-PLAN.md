# Code Documentation Assistant — 18h Agentic Build Plan

Every block runs **PLAN → EXECUTE → VERIFY**. Each ends with tests green, a commit, and an
artifact in the repo. Nothing important lives in chat.

**Tests are a gate, not a phase.** Test cases go into the block's plan file *before*
implementation tasks, and a `Stop` hook refuses to let a block close red.

---

## Scope — what this indexes

The application is written in TypeScript. That is independent of what it can *read*.

- **TypeScript / JavaScript** (`.ts .tsx .js .jsx .mts .cts`) → ts-morph, declaration-level
  chunks with signatures, jsDoc and call-graph edges. This is the deep path.
- **Everything else** → a generic structural chunker: brace/indent-aware block splitting with
  the same enrichment header and the same `Chunk` shape, minus the fields we can't honestly
  fill.

The honest claim, and the one the README makes: *optimised for TypeScript/JavaScript, other
languages supported via generic structural chunking.* That is a stronger product than either
"TypeScript only" or a half-built five-grammar tree-sitter matrix at hour 14.

**Sources:** `--repo` takes a local path **or** a public GitHub HTTPS URL (`git clone --depth 1`
into `./tmp/`). Local paths cover private repos without building auth; public URLs mean a
grader can point it at anything. No SSH, no tokens — named as a limitation, not hidden.

---

## Verified environment

Confirmed by running the commands, not by reading the repo. These are facts.

| Thing | Value |
|---|---|
| Postgres container | `postgres-16` (custom image, `FROM postgres:16` + GIS + pgvector) |
| pgvector | **0.8.6** — confirmed via `SELECT extversion FROM pg_extension` |
| Credentials | `admin` / `admin` |
| Database | `codedocs` — created, empty, `vector` extension installed |
| Connection string | `postgres://admin:admin@postgres-16:5432/codedocs` |
| Docker network | `common` |
| Projects mount | `/home/<user>/dev/projects` (host) → `/projects` (container) |
| Published port ranges | `8000-8099`, `3000-3010`, `5173-5180` |
| Node | **24.18.0**, pinned in `.mise.toml` |
| Embedding model | **gemini-embedding-2** — 768 dims, auto-normalized, needs Content-wrapping |
| Generation model | **gemini-3.6-flash** — streams via `generateContentStream` |
| Parser | **ts-morph** — installed, TS/JS path only |

**Port picks** (all inside published ranges, so they reach `localhost` either way):
API `8080` · Vite dev `5173`

Project location: `/projects/code-doc-assistant`

### Runtime home — settled, do not revisit

VS Code Dev Containers, **attached to the running `workstation` container** as user `dev`.
Attached-container config sets `remoteUser: dev` and `workspaceFolder`. Consequences that
matter every hour of this build:

- **`DATABASE_URL` is the `postgres-16:5432` form.** The `localhost:5433` variant only applies
  from the host and is now purely a way to get it wrong. One value, in `.env`, once.
- **No docker CLI inside the container.** `docker compose` and `bin/dev` are host-terminal
  commands. Anything against the database from inside is `psql -h postgres-16 -U admin`.
  Keep one host terminal open alongside the VS Code window.
- **The VS Code extension does not put `claude` on your PATH.** It bundles a private CLI for
  the panel. `claude mcp add`, `claude doctor` and `claude --resume` are unavailable unless
  you separately install the CLI. MCP is configured by file instead — see Block 0.
- **Claude's Bash tool runs non-interactive**, so it gets no `mise activate` and resolves node
  through `/opt/mise/shims`. `.mise.toml` in the project root keeps both paths on 24.18.0.
  If a command works in your terminal but not for Claude, check `env | grep PATH` first.
- **The guard hook only sees Claude's Bash tool.** Your own host terminal is unprotected —
  that is where a `docker compose down -v` would actually come from.

### Already done (before the clock starts)

- [x] Project renamed to `code-doc-assistant`, `workspaceFolder` updated, reattached as `dev`
- [x] `postgres-16` up; projects mount verified via `docker inspect`
- [x] `codedocs` created, empty (`\dt` → no relations), `vector` 0.8.6 confirmed
- [x] `.mise.toml` pinning node 24.18.0; `which node` → `installs/node/24.18.0`
- [x] `git init` on `main`, `npm init`, `type: module`, dev dependencies, npm scripts
- [x] esbuild postinstall approved and verified against a real TS transform
- [x] Split tsconfigs, `src/shared/types.ts` stub, `npm run typecheck` clean
- [x] `.env.example`, `.gitignore`, `.mcp.json`
- [x] `guard.sh` + `stop-gate.sh` (exit 2 verified), `settings.json`, both subagents
- [x] Root commit `chore: agent scaffolding, hooks, subagents`

- [x] Gemini key in `.env`; models verified by smoke test (`gemini-embedding-2`, `gemini-3.6-flash`)
- [x] `@google/genai` installed; embedding contract confirmed (Content-wrapping, 768d, order)
- [x] `ts-morph` installed

Remaining: `protect.sh` + hook registration, one live hook test from the panel. Then Block 1.

---

## Concurrency notes — reference, and README material

Framework choice is close to irrelevant here: each request costs one embedding call, one
Postgres query, and an LLM stream running for seconds. That dominates everything. What
actually matters, in order:

1. **Event-loop blocking.** ts-morph parsing is synchronous CPU work; so, more cheaply, is the
   generic chunker. Ingest stays a separate CLI process precisely so one indexing run can't
   freeze every SSE stream in flight. If you ever expose indexing as an endpoint, it goes in a
   `worker_thread` or a queue — never inline.
2. **Bounded upstream concurrency.** Semaphore at 5 for embeddings. Unbounded `Promise.all`
   turns a rate limit into a cascade of retries.
3. **Postgres pool sizing.** `pg` Pool max 10–20 per instance. HNSW search is CPU-bound inside
   Postgres; a larger pool just queues. `max_connections=200` is the shared ceiling, not a goal.
4. **SSE lifecycle.** Long-lived sockets need heartbeats, disconnect cleanup, and timeouts
   raised above the stream lifetime. Leaked listeners on abandoned streams are the slow leak
   you won't notice in an 18-hour build but should name in the README.
5. **Synchronous serialization.** `JSON.stringify` blocks. Large trace payloads go down the
   stream incrementally, not through `res.json()`.

Write points 1 and 4 into your productionise section. They demonstrate you know where Node
actually breaks, which is worth more than a framework benchmark.

## Decisions already made — raw material for the README

Terse notes. Rewrite these in your own words; do not paste them.

- **Two chunkers, not one, and not five.** The implementation language (TypeScript) and the
  languages the tool can *index* are independent concerns; coupling them would have been an
  accident, not a decision. ts-morph gives real declaration boundaries, signatures, jsDoc and
  call-graph edges for TS/JS — that depth is the differentiator and it stays. A per-language
  tree-sitter matrix would have bought breadth at the cost of five grammars, five node-type
  maps and five sets of edge cases inside an 18-hour budget. The generic structural chunker
  already existed as the parse-failure fallback; promoting it to a first-class route cost an
  extension check and bought every other language at once. Named as a deliberate tier, with
  tree-sitter as the obvious next increment.
- **Extension-based routing, no content sniffing.** Extensions are wrong occasionally and
  cheaply; sniffing is a subsystem. The fallback is already safe, so a misroute degrades to
  generic chunking rather than failing.
- **Express 5, not Next.js.** Ingest is CPU-bound parsing work that must be a separate process
  regardless, so a fullstack framework covers half the system while inserting a layer between
  you and the SSE socket. Cancellation semantics are the interesting part of this app.
- **One package, two entry points, not FE/BE split repos.** Shared event and citation shapes
  import directly from `src/shared/types.ts`; no workspace resolution to maintain. Vite builds
  to `dist/web`, Express serves it — one container, one port for the grader. The boundary is
  already HTTP, so splitting the web tier later is a deployment change, not a rewrite.
- **No tRPC.** End-to-end types already exist by construction in a single package. tRPC would
  wrap the one endpoint that specifically needs unwrapping, and it's four routes, not forty.
- **No orchestration framework (LangChain / LlamaIndex).** The pipeline is four steps you
  control; a framework here costs debuggability at every stage and owns your prompt assembly.
  The brief asks about this explicitly — the answer must be written down, not implied.
- **MCP is not in the request path.** A subprocess and a protocol hop replacing a function
  call your own backend already owns. See the optional stretch block for the version that
  is actually interesting.
- **Google Gemini for both embedding and generation, not OpenAI/Anthropic.** One provider, one
  key, no card, and the free tier is genuinely sufficient for this workload — Flash for
  generation, the embedding endpoint has token headroom far past what one repo needs. The real
  cost is rate limits (RPM/RPD, not just tokens), not quality — named honestly rather than
  hidden, and mitigated by pacing eval sweeps and caching by contentHash. The client is
  isolated behind one interface, so swapping to a paid provider later is a config change.

## Routing table — pick the brain before you type

| Work | Mode | Model | `/effort` |
|---|---|---|---|
| Plans, architecture, chunking design | Plan (`Shift+Tab` ×2) | Opus | `xhigh` |
| Feature slices, tests, wiring | Accept-edits | Sonnet | `high` |
| Renames, scaffolds, config files | Accept-edits | Haiku | `low` |
| Reviewing a diff | Default | Opus | `high` |

### Working in VS Code

The configuration surface is identical to the terminal — `CLAUDE.md`, `.claude/agents/`,
`.claude/settings.json`, `.mcp.json` and slash commands all behave the same. What changes is
review ergonomics, and it changes in your favour:

- **Diffs render in VS Code's native diff viewer.** The "pause and skim the diff" step from the
  core loop stops being a chore. Actually do it at every checkpoint — this is the single
  biggest advantage you have over working in a terminal.
- **Selection is context.** Highlight the function you're talking about before prompting,
  instead of describing where it lives.
- **Keep an integrated terminal open** for `psql` and `npm run ingest`, and a **host** terminal
  for `docker compose`. Claude's Bash tool and your own terminals are separate — you want eyes
  on all of them.

**Context hygiene, non-negotiable:**
- `/clear` at every block boundary. New block = new task = fresh window.
- `/compact` if a block runs long but isn't done.
- `/context` before starting any block. Past ~60% and the agent loses the architecture.
- `@` specific files, never folders. `#` to append a lesson to CLAUDE.md the moment you hit one.

---

# BLOCK 0 — Agent setup (0:00 → 1:15)

The highest-leverage 75 minutes of the day. You're building the machine that builds the thing.

### Remaining setup

```bash
cd /projects/code-doc-assistant
npm i @google/genai ts-morph
```

Then put a Gemini key in `.env` (free, no card — aistudio.google.com), and confirm
`.env.example` still lists the keys with empty values.

Everything else in this block is done — see the checklist above. What's left is the protect
hook and the live hook test.

**Skip `/init`.** It exists to scan an existing codebase and describe what it finds. `src/` is
empty apart from a types stub, so it has nothing to read — it would generate boilerplate and
overwrite a CLAUDE.md whose every fact was verified by running commands. There is no upside
here. Run it later only if you want a second opinion once real code exists, and diff it rather
than accepting it.

Instead, make the settled files structurally unwritable. `.claude/protect.sh`:

```bash
#!/usr/bin/env bash
path=$(jq -r '.tool_input.file_path // .tool_input.path // ""')
[ -z "$path" ] && exit 0
case "$(basename "$path")" in
  CLAUDE.md|README.md|BUILD-PLAN.md|.env|.mcp.json|settings.json|guard.sh|stop-gate.sh|protect.sh)
    echo "protect.sh: $(basename "$path") is settled. Ask before changing it." >&2
    exit 2 ;;
esac
```

Register it as a second `PreToolUse` entry alongside the Bash guard:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/guard.sh" }] },
      { "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/protect.sh" }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "$CLAUDE_PROJECT_DIR/.claude/stop-gate.sh" }] }]
  }
}
```

Hooks only intercept Claude's tools — you editing these files in VS Code is unaffected, and
`git checkout -- <file>` remains the backstop for anything that slips through. One trade-off:
the `#` memory shortcut writes to CLAUDE.md, so it may now be blocked. If you want it back,
drop `CLAUDE.md` from the case list and rely on the diff review instead.

### Subagents — `.claude/agents/`

**`code-critic.md`** — read-only, runs at every VERIFY:
```markdown
---
name: code-critic
description: Reviews a diff against the current plan file for scope creep, type safety, and test coverage.
tools: [Read, Grep, Glob, Bash]
---
You are a senior TypeScript reviewer. For the current diff check:
1. Scope — does every changed file appear in the plan's FILES section? Flag anything extra.
2. Types — any `any`, unchecked index access, or unsafe cast.
3. Tests — does each plan TEST case have a real assertion, not a smoke test.
4. Errors — any silently swallowed catch.
5. Imports — any relative import missing its `.js` extension; any runtime code at all in
   src/shared (types only); any src/web import of src/config.ts or src/logger.ts.
6. Routing — any code outside src/ingest/ that branches on chunkerKind or language; any
   generic-chunker path that fabricates a signature or jsDoc.
Return a markdown table: File | Issue | Severity | Fix. If clean, return "APPROVED".
```

**`chunk-inspector.md`** — the textbook subagent case: eats a huge file, returns a short verdict:
```markdown
---
name: chunk-inspector
description: Audits chunks.json for chunking quality. Reads the whole file, reports concisely.
tools: [Read, Bash]
---
Sample 30 chunks across different kinds, languages and chunkerKinds. Report ONLY:
- Chunks that split mid-declaration or mid-block
- Chunks missing an enrichment header
- Chunks under 20 tokens (probably useless) or over budget
- Symbols present in the source but absent from chunks.json
- Generic-chunker chunks carrying a non-null signature or jsDoc (these must be null)
- Files routed to the wrong chunker for their extension
Return a bullet list of concrete defects with file paths. No praise, no summary.
```

### Hooks — `.claude/settings.json`

**Exit code 2 is the only code that blocks.** Anything else is a non-blocking error that is
logged and ignored — which is why a bare `npm test` as a `Stop` hook enforces nothing. Both
hooks are wrapper scripts that translate failure into exit 2.

`.claude/guard.sh`:
```bash
#!/usr/bin/env bash
cmd=$(jq -r '.tool_input.command // ""')
for pat in 'rm[[:space:]]+-rf' 'compose[[:space:]]+down.*-v' 'DROP[[:space:]]+(TABLE|DATABASE)'; do
  if [[ "$cmd" =~ $pat ]]; then echo "guard.sh blocked: /$pat/" >&2; exit 2; fi
done
```

`.claude/stop-gate.sh` — the `stop_hook_active` check is the anti-loop guard; without it one
red test turns the session into an endless loop:
```bash
#!/usr/bin/env bash
input=$(cat)
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ] && exit 0
for c in "npm test" "npm run typecheck"; do
  if ! out=$($c 2>&1); then
    { echo "$c failed — fix before stopping."; tail -30 <<<"$out"; } >&2
    exit 2
  fi
done
```

`.claude/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/guard.sh" }] }],
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "$CLAUDE_PROJECT_DIR/.claude/stop-gate.sh" }] }]
  }
}
```

No `PostToolUse` typecheck. Running `tsc` after every edit fights the write-the-test-first
rule — it is *supposed* to be red for the first half of every slice. The stop gate covers it.

**Smoke-test the guard before you trust it**, both from the shell and from the panel:
```bash
bash .claude/guard.sh <<< '{"tool_input":{"command":"docker compose down -v"}}'; echo "exit=$?"
```
Expect `exit=2`. Then ask Claude in the panel to run the same command and confirm it's blocked.
Finding out the hook path is wrong at hour 14 is the bad version of this.

### MCP — `.mcp.json`, not `claude mcp add`

The extension doesn't put `claude` on your PATH, and a project-scoped file is better anyway:
it's committable, which is direct evidence for "how do you make AI-assisted development
repeatable and maintainable".

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"]
    }
  }
}
```

`${VAR}` expands, so this commits clean. Lets Claude inspect the chunks table without dumping
rows into context. Note the reference Postgres server is archived — fine for a read-only local
dev database, worth one honest sentence in the README rather than pretending otherwise.
Optionally add Context7 for current ts-morph and pgvector docs; the ts-morph API is genuinely
easy to hallucinate. Skip everything else — each server costs window before you type a word.

**Commit.** `chore: agent scaffolding, hooks, subagents`

---

# BLOCK 1 — Acquisition, routing & chunking (1:15 → 4:15)

The highest-scoring code in the project. Give it Opus and real planning time.

### PLAN — Plan mode · Opus · `/effort xhigh`

```
plan: language-routed chunking for the ingest pipeline.

Read @CLAUDE.md and @src/shared/types.ts first.

Goal: turn any source repository — local path or public GitHub URL — into chunks ready for
embedding. Depth for TypeScript/JavaScript, honest coverage for everything else.

Acquisition:
- --repo accepts a local path OR a public https GitHub URL.
- URLs: git clone --depth 1 into ./tmp/<name>. Local paths used in place, never copied.
- Record the resolved commit SHA on the ingest run — the README reports it.

Routing (by file extension only, no content sniffing):
- .ts .tsx .js .jsx .mts .cts  → ts-morph declaration chunker
- everything else              → generic structural chunker
- Skip binaries, lockfiles, node_modules, .git, and files over 1MB.

TS/JS chunker:
- ts-morph only. No regex parsing.
- Chunk unit is the declaration: function, class, method, interface, type alias, enum,
  exported const.

Generic chunker:
- Split on blank-line-separated top-level blocks, respecting brace/bracket depth so a block
  is never cut mid-nesting. Indentation-aware for Python-style languages.
- Merge blocks under the minimum size, split blocks over the token budget.
- Best-effort symbolName from the first line when it looks like a definition; null otherwise.
  Do NOT fabricate signatures or jsDoc.

Both chunkers emit one Chunk shape: filePath, symbolName (nullable), kind, signature
(nullable), jsDoc (nullable), startLine, endLine, parentSymbol (nullable), isExported,
contentHash, language, chunkerKind.

- Declarations/blocks over the token budget split by statement block, enrichment header
  repeated on every part, tagged partIndex/partTotal.
- A file that fails its chunker must not abort the run — fall back to a line-window chunk,
  count it, report at the end.

Write plans/01-chunking.md with INTENT, FILES, TESTS, RISKS, TASKS.
TESTS come before implementation tasks and must cover: an oversized TS function, an
unparseable TS file, a method nested in a class, a barrel re-export, a file with zero
declarations, a Python file routed to the generic chunker, and an unknown extension.

DO NOT write code. DO NOT install packages. ts-morph is already installed.
STOP WHEN plans/01-chunking.md exists and you have asked me every open question.
```

Read the plan properly. If any section is vague, it isn't ready — push back before executing.

### EXECUTE — Accept-edits · Sonnet · `/effort high`

Four slices, `/compact` between them if the window fills:

```
Execute slice 1 of @plans/01-chunking.md — repo acquisition, file walker, language router.
Write the plan's tests first, then the implementation.
Hand-write fixtures in tests/fixtures/sample-repo/. Do not copy from node_modules.
DO NOT touch src/index/ or src/retrieve/.
STOP WHEN npm test and npm run typecheck are both clean.
```

Then slice 2 (ts-morph declaration extraction), slice 3 (generic structural chunker),
slice 4 (enrichment headers + oversized splitting, shared by both paths), committing at each.
**Open the diff view at every slice boundary** — you're in VS Code, use it.

If you overrun, slice 3 is the one to timebox: a competent block splitter is enough, and
"generic chunking is deliberately simple" is a defensible README sentence. Slice 2 is not
negotiable — it's the differentiator.

### VERIFY

Demo corpus: clone **hono** into `./tmp/`. Mid-sized, well-structured TS that a reviewer knows
well enough to judge your answers against. Deliberately *not* zod — you're using zod as your
validation library, and a README that says "we index zod" while also saying "we validate with
zod" is needlessly confusing to read.

Then ingest **one small non-TS repo** (a Python one) so the generic path is exercised on
something real, not just a fixture. Confirm chunks land with `chunkerKind: 'generic'`, sane
block boundaries, and **null** signature/jsDoc rather than fabricated ones.

```
Delegate to code-critic: review the diff for @plans/01-chunking.md slices 1-4.
Then run npm run ingest -- --repo ./tmp/hono and delegate to chunk-inspector for chunks.json.
Repeat the inspection for the Python corpus.
Report all tables. Do not fix anything yet — I want to read the findings first.
```

**Gate:** read 20 chunks yourself — 15 TS, 5 generic. The subagent catches structural defects;
only you can judge whether a chunk *reads* like something worth embedding. This is also where
you get the before/after material for the README's chunking section — capture a naive-splitter
comparison while the contrast is in front of you, and capture one TS chunk beside one generic
chunk of similar code, because that pair *is* the argument for the two-tier design.

**Commit.** `feat(ingest): language-routed chunking with AST depth for TS/JS`

---

# BLOCK 2 — Embedding & storage (4:15 → 6:00)

### PLAN — Plan mode · Sonnet · `/effort high`

```
plan: embedding pipeline and pgvector storage.

Read @plans/01-chunking.md, @src/shared/types.ts, and @CLAUDE.md.
Target: Postgres 16, pgvector 0.8.6, DATABASE_URL and GEMINI_API_KEY from .env.

Requirements:
- Migration-based schema, not raw SQL at boot. node-pg-migrate.
- Migration 001 runs CREATE EXTENSION IF NOT EXISTS vector — the dev database already has it,
  a grader's fresh container does not.
- Embedding via @google/genai's embedContent, model from EMBED_MODEL in .env
  (verified: gemini-embedding-2). Set outputDimensionality to 768 on every request — omitting
  it silently yields 3072-dim vectors that pgvector rejects on insert. Put 768 in one config
  constant that the migration reads.
- CRITICAL, verified by smoke test: this model AGGREGATES a list of plain strings into one
  embedding. contents: ['a','b','c'] returns 1 vector, not 3, with no error. Every call must
  wrap each text: contents: texts.map(t => ({ parts: [{ text: t }] })). Read results from
  res.embeddings[i].values. Response order matches input order.
- No manual L2 normalization — gemini-embedding-2 auto-normalizes truncated dimensions
  (measured norm 1.0000 at 768). Do not add a normalize step; it would be a no-op that implies
  a misunderstanding.
- chunks table: embedding vector(768), tsv tsvector generated from
  symbol_name || signature || content, content_hash unique, plus language and chunker_kind
  columns carried through from chunking. Both nullable-safe in the tsv expression — generic
  chunks have no signature.
- HNSW index on embedding (vector_cosine_ops), GIN on tsv, btree on language.
- Disk cache keyed by content_hash — re-ingest during development must not re-embed, and must
  not burn free-tier request budget.
- Batch with concurrency 5, exponential backoff on 429. Embedding TPM headroom is large on the
  free tier, so concurrency is the safe knob here — this is not where RPM bites.

TESTS: cache hit skips the API call (mock the embedding client — never hit the real API from
the suite, free tier or not); batching respects the concurrency cap; a failed batch retries
without corrupting the run; migration is idempotent; a generic chunk with null signature
produces a valid tsv rather than NULL.

Write plans/02-embedding.md. STOP WHEN it exists.
```

### VERIFY — via the Postgres MCP, not by dumping rows

```
Via the postgres MCP: confirm the chunks table has an HNSW index, report row count by kind,
language and chunker_kind, and show one row's enriched text truncated to 200 chars.
Do not SELECT * anything.
```

**Commit.** `feat(index): embedding pipeline with content-hash cache`

---

# BLOCK 3 — Hybrid retrieval (6:00 → 8:00)

Opus here — fusion logic is where subtle ranking bugs hide.

### PLAN — Plan mode · Opus · `/effort xhigh`

```
plan: hybrid retrieval, dense + lexical, fused with RRF.

Requirements:
- Dense leg: cosine via `<=>` (NOT `<->`, that's L2), top 30.
- Lexical leg: ts_rank over tsv, plus an exact symbol_name equality boost. symbol_name is
  nullable for generic chunks — the boost must not drop those rows from the leg.
- Fuse with reciprocal rank fusion, k=60, in a single SQL statement.
- Return every chunk with denseRank, lexicalRank and fusedScore — the UI trace needs all three.
- Retrieval is language-agnostic. Do not weight or filter by language or chunker_kind; a
  chunk is a chunk by this point.

TESTS (these are the contract):
- An exact symbol name query returns that symbol at rank 1.
- A purely conceptual query returns results the lexical leg alone would miss.
- RRF fusion verified against hand-computed ranks on a fixed fixture.
- Empty result set returns [] and does not throw.
- A corpus containing both chunker kinds returns both; neither is systematically starved.

Write plans/03-retrieval.md. STOP WHEN it exists.
```

That third test matters more than it looks — hand-computing RRF on a fixture is what proves
your fusion is *correct* rather than merely plausible.

**Commit.** `feat(retrieve): hybrid dense + lexical retrieval with RRF`

---

# BLOCK 4 — Generation & API (8:00 → 10:00)

### PLAN — Plan mode · Sonnet

```
plan: context assembly, generation with citations, Express 5 API on port 8080.

Requirements:
- Token-budgeted assembly: dedupe by file, order by fusedScore, truncate the tail.
- System prompt enforces `path/to/file.ts:120-145` citation format and requires the model to
  say "not found in the indexed code" when context is insufficient.
- Citations parsed into structured refs and validated against real retrieved line ranges —
  a citation pointing at a range we never retrieved is a bug, not a quirk.
- Routes: POST /api/chat (SSE), GET /api/source, GET /health, GET /ready. Zod on every body.
- Bind 0.0.0.0, not localhost — the published port never reaches the host otherwise.
- Express 5 specifics: async handlers rely on native promise rejection forwarding — do NOT
  wrap handlers in try/catch + next(err). No regex sub-expressions in route paths.
- SSE correctness (this is where Express bites):
  * exclude /api/chat from compression middleware — it buffers and never flushes
  * res.flushHeaders(), and set `X-Accel-Buffering: no`
  * heartbeat comment every 15s
  * raise server.requestTimeout and server.headersTimeout above the stream lifetime
- LLM client: @google/genai's generateContentStream — an async generator yielding
  GenerateContentResponse chunks with a `.text` accessor. This is NOT OpenAI-shaped
  (`choices[0].delta.content`) or Anthropic-shaped (`content_block_delta` events) — wrap it in
  a small adapter so the SSE layer emits our own event shape, not the SDK's.
- Cancellation via AbortController — one controller per request, signal threaded into the
  embedding fetch, the DB call, and the LLM request:
  * abort on `res.on('close')` ONLY when `!res.writableFinished` — close fires on success too
  * combine with a deadline: AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)])
  * node-postgres does not accept AbortSignal — check signal.aborted before issuing the query,
    and note pg_cancel_backend(pid) as the real fix under future work
  * Gemini takes the signal as config.abortSignal, but it is CLIENT-SIDE ONLY — it stops us
    reading the stream; the service keeps generating and still bills. Both cancellation paths
    in this app are therefore best-effort. Say so in the trace event and the README rather than
    claiming a true cancel.
  * AbortError must be caught and classified separately from genuine errors — it is a normal
    outcome, not a 500
  * emit a trace event on cancellation with elapsed time and estimated tokens not generated
- Trace data (chunks, scores, timings, language, chunkerKind) rides the SSE stream. Never
  res.json() a large payload — JSON.stringify is synchronous and blocks the loop.

TESTS: refusal path fires on empty retrieval; citation parser rejects fabricated ranges;
budget truncation never cuts a chunk mid-header; abort propagates to a mocked LLM client;
AbortError does not reach the error handler as a 500; no listeners remain on res after abort;
a cancelled embedding batch writes no partial entries to the content-hash cache.
Write plans/04-generation.md. STOP WHEN it exists.
```

**Gate:** `curl localhost:8080` end to end from the host, not just from inside the container —
that proves the 0.0.0.0 bind and the published range in one shot. Deliberately ask something
the repo cannot answer and confirm it refuses rather than invents.

**Commit + tag.** `git tag v0.1-working` — your insurance policy.

---

# BLOCK 5 — Frontend (10:00 → 12:30)

### PLAN — Plan mode · Sonnet

```
plan: React chat UI, Vite dev server on 5173 with --host 0.0.0.0. Plain, responsive,
no component library.

Layout: single column under md, two panes above — chat left, source viewer right.
Citations render as chips; tapping loads that file range into the source pane, which becomes
a slide-up drawer on mobile.
Collapsible trace panel: retrieved chunks with dense/lexical/fused scores, tokens, per-stage
latency, and a small badge showing language + chunkerKind per chunk so the two-tier design is
visible rather than claimed.
Stop button during streaming: aborts the client fetch via AbortController, which closes the
SSE connection and triggers server-side cancellation. On cancel, the trace shows elapsed time
and estimated tokens not generated.
Use dvh not vh — mobile browser chrome clips vh.
Tailwind core utilities only.

Plain done deliberately, not plain by omission: one accent colour and greyscale for everything
else, a 4/8px spacing scale used consistently, one font stack with three sizes, monospace only
for code and citations, visible focus rings on citation chips, and real empty / loading /
error / no-results states.

TESTS: citation chip click dispatches the right range; streaming renders incrementally;
Stop aborts the fetch and leaves the partial answer visible rather than clearing it;
error and empty states render.
DO NOT add a component library, an animation library, or a state manager.
Write plans/05-frontend.md. STOP WHEN npm test passes and the layout holds at 375px and 1440px.
```

### 🔒 HARD CHECKPOINT — 12:30

You have a complete, tested, submittable product. Everything past this is upside. If you're
behind, skip straight to Block 8.

**Blocks 6 and 7 are your buffer, and they are not equal.** The schedule has no slack built in
anywhere else, and Block 4 in particular is dense — Express, SSE *and* cancellation in two hours
is optimistic. When you overrun:

**Cut Block 6 before Block 7.** Call-graph expansion is a paragraph you can write convincingly
as future work. An empty eval table is a hole a reviewer sees immediately, CLAUDE.md already
advertises `npm run eval`, and the README scaffold correctly identifies real numbers as the
rarest thing in the submission. Never borrow from Block 8 or 9 — shipping untested and
undeployable costs you far more than either stretch block.

---

# BLOCK 6 — Call-graph expansion (12:30 → 14:00) · stretch, cut first

The payoff for choosing AST over text chunking on the TS/JS path. **TS/JS only** — ts-morph
resolves the references, and generic-chunked repos skip expansion rather than getting a broken
one. Build edges at **ingest** time — reference finding needs the whole ts-morph Project in
memory and is far too slow per-query.

```
plan: symbol_edges table and 1-hop retrieval expansion, TS/JS only.

At ingest: for each TS/JS declaration resolve call sites and referenced symbols via ts-morph,
store edges (from_chunk_id, to_chunk_id, edge_type: calls | called_by). Generic chunks
produce no edges — this is expected, not a gap to paper over.
At query: after fusion pull 1-hop neighbours of the top 3 hits, ranked strictly below direct
hits, capped by remaining token budget.
Expanded chunks flagged so the trace panel shows them distinctly.

TESTS: a function calling a helper produces both edge directions; expansion respects the token
cap; expansion never displaces a direct hit; cyclic references terminate; a corpus with zero
TS files produces zero edges and retrieval still returns results.
```

That last-but-one test is the one people forget.

---

# BLOCK 7 — Query routing + evals (14:00 → 15:30) · stretch, keep

```
plan: heuristic query classifier and evaluation harness.

Classifier — no LLM call, pure heuristic:
- identifier-shaped token (camelCase / PascalCase / backticked) → symbol_lookup
- "how does" / "why" / "what happens when" → conceptual
- "architecture" / "overall" / "structure" / "flow" → architectural
Each category tunes k, dense/lexical weight, and expansion depth.

evals/golden.json: 15 questions with expected source files, five per category, against the
TS demo corpus. If time allows, a second 5-question set against the Python corpus — even a
small number there is direct evidence the generic path retrieves, not just ingests.
npm run eval prints hit@5, hit@10, MRR as a markdown table, split by corpus.
Space generation calls in the runner — a short delay between questions, not a tight loop —
free-tier RPM is the binding constraint here, not TPM, and 15 questions run back-to-back can
trip it.

TESTS: classifier tested against 15 labelled inputs; eval runner deterministic on a fixture.
STOP WHEN npm run eval produces a table.
```

Then run it twice — dense-only against hybrid — and keep both rows, spaced the same way. A
configuration that scored *worse* is the most persuasive thing you can put in a README. If you
got the Python set in, the TS-vs-generic gap is a second honest comparison and it costs nothing
extra to report.

---

# BLOCK 7.5 — Expose the app as an MCP server · optional, only if genuinely ahead

Not in the request path — *your app as a tool other clients can call.* `src/server/mcp.ts` over
stdio with two tools, `search_code(query)` and `get_source(file, lines)`, both thin wrappers
over the retrieval function Block 3 already built. Anyone can then point Claude Code at their
indexed repo and query it from their own editor.

Roughly an hour because the hard part exists, and it's a real product idea rather than a
checkbox. Package is `@modelcontextprotocol/sdk` — check the current API against Context7
rather than from memory. **Never before the hard checkpoint.**

---

# BLOCK 8 — Deployment ready (15:30 → 16:30)

Non-negotiable, and cheap if planned as one slice.

**Two audiences, one artifact:** the Dockerfile is written production-fashion (multi-stage,
non-root, slim runtime) because that's what a senior AI-native coder ships — but the
docker-compose.yml is the interview surface. An interviewer must be able to clone, run one
command, and have a working app with zero knowledge of the `workstation`/dev-container setup
this was built in. If those two goals ever conflict, compose ergonomics win.

```
plan: production readiness.

- Multi-stage Dockerfile from node:24.18.0-slim: build stage, slim runtime, non-root user,
  no dev deps in the final image. `git` must be present in the runtime image — ingest clones.
- The app itself is a service in docker-compose.yml, not just documented as "build the
  Dockerfile yourself." `docker compose up` must build the app image, start Postgres, run
  migrations, and bring up a working server — no separate `npm ci` / `npm run migrate` step
  outside compose. Use a one-shot `migrate` service (profile or `depends_on` with
  `condition: service_completed_successfully`) that runs node-pg-migrate and exits, gating
  the app service's start on it.
- Shipped docker-compose.yml uses `pgvector/pgvector:0.8.6-pg16` (version-pinned, not the
  floating `pg16` tag) — NOT my dev image. Graders must not build a custom GIS image to run
  a take-home.
- Compose reads a single `.env` at the project root (copy of `.env.example`) — one file, one
  place to add the Gemini key, no separate envs for host vs. container.
- Healthchecks on both the postgres and app services, depends_on with
  condition: service_healthy (app on postgres; anything downstream of migrate on
  service_completed_successfully).
- Env validated with zod at boot — process refuses to start on a missing key, loudly, with a
  message that names the exact missing var (this is what an interviewer sees first if they
  forget to set GEMINI_API_KEY).
- Graceful shutdown: SIGTERM drains in-flight SSE connections before exit.
- /health (liveness) and /ready (DB reachable + migrations applied) are distinct.
- Ingest is NOT a compose service — it's a one-off command an interviewer runs after
  `docker compose up`: `docker compose exec app npm run ingest -- --repo <url>`. Document
  this as the second command in the quick-start, right after `docker compose up`.
- .github/workflows/ci.yml: typecheck, lint, test, docker build. On push and PR.

TESTS: env validation rejects a missing key; /ready returns 503 when migrations are pending.
Write plans/08-deploy.md. STOP WHEN `docker compose up` alone (from .env.example copied to
.env, key filled in) brings up a fully working, ready-to-query app — not just a running
Postgres — from a clean clone.
```

**Gate — the actual interviewer simulation:**

```bash
cd /tmp && git clone <your-repo> fresh && cd fresh
cp .env.example .env    # fill in GEMINI_API_KEY only — nothing else
docker compose up       # single command, no prior npm/node on the host at all
```

Run this from the **host**, not the workstation container, with no other setup. If this
doesn't produce a working app on `localhost:8080` end to end, the block isn't done — this is
the exact sequence a grader follows, and it's the one you can't fake by testing from inside
your dev container. Then:

```bash
docker compose exec app npm run ingest -- --repo https://github.com/honojs/hono
```

confirms the documented second command also works with zero host tooling beyond Docker.

**Version note for the README:** you developed against pgvector 0.8.6 and Node 24.18.0. Say so.
0.8.x has HNSW, `halfvec` and iterative index scans that older builds lack, and a grader on a
different version shouldn't quietly get worse retrieval than you measured.

**Commit + tag.** `git tag v0.2-deployable`

---

# BLOCK 9 — README & submit (16:30 → 18:00)

`/clear` first.

The README is the artifact you're accountable for — Claude generates the first full draft from
material that's already written down (`NOTES.md`, `plans/` files, the decisions list at the top
of this document, and your eval table), and you audit every claim before it ships. Nothing in
the draft gets accepted on trust.

### GENERATE — Sonnet, plenty of context

```
Read @README.md (the scaffold — every `> PROMPT:` line is a question to answer, every
`> NOTES:` block is raw material to rewrite in your own words, never paste verbatim),
@NOTES.md, @plans/*.md, and the decisions list and eval table in @BUILD-PLAN.md.

Write a complete README.md replacing every PROMPT/NOTES block with real prose answering
that section, grounded only in what plans/*.md and NOTES.md actually record. Do not invent
numbers, corpus names, commit SHAs, or eval results you don't have source data for — leave
an explicit placeholder instead:

  <FILL: description>

for anything you cannot source from the repo (screenshots, eval numbers not yet run, demo
corpus names/SHAs not yet recorded). Use this exact placeholder format so they're
grep-able: `<FILL: ...>` for missing facts, `<SCREENSHOT: description>` for images.

State the language tiering plainly in the first paragraph — optimised for TS/JS, generic
structural chunking elsewhere. Claim exactly what was built, no more.

Keep the "Protected files" banner and the engineering-standards content honest — no
softening of named shortcuts (no auth, no retries, thin UI coverage, archived MCP server).

STOP WHEN README.md is fully written with no PROMPT/NOTES scaffold text remaining.
```

### AUDIT — you, not Claude

Go through the generated README section by section against the actual repo:

- [ ] Every `<FILL: ...>` and `<SCREENSHOT: ...>` placeholder — fill or capture, don't leave any in
- [ ] Every claim about architecture, decisions, and gotchas — checked against `plans/*.md` and code
- [ ] Eval numbers match `npm run eval` output exactly, not paraphrased
- [ ] Reject/rewrite anything that reads templated or overclaims — this is the one artifact
      graders will read as your own thinking, so restore your voice where it's missing

### FACT-CHECK — final pass, after your edits

```
Read @README.md and the repo. List only statements in the README that the code does not
actually do. No style edits, no rewrites, no suggestions.
```

Fix whatever comes back. Re-run this once after fixes — don't assume the second pass is clean.

- [ ] Screenshots: chat with citations, source viewer, trace panel
- [ ] Commit the `plans/` files — evidence of how you work
- [ ] Commit `CLAUDE.md`, `.claude/agents/`, `.claude/settings.json`, `.mcp.json` — these *are*
      your answer to "how do you make AI-assisted development repeatable and maintainable"
- [ ] Confirm every brief bullet has a section: setup, architecture, productionising,
      RAG/LLM decisions **including orchestration framework**, key technical decisions,
      engineering standards *and* the ones skipped, AI tool usage, what you'd do differently
- [ ] Repo name and README title match what the thing actually is

---

## Running rules

- One block, one `/clear`. Context rot is the failure mode you'll actually hit.
- Open the diff view at every slice boundary. You're in VS Code — that's the advantage.
- `#` the moment the agent gets something wrong twice. That's a CLAUDE.md line you're missing.
- If a block overruns 30 minutes, cut scope inside it. Never borrow from Block 8 or 9.
- `Esc` early. A wrong assumption caught in turn two costs a sentence; caught in turn six it
  costs a rewind.