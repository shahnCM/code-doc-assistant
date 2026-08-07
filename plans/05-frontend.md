# Block 5 — React Chat UI

## Context

Block 4 (committed, tagged `v0.1-working`) closes the online path server-side: `POST /api/chat`
streams a `ChatEvent` union over SSE (`trace` → `token`* → `citations` → `done`, or `cancelled` /
`error`), and `GET /api/source` returns a stitched, gap-aware `SourceRange` for a citation range.
Nothing consumes either endpoint yet. `src/web/` holds exactly one file — a stub `tsconfig.json`.
No `package.json` entry, no `vite.config.ts`, no `index.html`, no React, Vite, or Tailwind
dependency anywhere in the tree.

Block 5 closes the loop a human actually uses: type a question, watch tokens stream in, click a
citation chip to see the cited code, inspect the retrieval trace to see the two-tier chunking
design (language + `chunkerKind` per chunk) instead of taking it on faith, and stop a generation
mid-flight without losing what already streamed. Nothing here touches `src/server/`, `src/generate/`,
or the database schema — Block 5 is a pure consumer of the Block 4 contract.

Out of scope: a repo picker beyond a single text field, conversation persistence, a production
build/deploy story, and CORS changes to the server (a Vite dev proxy makes those unnecessary).

## Verified before planning (ran these, not recalled)

Read the actual Block 4 source and checked the live npm registry — nothing here is remembered from
training data.

1. **`src/web/` is an empty stub.** Only `src/web/tsconfig.json` exists (extends root, adds
   `jsx: react-jsx`, `moduleResolution: bundler`, `types: ["vite/client"]`, `include: [".",
   "../shared/types.ts"]`). No `react`, `vite`, or `tailwindcss` in root `package.json` at all —
   the `vite` binary in `node_modules` today is only vitest's transitive peer, not app-usable.
2. **`ChatEvent` (`src/shared/types.ts:133-139`)** is a tagged union with **no `event:` line** —
   every SSE frame is `data: <JSON>\n\n` and the JSON's own `type` field discriminates it:
   `trace { chunks: AssembledChunkTrace[], retrieveMs, contextTokens }`, `token { text }`,
   `citations { valid: Citation[], invalid: Array<{citation, reason}> }`,
   `done { finishReason, generateMs, totalMs }`, `cancelled { elapsedMs,
   estimatedTokensNotGenerated, note }`, `error { message }`. Heartbeats are bare SSE comments
   (`: heartbeat\n\n`, `src/server/sse.ts:38-42`) — a parser must treat any line starting with `:`
   as ignorable, not JSON.
3. **`POST /api/chat` body**: `{ messages: {role,content}[] (min 1), repoSource?: string,
   topK?: number }` (`src/server/routes/chat.ts:10-16`). Bad body → HTTP `400 { error }`, plain
   JSON, not SSE.
4. **`GET /api/source` requires `repoSource`** — `z.string().min(1)`, not optional
   (`src/server/routes/source.ts:6-11`), unlike chat's optional one. There is no endpoint that
   lists indexed repos. Settled with the human (below): a single text field feeds both.
5. **No CORS middleware exists anywhere in `src/server`.** Reaching `:8080` from the Vite dev
   server on `:5173` needs either CORS headers (a server change, out of scope) or a Vite dev proxy
   (a client-only config). Proxy chosen — zero backend touch.
6. **Citations are inline text, not a separate marker.** `src/generate/prompt.ts:6`:
   `CITATION_FORMAT = 'path/to/file.ts:120-145'`, and the model is instructed to cite in exactly
   that shape. `src/generate/citations.ts:3` parses it with
   `/([A-Za-z0-9_\-./]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g`. The `citations` SSE event carries only
   the *resolved* `valid`/`invalid` lists (split into two arrays, original order lost) — no
   positions. The client must re-run the same pattern against the final assistant text and match
   each occurrence to a citation by `(filePath, startLine, endLine, raw)` to place chips inline.
7. **A client-initiated Stop can never observe the server's `cancelled` event.** `answer.ts:132-138`
   does compute and yield `{ type: 'cancelled', elapsedMs, estimatedTokensNotGenerated, note }`
   server-side once `res.on('close')` fires — but that only happens *after* the client has already
   called `AbortController.abort()`, which per the Fetch spec errors the response body's reader
   immediately and discards any further bytes, including ones already in flight. The Stop button
   must compute its own `elapsedMs` (trivial: `Date.now() - startedAt`) and mirror the server's
   `estimatedTokensNotGenerated` formula locally rather than wait for a frame that will not arrive.
8. **The mirrored formula, verified in source**: `Math.max(0, DEFAULT_MAX_OUTPUT_TOKENS -
   estimateTokens(accumulatedText))`, `DEFAULT_MAX_OUTPUT_TOKENS = 2048`
   (`src/generate/llmClient.ts:5`), `estimateTokens = text => Math.ceil(text.length / 4)`
   (`src/tokens.ts`, pure, zero Node built-ins, safe to import from `src/web`).
9. **Dependency versions and peer compatibility, checked against the live registry today
   (2026-08-07), Node v24.18.0, vitest `4.1.10` already installed**: `react@19.2.8`,
   `react-dom@19.2.8`, `vite@8.2.1` (vitest's own `peerDependencies.vite` is
   `^6.0.0 || ^7.0.0 || ^8.0.0` — satisfied), `@vitejs/plugin-react@6.0.5` (peer `vite: ^8.0.0` —
   satisfied only because 8.x was picked), `tailwindcss@4.3.3` / `@tailwindcss/vite@4.3.3` (peer
   `vite: ^5.2.0 || ^6 || ^7 || ^8`), `@types/react@19.2.18`, `@types/react-dom@19.2.4`,
   `jsdom@30.0.1`, `@testing-library/react@16.3.2` (peer `react`/`react-dom`:
   `^18.0.0 || ^19.0.0`), `@testing-library/jest-dom@7.0.0` (exposes a `./vitest` entry point —
   `import '@testing-library/jest-dom/vitest'` auto-extends `expect`), `@testing-library/user-event@14.6.3`.
   All peer ranges resolve cleanly with no override needed.
10. **`vitest.config.ts` is minimal today** (`exclude` only) and `npm test` = `vitest run
    --passWithNoTests`, which already globs `**/*.{test,spec}.?(c|m)[jt]s?(x)` by default — `.tsx`
    test files need no new script, only a `setupFiles` entry for jest-dom and a per-file
    `// @vitest-environment jsdom` pragma (Vitest's documented mechanism), so **node-side tests
    stay on the default `node` environment** and are untouched.

## Decisions

Settled with the human before writing this:

| Question | Decision |
|---|---|
| How does the UI supply the mandatory `repoSource` for `/api/source`? | **A single text field** above the chat, value reused for both `/api/chat` (omitted from the request body if empty — server searches all indexed repos) and `/api/source`. Citation chips stay focusable and visible when it's empty, but clicking one shows an inline hint in the source pane instead of fetching — never a disabled/unfocusable button, so the required focus-ring behaviour holds regardless. |
| Component test approach? | **React Testing Library** (`@testing-library/react` + `/jest-dom` + `/user-event`) over manual DOM assertions — standard, and the four brief-mandated behaviours (chip click, incremental streaming, Stop, error/empty states) are exactly what it's built for. |
| Tailwind setup? | **v4, CSS-first.** `@tailwindcss/vite` plugin, one `@theme` block in `index.css` for the accent colour and font stack, no `tailwind.config.js` / `postcss.config.js`. |
| Cross-origin access to `:8080` from the Vite dev server? | **Vite dev proxy** (`server.proxy['/api'] → http://localhost:8080`), not server-side CORS. Keeps this block a pure consumer of Block 4's HTTP surface. |

Decided without asking, noted for review:

- **The citation regex is duplicated in `src/web/lib/citations.ts`, not imported from
  `src/generate/citations.ts`.** The source file is pure (no Node built-ins) and could technically
  be shared, but importing it would pull a server-path module into the browser bundle and blur the
  ingest/query/web boundary CLAUDE.md draws. Three lines of duplicated regex is cheaper than that
  coupling — flagged as a drift risk below, pinned to `CITATION_FORMAT` in `prompt.ts:6`.
- **`estimateTokens` (from `src/tokens.ts`) *is* imported directly**, unlike the regex above — it
  has no citation-format coupling to drift, it is the literal function the server's own estimate
  uses, and duplicating a `text.length / 4` one-liner would only invite the two copies to diverge
  silently. `src/web/tsconfig.json` gains `../tokens.ts` in `include`.
- **The trace panel's collapse/expand uses a native `<details>`/`<summary>` element**, not
  component state. Zero JS, zero animation library, free keyboard and a11y behaviour — the
  cheapest thing that satisfies "collapsible."
- **The mobile source-pane drawer is a CSS-only responsive treatment**, not a JS breakpoint
  listener. Open/closed is derived from "is a citation currently selected," toggled by conditional
  Tailwind classes (`fixed inset-x-0 bottom-0 translate-y-full` below `md`, static above it) plus a
  transform transition — no extra boolean state to keep in sync.
- **`ChatMessage` has no `id` field (`types.ts:98-101`).** The message list is strictly
  append-only — never reordered, filtered, or spliced — so the array index is a safe React key
  here; generating a synthetic id would be the premature-abstraction the house rules warn against.
- **No `build:web` script.** The brief's stop condition is `npm test` green and the layout holding
  at two widths, not a production bundle — added to RISKS as an explicit deferral, not silently
  skipped.

## INTENT

A plain, responsive React client that sends a question over `POST /api/chat`, renders the SSE
stream incrementally, turns inline citation text into clickable chips once the stream resolves,
loads the cited range into a source pane (a slide-up drawer under `md`), and shows a collapsible
trace panel proving the two-tier chunking design chunk-by-chunk. Stop aborts cleanly and keeps the
partial answer on screen. No component library, no animation library, no state manager — React's
own hooks, Tailwind utilities, and a native `<details>` element carry the whole UI.

## Extensibility / design

```
src/web/
  index.html                  Vite entry, mounts #root
  vite.config.ts              react() + tailwindcss() plugins, /api → :8080 dev proxy
  index.css                   @import "tailwindcss"; one @theme block (accent, font stack)
  testSetup.ts                imports '@testing-library/jest-dom/vitest'
  main.tsx                    createRoot(...).render(<App />)
  App.tsx                     top-level layout + state: messages, repoSource, selected citation
  lib/
    sseStream.ts               parseSseStream(reader) → AsyncGenerator<ChatEvent>
    citations.ts                CITATION_PATTERN, splitWithCitations(text, lookup) → Segment[]
    tokenEstimate.ts            estimateTokensNotGenerated(text) — mirrors llmClient.ts's formula
  hooks/
    useChatStream.ts            send(messages, repoSource)/stop() state machine over the SSE parser
  components/
    ChatPane.tsx                 message list, input, Stop button, loading/error/empty states
    MessageBubble.tsx            one message; assistant text run through splitWithCitations
    CitationChip.tsx             valid → clickable button; invalid → muted, titled with the reason
    SourcePane.tsx                fetches GET /api/source on selection; drawer on mobile
    TracePanel.tsx                <details>; per-chunk scores/ranks + language+chunkerKind badge
```

`useChatStream` is the one piece of real logic — everything downstream of it is rendering. It owns
a discriminated `status` (`idle | streaming | done | cancelled | error`), exposes the accumulating
`partialText`, the `trace` once it arrives, and `citations` once resolved, and is the only place
`fetch`/`AbortController` appear. That mirrors `answerQuestion` being the one generator the whole
server side routes through (Block 4) — the same shape, one layer up.

`parseSseStream` is pure and DOM-free: it takes a `ReadableStreamDefaultReader<Uint8Array>` and
yields `ChatEvent`s, buffering partial frames across reads and skipping `:`-prefixed comment lines.
Testable with a hand-rolled fake reader, no real network or `ReadableStream` polyfill quirks in
jsdom to fight.

## FILES

**New — `src/web/`** (all listed in the tree above)

| File | Responsibility |
|---|---|
| `vite.config.ts` | `react()`, `tailwindcss()`, `server.proxy['/api']` → `http://localhost:8080`, `changeOrigin: true`. |
| `index.css` | `@import "tailwindcss";` then `@theme { --color-accent: …; --font-sans: …; --font-mono: … }` — one accent colour, one font stack, monospace token for code/citations. |
| `lib/sseStream.ts` | `parseSseStream(reader)`. Buffers on `\n\n`, splits `data: `-prefixed lines from `:`-prefixed comments, `JSON.parse`s each frame as `ChatEvent`. |
| `lib/citations.ts` | `CITATION_PATTERN` (duplicated from `citations.ts:3`, comment pins the source of truth), `splitWithCitations(text, lookup: Map<string, {valid: boolean; reason?: CitationProblem} & Citation>)` → ordered array of plain-text and citation segments. |
| `lib/tokenEstimate.ts` | `estimateTokensNotGenerated(accumulatedText)` = `Math.max(0, 2048 - estimateTokens(accumulatedText))`, importing `estimateTokens` from `../../tokens.js`; the `2048` is commented as pinned to `DEFAULT_MAX_OUTPUT_TOKENS` in `llmClient.ts:5`. |
| `hooks/useChatStream.ts` | `send(history, repoSource)` issues the `fetch`, drives `parseSseStream`, accumulates `partialText` on `token`, captures `trace`/`citations`/`done`; `stop()` aborts and transitions to `cancelled` with locally computed `elapsedMs`/`estimatedTokensNotGenerated`, **keeping `partialText` intact**. |
| `components/ChatPane.tsx` | Renders `messages` + in-flight `partialText`, the input box, Send/Stop button swap while streaming, and the loading/error/empty states. |
| `components/MessageBubble.tsx` | One message. Assistant messages run through `splitWithCitations`; user messages render as plain text. |
| `components/CitationChip.tsx` | `<button>` for valid citations (dispatches `onSelect({filePath,startLine,endLine})`), a non-interactive `<span title={reason}>` styling for invalid ones — visible focus ring on the button variant. |
| `components/SourcePane.tsx` | On a selected citation + non-empty `repoSource`, `fetch`es `GET /api/source`; renders `blocks`/`gaps` from `SourceRange`, plus loading/error/no-results/empty states. Drawer classes toggle off `selectedCitation !== null`. |
| `components/TracePanel.tsx` | `<details>` wrapping a table of `AssembledChunkTrace[]` — `fusedScore`/`denseRank`/`lexicalRank`, plus `retrieveMs`/`contextTokens` from the `trace` event header, and a small badge per row combining `language` + `chunkerKind`. |

**Modified**

- `package.json` — dependencies: `react`, `react-dom`. devDependencies: `vite`,
  `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `@types/react`, `@types/react-dom`,
  `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`
  (exact versions from Verified 9). New script: `"dev:web": "vite --config src/web/vite.config.ts
  --host 0.0.0.0"`.
- `vitest.config.ts` — adds `test.setupFiles: ['./src/web/testSetup.ts']`. No `environment`
  change at the top level; web `.test.tsx` files opt into `jsdom` per-file via the
  `// @vitest-environment jsdom` pragma so node-side suites are unaffected.
- `src/web/tsconfig.json` — `include` gains `../tokens.ts`.

**Not modified.** `src/server/`, `src/generate/`, `src/shared/types.ts`, the database — Block 5 is
a pure consumer of the Block 4 contract. `CLAUDE.md` is protected; once this lands it wants a
`npm run dev:web` line in its Commands block — flagged for the human, not edited.

## TESTS

Written before implementation, per slice. **[REQ]** tags are the brief's own four required
behaviours.

**Slice 2 — `lib/sseStream.ts`** (pure, hand-rolled fake reader, no DOM)
1. A single `read()` chunk containing two complete `data:` frames yields two `ChatEvent`s in order.
2. A frame split across two `read()` calls (partial JSON at the chunk boundary) still parses once
   the second chunk arrives — the buffer carries the remainder forward.
3. `: heartbeat\n\n` comment lines between data frames are skipped, not yielded or thrown on.
4. Stream end (`reader.read()` resolves `{ done: true }`) ends the generator cleanly with no
   trailing partial-frame yield.

**Slice 2 — `lib/citations.ts`**
5. `splitWithCitations` on `"see src/a.ts:10-20 for it"` with a lookup marking that exact citation
   valid returns `[text, citation(valid), text]` in order, and the citation segment's fields match
   `filePath/startLine/endLine` exactly.
6. A citation text present but absent from the lookup (never resolved — e.g. stream still
   in-flight) renders as a plain-text segment, not a chip — chips only appear once `citations` has
   arrived.
7. Two identical citation strings in one message each get matched against the lookup independently
   (by position, not by dedup) and render as two segments.

**Slice 2 — `lib/tokenEstimate.ts`**
8. `estimateTokensNotGenerated('')` returns `2048` (nothing generated yet).
9. A text long enough that `estimateTokens(text) > 2048` clamps to `0`, not negative.

**Slice 3 — `hooks/useChatStream.ts`** (fake `fetch` returning a controllable `ReadableStream`)
10. **[REQ]** `send()` transitions `idle → streaming`, and `partialText` grows with each `token`
    event pushed through the fake stream — incremental rendering is driven by hook state, not a
    final snapshot.
11. On `done`, status becomes `done` and the resolved `citations`/`trace` are attached.
12. **[REQ]** `stop()` aborts mid-stream: status becomes `cancelled`, `partialText` retains
    everything received before the abort (not cleared), and `elapsedMs`/`estimatedTokensNotGenerated`
    are present and computed locally (per Verified 7-8), not read off a `cancelled` SSE event.
13. **[REQ]** A `type: 'error'` frame, and a network-level fetch rejection, both land in status
    `error` with a message — never left in `streaming` forever.

**Slice 3 — `components/ChatPane.tsx`** (React Testing Library)
14. **[REQ]** Typing a question and submitting renders the user message immediately and the
    assistant bubble grows token-by-token as the fake stream emits.
15. **[REQ]** Clicking Stop while streaming aborts and leaves the partial assistant text visible,
    with a Send button back in place of Stop.
16. **[REQ]** Empty state (no messages yet) and error state (a failed send) both render distinct,
    non-blank content — not just an empty div.

**Slice 4 — `components/CitationChip.tsx` / `MessageBubble.tsx`**
17. **[REQ]** Clicking a valid citation chip calls `onSelect` with exactly
    `{ filePath, startLine, endLine }` matching the citation text it was rendered from.
18. An invalid citation (`reason: 'unknown-file' | 'range-not-retrieved'`) renders non-clickable
    (no `onSelect` call on click/Enter) and exposes the reason via `title`.
19. A valid chip has a visible focus outline on `:focus-visible` (class assertion — jsdom can't
    render, so this asserts the focus-ring utility class is present, not pixels).

**Slice 4 — `components/SourcePane.tsx`**
20. Selecting a citation with `repoSource` set fetches `GET /api/source` with the exact query
    params and renders returned `blocks`; a `gaps` entry renders as an elision marker, never as
    code.
21. Selecting a citation with `repoSource` empty shows the inline "enter a repo source" hint and
    issues no fetch.
22. A 404 from `/api/source` renders the no-results state; a network failure renders the error
    state; no selection renders the empty state.

**Slice 5 — `components/TracePanel.tsx`**
23. Each row shows `fusedScore`, `denseRank`, `lexicalRank`, and a badge combining `language` +
    `chunkerKind`; a chunk with `included: false` is visually distinguished from included ones.
24. The panel is collapsed by default (`<details>` with no `open` attribute) and its content is
    reachable via the native toggle — asserted via the `open` property after firing a click on
    `<summary>`, not via component state.

## RISKS

- **The citation regex is duplicated, not shared** (Decisions). If `CITATION_FORMAT` in
  `prompt.ts:6` or the pattern in `citations.ts:3` ever changes, `src/web/lib/citations.ts` must be
  updated by hand — nothing enforces the two staying in sync besides this note.
- **`estimatedTokensNotGenerated` on Stop is always a client-side approximation**, never the
  server's real figure (Verified 7) — this is the same class of honesty CLAUDE.md already asks for
  on the server's own best-effort cancellation, just one layer further out. Worth restating in the
  UI copy itself, not only in code comments.
- **No production build/deploy path** (`build:web` deliberately omitted, Decisions). This block
  proves the dev server and the test suite; packaging for anything beyond `npm run dev:web` is
  unaddressed.
- **No CORS on the server; the dev proxy is the only thing making `:5173` reach `:8080`.** Fine for
  this block's scope, but a future non-Vite-served client (or a different dev port) needs either
  CORS headers added server-side or its own proxy — not solved here.
- **jsdom has no real layout engine.** The 375px/1440px breakpoint check in the brief's stop
  condition can only be verified by hand in an actual browser via `npm run dev:web`; the automated
  suite (RTL/jsdom) cannot and does not attempt to assert Tailwind responsive classes actually lay
  out correctly.
- **Dependency versions (Verified 9) are today's registry latest, first time these packages enter
  this repo.** If this plan executes materially later than 2026-08-07, re-run the `npm view`
  checks before installing — the same caution CLAUDE.md already applies to Gemini model ids.

## TASKS

Tests first within every slice, per the standing rule. One slice at a time; do not start the next
unprompted. Each slice ends with `npm test` and `npm run typecheck` clean, then a conventional
commit.

**Slice 1 — scaffolding**
1. `npm i react react-dom`; `npm i -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite
   @types/react @types/react-dom jsdom @testing-library/react @testing-library/jest-dom
   @testing-library/user-event` at the exact versions from Verified 9.
2. `src/web/index.html`, `vite.config.ts`, `index.css`, `testSetup.ts`, `main.tsx`, `App.tsx`
   (minimal shell rendering an empty-state placeholder); `vitest.config.ts` gains `setupFiles`;
   `package.json` gains `dev:web`.
   → `feat(web): Vite + React + Tailwind v4 scaffold`

**Slice 2 — SSE parsing and pure helpers**
3. Tests 1-9.
4. `src/web/lib/sseStream.ts`, `lib/citations.ts`, `lib/tokenEstimate.ts`; `src/web/tsconfig.json`
   gains `../tokens.ts`.
   → `feat(web): SSE frame parser and citation/token-estimate helpers`

**Slice 3 — chat streaming**
5. Tests 10-16.
6. `src/web/hooks/useChatStream.ts`, `components/ChatPane.tsx`, wired into `App.tsx`.
   → `feat(web): streaming chat pane with cancellable Stop`

**Slice 4 — citations and source pane**
7. Tests 17-22.
8. `src/web/components/MessageBubble.tsx`, `CitationChip.tsx`, `SourcePane.tsx`; repoSource text
   field added to `App.tsx`.
   → `feat(web): citation chips and source pane`

**Slice 5 — trace panel and responsive layout**
9. Tests 23-24.
10. `src/web/components/TracePanel.tsx`; final two-pane/mobile-drawer layout, `dvh` sizing, 4/8px
    spacing, focus rings, and the accent/greyscale/font-stack polish across all components.
    → `feat(web): trace panel and responsive layout`

## Verification

Per-slice: `npm test` and `npm run typecheck` both clean.

End of block:

```bash
npm test          # full suite, including new src/web/**/*.test.tsx, still offline
npm run typecheck # both tsconfigs — root excludes src/web, src/web/tsconfig.json checks it
```

Then, manually, from inside the container (the dev server only needs to reach the browser via the
published port range, not prove a bind the way Block 4's `curl` gate proved `0.0.0.0`):

```bash
npm run dev:web   # vite on :5173, --host 0.0.0.0
npm run dev:server  # api on :8080, separate terminal
```

In a browser at the published `:5173` port:
- Ask a real question against an ingested repo; confirm tokens stream incrementally, citation
  chips appear once the answer finishes, and clicking one loads the right range into the source
  pane.
- Click Stop mid-stream; confirm the partial answer stays on screen and the trace shows an elapsed
  time and an estimated-tokens figure computed on the client (Verified 7).
- Resize to 375px and 1440px; confirm the single-column/two-pane switch, the source pane becomes a
  slide-up drawer under `md`, and the trace panel's `<details>` toggle works at both widths.
- Clear the repo-source field and click a citation; confirm the inline hint appears and no fetch
  fires (Network tab).
- Ask a question against an empty/uningested `repoSource`; confirm the no-results state renders
  rather than a blank pane.

**Commit.** No tag — `v0.1-working` was Block 4's milestone; Block 5 lands as its own set of five
commits.
