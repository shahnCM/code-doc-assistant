# Code Documentation Assistant

> **SCAFFOLD — fill in as you build.** Every `> PROMPT:` line is a question to answer in your
> own words, then delete. Do not paste model output into this file: the brief flags twice that
> they want your reasoning, and the contrast between your voice and a model's is easy to spot.
>
> Where you see `> NOTES:` those are terse facts or decisions already established — raw
> material to write *from*, never text to paste. If a sentence in this file still sounds like
> it was generated, rewrite it.
>
> Fill sections as you finish each piece of work, not at hour 16. You will not remember why you
> made a decision six hours after you made it.
>
> CLAUDE.md contains `Do not touch README.md`. Keep that rule true.

---

## What this is

> PROMPT: Two or three sentences. What does it do, what codebases did you index for the demo,
> what can a reader ask it?
>
> State the language tiering in this first paragraph, not buried in limitations: AST-level
> chunking for TypeScript/JavaScript, generic structural chunking for everything else. Claim
> exactly that and no more — "chat with any codebase, optimised for TS/JS" is accurate and
> stronger than either "TypeScript only" or an implied five-language parser matrix.
>
> Say both input modes here too: a local path (which is how you point it at private code) or a
> public GitHub URL.

**Demo corpora:** <TS repo indexed, commit SHA, rough file/symbol counts> ·
<non-TS repo indexed, commit SHA, counts>

---

## Quick start

```bash
git clone <repo>
cd <repo>
cp .env.example .env      # set GEMINI_API_KEY
npm ci
docker compose up -d
npm run migrate           # schema is migration-based, not created at boot
npm run ingest -- --repo https://github.com/honojs/hono   # or a local path
open http://localhost:8080
```

> PROMPT: Test this on a clean machine before submitting — clone to /tmp and follow it verbatim,
> from the host, not from your dev container. Ingest via the GitHub URL in that test run, since
> that's the path a grader takes and the one your dev loop never exercises. A setup section that
> doesn't work is worse than no setup section. State required keys and roughly how long ingestion
> takes on each demo repo.

**Requires:** Node 24.18.0 (`.nvmrc` / `.mise.toml` pin the exact version) · Docker Compose ·
one Gemini API key — free, no credit card, from aistudio.google.com. Covers both embedding and
generation; no separate OpenAI/Anthropic key needed.

**Repo sources:** a local directory path, or a public GitHub HTTPS URL (shallow-cloned into
`./tmp/`). No SSH, no tokens — private repos go through the local-path mode.

---

## Architecture

> PROMPT: A diagram if you have one (Mermaid is fine and renders on GitHub). Otherwise walk the
> two paths in prose:
>
> - **Ingest:** acquire (local path or shallow clone) → walk files → route by extension →
>   ts-morph declaration chunks *or* generic structural chunks → enrich headers → embed →
>   store in pgvector alongside a tsvector column
> - **Query:** classify → dense + keyword retrieval → RRF fusion → call-graph expansion
>   (TS/JS only) → context assembly → generate with citations
>
> Name the actual modules so a reader can find them (`src/ingest/`, `src/retrieve/`, …).
> Mention what runs where: one app container, one Postgres container, ingest as a separate CLI
> process — and say *why* ingest is separate, because that answer is about the event loop.
>
> Make the router explicit in the diagram. It's one box, and it's the thing that makes the
> "any language" claim true rather than aspirational.

**Stack:** TypeScript (strict, ESM) · Node 24.18.0 · Express 5 · React + Vite + Tailwind ·
Postgres 16 + pgvector 0.8.6 · ts-morph · Gemini `gemini-embedding-2` (768d) ·
`gemini-3.6-flash`

> Name the pgvector version explicitly in setup — verified as 0.8.6 in development. 0.8.x has
> HNSW, `halfvec` and iterative index scans that older builds lack; a grader on a different
> version would quietly get worse retrieval than the numbers you report below. The shipped
> compose file pins `pgvector/pgvector:0.8.6-pg16` rather than the floating `pg16` tag.

---

## Chunking

> This is the section that differentiates you. Spend real time here.
>
> PROMPT: Why is character/recursive splitting wrong for code? Show it — a naive split that
> lands mid-function produces a chunk containing neither the symbol name nor the signature, so
> it is unmatchable *and* still retrievable. That concrete pair of chunks is worth more than a
> paragraph of theory.
>
> Then the two-tier design, which is the real decision here:
>
> - **TS/JS → ts-morph.** Chunk unit is the declaration. Real boundaries, real signatures,
>   jsDoc, parent symbols, export status, and the call-graph edges Block 6 builds on.
> - **Everything else → generic structural chunker.** Brace- and indent-aware block splitting,
>   same enrichment header, same `Chunk` shape — with `signature` and `jsDoc` left null rather
>   than fabricated. Say that explicitly: the honest null is the point.
>
> PROMPT: Why two tiers and not one? Why not tree-sitter for five languages? Name the real cost
> you accepted — breadth without depth outside TS/JS, and no call-graph expansion there.
>
> Show one TS chunk beside one generic chunk of comparable code. That pair *is* the argument.
>
> What metadata do you prepend before embedding, and what did that do to retrieval quality? How
> do you handle a declaration larger than your chunk budget? Files that fail to parse? Do you
> index anything at file or module granularity as well as symbol granularity?
>
> If you measured a before/after on retrieval quality, put the numbers here.
>
> NOTES (raw material, rewrite): routing is by file extension only — no content sniffing, no
> shebang parsing. Extensions are occasionally wrong and cheaply so, and a misroute degrades to
> generic chunking rather than failing, because the fallback path had to exist anyway for
> unparseable files.

---

## Retrieval

> PROMPT: Why hybrid rather than pure vector? Give the concrete failure case — an exact symbol
> lookup that embeddings miss. How do you fuse the two rankings? What are your `k` values and
> how did you pick them?
>
> Note that retrieval itself is language-agnostic: by the time a chunk reaches the index it is
> just text plus metadata, and nothing downstream branches on which chunker produced it. That's
> a design property worth one sentence — it's why adding a parser later is additive rather than
> a rewrite.
>
> Then the call-graph expansion: what triggers it, how deep do you go, how do you stop it
> blowing the context budget? Say plainly that it is TS/JS only and why. (If you cut this block,
> say so here and move it to future work — naming it as a deliberate cut reads better than
> silence.)
>
> Query routing: what categories, how do you classify, what changes per category?

---

## Model choices

> PROMPT: Embedding model — which, and what did you trade off (dimensions, cost, context length)?
> LLM — which, and why that one for this task? Did you consider routing between models?
> Be specific about what you rejected and why; "I picked X because it's good" reads as no decision
> at all.
>
> **Orchestration framework — the brief asks about this by name and it is easy to miss.**
> LangChain / LlamaIndex / none. If none, say what you'd have got and what it would have cost.
>
> NOTES (raw material, rewrite): pipeline is four controllable steps; a framework owns prompt
> assembly and context truncation, which are exactly the parts under evaluation here; every
> stage would gain a layer between you and the trace output you're shipping in the UI.
>
> NOTES on provider choice (raw material, rewrite): Gemini for both embedding and generation —
> one key, no card, free tier covers this workload comfortably (Flash for generation, large
> token headroom on the embedding endpoint). The real trade-off is RPM/RPD rate limits, not
> quality — name that honestly rather than glossing over it, and say what mitigates it (batch
> pacing, contentHash caching). The client sits behind one interface, so this is a runtime
> config choice, not a rewrite, if a grader wants to see a paid-tier swap.

---

## Prompt & context management

> PROMPT: How do you assemble context — ordering, dedup, token budget, truncation strategy?
> What does your system prompt actually enforce? How do citations get produced reliably
> (`file:line` grounding) rather than hallucinated? Mention that citations are parsed into
> structured refs and validated against ranges you actually retrieved — that validation step is
> the interesting part.

---

## Guardrails

> PROMPT: What happens when retrieval returns nothing relevant — does the model say so or guess?
> How do you detect low-confidence retrieval? Any injection risk from indexed code or comments,
> and what did you do about it? What did you deliberately leave unguarded, and why that's
> acceptable for a prototype?
>
> NOTES: the free-tier provider may use submitted content to improve its models. Fine for a
> public, permissively-licensed demo corpus — worth one honest sentence here, and worth naming
> as a real constraint on pointing this at anyone's private code as-is. That constraint applies
> to the local-path mode specifically, since that's the private-repo route.
>
> NOTES: ingest clones arbitrary public URLs. Say what you skip (binaries, lockfiles,
> node_modules, .git, files over 1MB) and that you shallow-clone rather than pulling history.

---

## Quality & evaluation

> PROMPT: Your golden question set — how many, how chosen, what do they cover? Report retrieval
> hit rate and anything else you measured, as a table. Show a config you tried that scored worse.
>
> If you ran a second small set against the non-TS corpus, report it separately rather than
> averaging the two — the gap between the AST path and the generic path is a real finding and
> hiding it in a mean wastes it.
>
> A take-home with real numbers in it is rare. Even 15 questions and one comparison table puts
> you ahead of nearly everyone.

| Corpus | Question type | N | Retrieval hit rate | Notes |
|---|---|---|---|---|
| TS (ts-morph) | Symbol lookup | | | |
| TS (ts-morph) | Conceptual | | | |
| TS (ts-morph) | Architectural | | | |
| Non-TS (generic) | Mixed | | | |

---

## Observability

> PROMPT: What do you log, in what format, and how would you actually debug a bad answer with it?
> Per-stage latency, retrieval scores, token counts, model/version. What's exposed in the UI trace
> view versus what only hits the logs?
>
> The trace shows language and chunkerKind per retrieved chunk — mention it. It's how a reviewer
> verifies the two-tier claim instead of taking your word for it.

---

## Key technical decisions

> PROMPT: The brief asks for these explicitly. Three or four, each with the alternative you
> rejected and the reason. What makes this section work is naming a real cost you accepted.
>
> NOTES (raw material — these were decided during the build, write them up yourself):
>
> - **Two chunkers, not one and not five.** Implementation language and indexable languages are
>   independent concerns — coupling them would have been an accident rather than a decision.
>   ts-morph gives real declaration boundaries, signatures and call-graph edges for TS/JS, which
>   is where the retrieval quality argument lives. A tree-sitter grammar per language would have
>   bought breadth for five grammars, five node-type maps and five sets of edge cases inside an
>   18-hour budget. The generic chunker already had to exist as the parse-failure fallback, so
>   promoting it to a first-class route cost an extension check and covered everything else.
>   Accepted cost: no signatures, no jsDoc and no call-graph expansion outside TS/JS.
> - **Express 5 over Next.js.** Ingest is CPU-bound parsing work that must be a separate
>   process regardless, so a fullstack framework covers half the system while adding a layer
>   between you and the SSE socket. SSE cancellation semantics are where this app is actually
>   interesting; a framework would have handled them for you and you'd have nothing to say.
> - **One package, two entry points, rather than split FE/BE.** Shared event, trace and citation
>   shapes import straight from `src/shared/types.ts`. Vite builds to `dist/web`, Express serves
>   it — one container, one port for a grader. The boundary is already HTTP, so splitting the
>   web tier later is a deployment change, not a rewrite.
> - **No tRPC.** End-to-end type inference already exists in a single package; tRPC would wrap
>   the one endpoint that specifically needs to stay unwrapped. Four routes, not forty.
> - **Split tsconfigs, not one.** Server is Node ESM with no DOM, client is browser with JSX.
>   One config means either `document` typechecks in Express handlers or React doesn't compile.

---

## Engineering standards

> PROMPT: What did you hold to — typing discipline (`strict`, `noUncheckedIndexedAccess`,
> `exactOptionalPropertyTypes`), module boundaries, error handling, test strategy, lint/format
> config, commit hygiene?
>
> One boundary worth naming: both chunkers emit the same `Chunk` shape, and nothing downstream
> branches on which one produced it. That's what keeps "add a parser later" additive.
>
> Then the part most candidates skip: **what did you deliberately not do, and why?** No auth,
> no retries on embedding calls, thin coverage on the UI, an archived reference MCP server for
> local DB inspection. Naming your own shortcuts reads as judgement. Pretending they aren't
> there reads as not noticing.

**Tests:** > PROMPT: what's covered, how to run it, what you'd add next.

---

## Known limitations

> PROMPT: Be specific and unapologetic. Single repo at a time. Full re-index on change. No
> incremental updates. Whatever you hit and chose to leave.
>
> Language-specific, and state it plainly rather than defensively: outside TS/JS there are no
> signatures, no jsDoc extraction, no export detection and no call-graph expansion — retrieval
> works, but on coarser chunks. Give a rough sense of how much worse if you measured it.
>
> Include the code-retrieval edge cases you did *not* solve — barrel-file re-exports, symbol
> collisions across modules, dynamic imports, generated code. Showing you can name them is most
> of the credit.
>
> NOTES: ingestion is CLI-only — a reviewer opening the UI can only query the corpus you shipped.
> Say so plainly and point at the one-command re-index rather than letting them discover it.
>
> NOTES: repo acquisition is public HTTPS clone or local path only. No SSH, no tokens, no
> private-repo auth — deliberate, since local paths cover that case without building a
> credential story in an 18-hour build.
>
> NOTES: cancellation is best-effort on both paths — the LLM signal is client-side only (the
> service keeps generating and still bills), and node-postgres ignores AbortSignal entirely.
> Naming both, with `pg_cancel_backend` as the real fix, is stronger than claiming a clean stop.

---

## Productionising this

> PROMPT: They ask explicitly about AWS/GCP/Azure/Cloudflare. Cover:
>
> - Where ingestion runs at scale (queue + workers — you have real SQS/Batch experience, use it)
> - Managed vector store vs self-hosted pgvector, and at what scale the answer flips
> - Incremental indexing off git webhooks
> - Caching: embedding cache, response cache, and their invalidation
> - Multi-tenancy and isolation between customers' code
> - Cost model — embedding cost per repo, per-query inference cost, what dominates
> - Secrets, key rotation, rate limiting, retries and backoff
> - What you'd monitor and what would page someone
>
> Two things from the build belong here specifically: why ingest must never run inline in a
> request handler, and what leaks when SSE connections are abandoned without cleanup.
>
> A third, if you have room: cloning untrusted repos is a real production concern — disk quotas,
> clone timeouts, and running the walker somewhere isolated. You skipped all of it for a local
> prototype; say what you'd add.
>
> Keep it concrete. Generic cloud vocabulary is transparent; specific numbers and trade-offs
> are not.

---

## How I used AI tools

> PROMPT: They ask directly and they're evaluating the answer. Which tools, for what parts?
> Where did you accept output and where did you rewrite it? How did you keep generated code
> consistent with your own conventions — rules files, prompt patterns, review passes?
> Your do's and don'ts. Where did it actively slow you down?
>
> Point at the committed artefacts rather than describing them: `CLAUDE.md`, `.claude/agents/`,
> `.claude/settings.json`, `.mcp.json`, and the `plans/` directory. The stop-gate hook is the
> strongest single example — a turn cannot end while tests are red, and it only works because
> it exits 2; any other exit code is silently ignored. That detail is the kind of thing that
> shows you actually built it rather than copied it.
>
> Concrete examples beat philosophy. "It produced a chunker that split mid-function, so I
> rewrote the traversal by hand" is worth more than a paragraph on AI-assisted workflow.
>
> One example worth telling if you want a scoping one: the first Block 1 plan was written
> "ts-morph only, TypeScript repos", which quietly coupled the implementation language to the
> indexable languages. Caught it in plan review before any code existed and split the design
> into two tiers — cheap at plan stage, expensive after three slices.

---

## What I'd do differently with more time

> PROMPT: Ranked, with reasoning. This is where you show you know the difference between what
> you built and what it should be. Three or four items with real justification beats ten bullets.
>
> Tree-sitter grammars for Python/Go/Rust behind the same router interface is an obvious #1
> candidate — the seam already exists, which is what makes it a credible next step rather than
> a wish.

---

## Screenshots

> PROMPT: Embed them. A short screen recording if you have time — the brief asks. Show the trace
> view, not just the chat, since that's the part reviewers won't expect. If you have both corpora
> indexed, one screenshot of a non-TS answer proves the tiering better than a paragraph.