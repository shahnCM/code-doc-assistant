# Block 1 — Language-routed chunking

## Context

`src/` is empty apart from a `src/shared/types.ts` stub (`export {};`). This block builds the
first real pipeline stage and, in doing so, defines the `Chunk` shape every later block consumes
— Block 2 embeds it, Block 3 retrieves it, Block 4 cites it, Block 6 hangs `symbol_edges` off it.

The product claim (BUILD-PLAN, "Scope") is *optimised for TypeScript/JavaScript, other languages
supported via generic structural chunking*. Two chunkers today, one output shape, **and a registry
so a third is a new file rather than a rewrite**. The depth on the TS/JS path is the
differentiator; the generic path is what makes "point it at any repo" true instead of aspirational.
What keeps it honest is that the generic path **leaves `signature` and `jsDoc` null instead of
inventing them** — a fabricated signature is a lie the Block 4 citation validator cannot catch.

No new dependencies. `ts-morph` is installed; everything else is Node builtins (`node:util`
`parseArgs`, `node:crypto`, `node:fs/promises`, `node:child_process`).

## Verified before planning (ran these, not recalled)

Four findings shape the design; each contradicts the obvious implementation:

1. **A broken TS file does not throw.** `createSourceFile` on syntactic garbage returned a partial
   AST — one bogus "function" recovered — plus 11 diagnostics, no exception. So the required
   "unparseable TS file" fallback **cannot** be a `try/catch`. The trigger is a diagnostic count.
2. **Use `program.getSyntacticDiagnostics(sf)`, never `sourceFile.getPreEmitDiagnostics()`.**
   Measured: broken file → 11 syntactic, clean file → 0 syntactic. But the *clean* file with one
   unresolvable import → 1 pre-emit diagnostic, `"Cannot find module 'x'"`. We chunk cloned repos
   whose `node_modules` are not installed, so semantic diagnostics fire on essentially every file.
   Gating on pre-emit diagnostics would send the whole corpus down the fallback path.
3. **`getStructure()` includes a `statements` array — the full body.** Keys returned:
   `name, statements, parameters, returnType, typeParameters, docs, isExported, …`. CLAUDE.md's
   advice to prefer `getStructure()` over `getText()` is right, but the signature must be
   **composed from the fields** (name + typeParameters + parameters + returnType + modifiers).
   Serialising the structure drags the body in — the exact bug `getText()` was avoided for.
4. **Arrow consts are not functions.** `export const C = () => <div/>` gives
   `getFunctions().length === 0` and `getVariableStatements().length === 1`. Most React components
   and many modern helpers live here. Collect variable statements explicitly or lose them.

Also confirmed: `getStartLineNumber(true)` includes leading JSDoc trivia (line 1), plain
`getStartLineNumber()` does not (line 2); `getExportDeclarations()` surfaces barrel re-exports;
ts-morph 28.0.0 parses `.js` with `allowJs`.

## Decisions

Settled with the human before writing this:

| Question | Decision |
|---|---|
| Chunker selection | **Registry of `Chunker` implementations**, ordered, first `supports()` wins. Pipeline never imports a parser. |
| Class chunk unit | **Whole class.** Under budget → one `class` chunk. Over budget → split **at method boundaries**, parts carry `kind: 'method'` + `parentSymbol`. Never duplicate body text. |
| Private declarations | **Chunk all top-level decls**, `isExported` is a data field not a filter. Consts only if exported **or** function-valued. Private object literals and magic numbers are skipped. |
| Token budget | **max 512 / min 24**, via a local `chars/4` estimate in one swappable function. `countTokens` is a network call and has no place in a chunker. |
| `.mjs` / `.cjs` | **ts-morph**, alongside `.mts`/`.cts`. They are JavaScript. |
| Existing `./tmp/<name>` | **Reuse, record its actual SHA.** `--refresh` forces a fresh clone. Nothing on disk is ever deleted. |
| Binary detection | Extension denylist **+ NUL-byte probe on the first 8KB**. Not language sniffing — it never selects a chunker, only decides whether the file is read at all. |
| Content / shebang detection | **No.** Extension-only, per CLAUDE.md and BUILD-PLAN. Unknown extension → generic, `language: 'unknown'`. A misroute degrades to the path that is already safe. |
| `parserVersion` | **Not added.** `chunkerKind` is sufficient. See RISKS for the cache-staleness consequence. |

## INTENT

Turn `--repo <local path | public GitHub HTTPS URL>` into a `Chunk[]` ready for embedding, plus an
`IngestReport` that accounts for every file seen. Depth for TS/JS via ts-morph; honest structural
coverage for everything else. **No file may abort the run.** Adding a chunker later (Tree-sitter,
or a language-specific parser) must be a new file plus one registry line — no pipeline change.

Out of scope: embedding, Postgres, `symbol_edges`. `src/ingest/` must not import from
`src/index/` or `src/retrieve/`.

## Extensibility design

Three concerns that a hardcoded extension switch would fuse into one, kept separate:

```
classify.ts   path      → { extension, language }     pure table, no chunker knowledge
registry      candidate → Chunker                     ordered, first supports() wins
Chunker       candidate → Result<Chunk[], ChunkError> owns its own parsing AND splitting
pipeline.ts   knows Chunker[] only — never imports ts-morph, never names a language
```

```ts
// src/ingest/chunkers/index.ts — interface and registry together, one file
interface Chunker {
  readonly name: string;
  readonly chunkerKind: string;        // label only; recorded on every chunk it emits
  supports(c: Candidate): boolean;
  chunk(c: Candidate, source: string): Result<ChunkerOutput, ChunkError>;
}

export const registry: readonly Chunker[] = [tsMorphChunker, genericChunker];
//                                            ^ future: treeSitterChunker inserts here
```

`genericChunker.supports()` returns `true` unconditionally and sits last, so the registry is
total by construction and the pipeline needs no fallback branch of its own.

Four constraints that make the seam real rather than decorative:

- **The pipeline never branches on language or `chunkerKind`.** Already a CLAUDE.md rule and a
  `code-critic` check; the registry is what makes obeying it natural.
- **Splitting belongs to the chunker, not the pipeline.** Method-boundary splitting needs the AST,
  block splitting needs the lines — a pipeline-owned splitter would have to know both. Chunkers
  emit chunks already within budget with `partIndex`/`partTotal` set, using shared helpers from
  `enrich.ts` (`splitByLines`, `tagParts`).
- **Enrichment is a pure parser-agnostic post-pass.** `enrich()` adds header, `embedText` and
  `contentHash` to any chunk from any chunker. It is the one thing the pipeline does to chunks.
- **`chunkerKind` is `string`, not a union.** Nothing may branch on it (CLAUDE.md), so a union
  buys type-safety nobody is allowed to use while forcing every new chunker to edit a shared file.

Deliberately **not** built: a plugin loader, config-driven registration, or dynamic imports. The
registry is an ordered array in one file. Extensibility here is a seam, not a framework.

## FILES

**New — `src/ingest/`**

| File | Responsibility |
|---|---|
| `acquire.ts` | `--repo` → `{ rootDir, source, commitSha }`. URL validation, `git clone --depth 1`, SHA resolution. |
| `walk.ts` | Recursive walk, skip rules, binary probe. Yields candidate paths. |
| `classify.ts` | Extension → `{ extension, language }`. Pure table. **No chunker knowledge.** |
| `tokens.ts` | `estimateTokens(s)` — the one place the budget heuristic lives. |
| `hash.ts` | `contentHash(...)`. |
| `enrich.ts` | Header, `embedText`, part tagging, shared split helpers. Parser-agnostic. |
| `pipeline.ts` | Registry-driven orchestration, failure isolation, `IngestReport`. |
| `cli.ts` | `npm run ingest` entry. `parseArgs`, report printing, `chunks.json`. |
| `chunkers/index.ts` | `Chunker` interface + ordered registry. |
| `chunkers/ts-morph.ts` | ts-morph declaration chunker. |
| `chunkers/generic.ts` | Brace/indent-aware block chunker. |

CLAUDE.md forbids a second types file inside a feature folder, so the `Chunker` interface lives
in `chunkers/index.ts` beside the registry — not in a `chunkers/types.ts`.

**Modified**

- `src/shared/types.ts` — currently `export {};`. Gains `Chunk`, `ChunkKind`, `Result<T,E>`,
  `Candidate`, `ChunkerOutput`, `ChunkError`, `IngestReport`, `AcquiredRepo`, `SkipReason`.
  **Types only, zero runtime.**
- `package.json` — add `"ingest": "tsx src/ingest/cli.ts"`. No new dependencies.

**Tests** — `*.test.ts` beside each source file; fixtures hand-written in
`tests/fixtures/sample-repo/` (do not copy from `node_modules`).

### The `Chunk` shape

One flat interface, **not** a discriminated union on `chunkerKind` — a union would invite exactly
the downstream branching CLAUDE.md forbids. Nullable fields are explicit `T | null` (not optional)
because `exactOptionalPropertyTypes` is on and `null` here means *we honestly do not know*, which
differs from absent.

```ts
filePath: string          // repo-relative, POSIX separators
symbolName: string | null
kind: ChunkKind           // 'function'|'class'|'method'|'interface'|'type-alias'
                          // |'enum'|'const'|'re-export'|'file'|'block'|'window'
signature: string | null  // NEVER synthesised off the AST path
jsDoc: string | null      // NEVER synthesised off the AST path
startLine: number         // 1-based, inclusive, real source lines
endLine: number
parentSymbol: string | null
isExported: boolean
contentHash: string
language: string          // 'typescript'|'python'|… |'unknown'
chunkerKind: string       // 'ts-morph'|'generic'|'fallback'; label only, never branched on
partIndex: number         // 1-based; 1 when unsplit
partTotal: number         // 1 when unsplit
content: string           // verbatim source slice — maps exactly to startLine..endLine
embedText: string         // enrichment header + content — what Block 2 embeds
```

`content` and `embedText` are separate deliberately: citations resolve against verbatim source,
while the embedder benefits from the header. Block 2's tsv reads
`symbol_name || signature || content`, all nullable-safe.

**`contentHash` = `sha256(chunkerKind \0 filePath \0 symbolName \0 partIndex \0 content)`.**
Block 2 puts a UNIQUE constraint on it and caches embeddings by it, so it must be collision-free
*and* stable. Hashing content alone collides when the same trivial function appears in two files →
unique-violation on insert. Hashing `embedText` would be unique but embeds line numbers, so
inserting one line at the top of a file invalidates every chunk below it and re-burns free-tier
budget. `chunkerKind` is in the hash so that swapping generic → tree-sitter re-embeds exactly the
affected chunks; see RISKS for what this still does not cover.

## TESTS

Written before the implementation in each slice, per the standing rule. The seven required by the
brief are marked **[REQ]**.

### Slice 1 — acquisition, walk, classification, registry

1. `https://github.com/o/r` resolves to clone target `./tmp/r`; `git@…`, `http://`, and non-GitHub
   hosts return a `Result` error **and attempt no clone**.
2. A local path is used in place — `rootDir` equals the input, nothing is written under `./tmp`.
3. Existing `./tmp/<name>` is reused and its SHA reported; `--refresh` re-clones.
4. Local non-git directory → `commitSha: null`, not an error.
5. Walk skips `node_modules`, `.git`, lockfiles, `*.min.js`, files > 1MB, denylisted binary
   extensions, a NUL-byte file with a `.txt` extension, and does not follow symlinks.
6. Classify: all eight of `.ts .tsx .js .jsx .mts .cts .mjs .cjs` → `language: 'typescript'` /
   `'javascript'`; `.py .go .md` → their language; unknown extension → `'unknown'`. Classify
   returns **no chunker** — asserted, because that separation is the whole design.
7. Registry: the eight TS/JS extensions select `tsMorphChunker`; `.py` and an unknown extension
   select `genericChunker`; the registry is total (every candidate gets a chunker); order is
   respected when two chunkers both `supports()` a candidate.
8. Hash: identical content in two files → different hashes; same input twice → identical hash; a
   line inserted elsewhere in the file → hash **unchanged**; same content under a different
   `chunkerKind` → different hash.

### Slice 2 — ts-morph declaration chunker

9. **[REQ] Method nested in a class.** An oversized class splits at method boundaries: parts carry
   `kind: 'method'` and `parentSymbol: 'Foo'`, and **no part cuts a method in half**. A class under
   budget stays a single `kind: 'class'` chunk with `parentSymbol: null`.
10. **[REQ] Unparseable TS file.** Syntactic diagnostics > 0 → line-window fallback,
    `chunkerKind: 'fallback'`, counted as `degraded`, and **the surrounding files still chunk**.
11. A clean file with an unresolvable import produces **zero** fallbacks. Guards finding 2 — this
    is the test that catches a regression to `getPreEmitDiagnostics()`.
12. **[REQ] Barrel re-export.** A file of only `export * from` / `export { x } from` yields one
    `kind: 're-export'` chunk. Not a failure, not zero-declarations. Fifty re-exports still yield
    one chunk, not fifty useless ones.
13. **[REQ] File with zero declarations.** Imports plus side-effect calls yields one `kind: 'file'`
    chunk, counted `no-declarations` — explicitly **not** a failure. This and case 10 are different
    outcomes and the report must distinguish them.
14. A function with a 50-line body has a single-line `signature`. Guards finding 3.
15. `jsDoc` is captured, and `startLine` covers the JSDoc when present (`getStartLineNumber(true)`).
16. `export const C = () => …` is chunked; a private arrow const is chunked; a private
    object-literal const is **not**. Guards finding 4 and the const decision.
17. `interface`, `type alias`, `enum` each emit their own `kind`.

### Slice 3 — generic structural chunker

18. **[REQ] Python file** routes to generic, uses indent mode, takes `symbolName` from `def`/`class`
    — and asserts `signature === null && jsDoc === null`. A docstring must **not** become `jsDoc`.
19. **[REQ] Unknown extension** routes to generic, `language: 'unknown'`, does not throw.
20. Brace mode: a `}` inside a string literal or a comment does not terminate a block.
21. Blocks under 24 tokens merge; blocks over 512 split.
22. `symbolName` is `null` when the first line is not definition-shaped.

### Slice 4 — enrichment, pipeline

23. **[REQ] Oversized TS function** splits by statement block: no part exceeds budget, the header
    repeats on every part, `partIndex`/`partTotal` are correct, each part's `startLine`/`endLine`
    are real source lines, and the parts' `content` concatenates back to the original body.
24. Every chunk from both chunkers carries an enrichment header, and generic chunks still have
    `signature === null && jsDoc === null` after enrichment.
25. One failing file does not abort the pipeline; the report counts `failed`, `degraded` and
    `no-declarations` separately and `filesSeen` reconciles against the sum of outcomes.
26. **Pipeline is parser-agnostic.** A fake `Chunker` injected into a test registry drives a full
    run end-to-end, producing enriched, hashed chunks with **ts-morph never imported**. This is the
    test that proves the extensibility claim instead of asserting it — and it is the regression
    guard for the Tree-sitter swap.

## RISKS

- **Silent partial AST.** The headline risk, and the reason for tests 10 and 11. TS's error
  recovery means a corrupt file *looks* parsed. Too loose a diagnostic gate embeds garbage; too
  tight (pre-emit) sends the whole corpus to line windows. Assert both directions.
- **Cache staleness after an in-place chunker revision.** With `parserVersion` declined, the hash
  covers chunker *replacement* (`chunkerKind` changes) but not *revision*: edit the generic
  chunker's boundary logic or the enrichment header format, and `contentHash` is unchanged while
  `embedText` is not — Block 2's cache then serves a vector for text that no longer exists, and
  retrieval silently scores against it. Mitigation is procedural, so it must be real: Block 2 ships
  a documented cache-clear (`--no-cache` or a cache directory to delete), and changing chunker
  output means clearing it. Worth revisiting if a second chunker lands.
- **`chars/4` is an estimate.** Wrong on minified and on CJK. Consequence is a chunk somewhat over
  the real budget, which Block 2 tolerates. Isolated in `tokens.ts`.
- **Method-boundary splitting only helps if methods fit.** A single 600-token method still splits
  by statement. Acceptable — it degrades to the function path, which is tested.
- **Generic depth tracking is a mini-lexer, not a parser.** It handles line comments, block
  comments and the three string quote styles. Heredocs, regex literals and JSX will occasionally
  mis-count. Failure mode is a badly-placed split, not a crash. BUILD-PLAN timeboxes slice 3, and
  "generic chunking is deliberately simple" is the defensible README line — the registry is what
  makes replacing it later cheap.
- **`.gitignore` is not honoured** — only the fixed skip list. A repo with a large generated
  directory outside the list gets indexed. Named as a limitation.
- **Clone reuse can report a stale SHA.** Mitigated by reporting the SHA actually indexed rather
  than assuming HEAD, plus `--refresh`.
- **`git` must exist in the runtime image.** Ingest clones. BUILD-PLAN Block 8 calls this out for
  the Dockerfile; the dependency is created *here*.
- **Untrusted input reaches a subprocess.** The repo URL is user-supplied. Use `execFile` with an
  argument array — never a shell string, never interpolation.

## TASKS

Tests first within every slice. One slice at a time; do not start the next unprompted. Each slice
ends with `npm test` and `npm run typecheck` clean, then a conventional commit.

**Slice 1 — acquisition, walk, classification, registry**
1. Define `Chunk`, `ChunkKind`, `Result<T,E>`, `Candidate`, `ChunkerOutput`, `ChunkError`,
   `IngestReport`, `AcquiredRepo`, `SkipReason` in `src/shared/types.ts`. Types only.
2. Hand-write `tests/fixtures/sample-repo/` covering every routing and skip case.
3. Tests 1–8.
4. Implement `acquire.ts`, `walk.ts`, `classify.ts`, `tokens.ts`, `hash.ts`, and
   `chunkers/index.ts` (interface + empty-registry skeleton); add the `ingest` script.
   → `feat(ingest): repo acquisition, file walk and chunker registry`

**Slice 2 — ts-morph declaration chunker**
5. Tests 9–17.
6. Implement `chunkers/ts-morph.ts`: one `Project` without type-checking; syntactic-diagnostic
   gate; declaration collection including variable statements; signature composed from
   `getStructure()` fields; method-boundary splitting; the three distinct non-success outcomes.
   Register it.
   → `feat(ingest): ts-morph declaration chunker for TS/JS`

**Slice 3 — generic structural chunker**
7. Tests 18–22.
8. Implement `chunkers/generic.ts`: depth scanner, brace and indent modes, merge/split,
   best-effort `symbolName`. `signature` and `jsDoc` are hard-coded `null`. Register it last.
   → `feat(ingest): generic structural chunker for non-TS languages`

**Slice 4 — enrichment, pipeline**
9. Tests 23–26.
10. Implement `enrich.ts` (header, `embedText`, `contentHash`, part tagging, shared split helpers),
    `pipeline.ts` (registry-driven, failure isolation, report), `cli.ts` (`parseArgs`,
    `chunks.json`, printed report).
    → `feat(ingest): enrichment headers and registry-driven ingest pipeline`

## Verification

Per-slice: `npm test` and `npm run typecheck` both clean — the `Stop` hook enforces this.

End of block, per BUILD-PLAN:

```bash
npm run ingest -- --repo https://github.com/honojs/hono   # exercises the clone path
npm run ingest -- --repo <a small Python repo>            # exercises the generic path
```

Then confirm by inspection:
- The report accounts for every file, and `degraded` / `failed` / `no-declarations` are distinct.
- The Python run produces `chunkerKind: 'generic'` with **null** `signature` and `jsDoc`, and sane
  block boundaries.
- The commit SHA is recorded on the run.

Delegate `chunks.json` to the **chunk-inspector** subagent (it exists for exactly this), and the
diff to **code-critic** against this plan's FILES section — its rule 6 already checks for code
outside `src/ingest/` branching on `chunkerKind`, which is the registry boundary. Then read 20
chunks by hand — 15 TS, 5 generic. The subagent finds structural defects; only a human judges
whether a chunk *reads* like something worth embedding. Capture one TS chunk beside one generic
chunk of comparable code while the contrast is visible — that pair is the argument for the
two-tier design, and it is README material for Block 9.
