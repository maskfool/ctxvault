# CtxVault v2 — "Zero API Keys" Pivot Plan

> **Status (2026-08-09):** Phases 1, 2, 3 and 5 are implemented and verified end to
> end — engine, MCP server, `ctx` CLI, playground, and all docs. `SUMMARIZER.md`
> was replaced by [HANDOFF.md](HANDOFF.md) and `EMBEDDINGS.md` by
> [SEARCH.md](SEARCH.md). **Remaining: Phase 4 — git sync.**

**Goal:** CtxVault stops being an AI service (that summarizes with its own LLM) and becomes
**a format + a place**: the calling agent does the thinking, CtxVault stores, searches,
packs, and exports. `npx ctxvault` must work with **no env vars at all**.

**New pitch:** *"Your agent already knows the context. CtxVault makes it outlive the
session, travel between tools, and belong to you — zero API keys."*

---

## Phase 1 — Schema flip: agent-authored handoffs (the core change)

The agent calling `save_context` already has the whole session in its window. Instead of
sending a raw transcript for our LLM to re-understand, the tool's input schema **becomes
the HandoffNote + facts form**, and the agent fills it in.

### 1.1 `apps/mcp-server/src/index.ts` — new `save_context` schema

Replace the `transcript: z.string()` input with the structured form (reuse the shapes
from `packages/engine/src/types.ts`):

```
project:   string
session?:  string (default "main")
handoff: {
  goal, currentState, nextStep: string
  decisions: { what, why }[]
  openTodos: string[]
  filesTouched: string[]
  gotchas: string[]
}
facts?: {
  slug, type, title, body, tags[]     // same FactGenSchema shape
}[]
transcript?: string                    // optional raw tail, stored as backup context
```

- The tool **description is the prompt**: tell the agent to distill its own session into
  the form ("you already know this session — fill each field from what actually
  happened; extract 0–5 durable facts worth keeping after this session ends").
- Field `.describe()` texts: copy from the existing gen-schemas in
  `packages/engine/src/llm/vercel.ts` (they were written exactly for this job).
- Defensively `slugify()` fact slugs (same as today — slug becomes a filename).

### 1.2 `packages/engine/src/engine.ts` — `save()` takes the note directly

- `SaveInput` becomes `{ project, session, handoff: HandoffNote, facts: Fact[], transcript?: string }`.
- Delete the `this.llm.summarize()` / `extractFacts()` calls from `save()`.
- `mode` result field: `"agent"` (structured came in) | `"raw"` (transcript only).
- Everything downstream (saveSnapshot, saveFact, OKF write, indexing) is unchanged.

### 1.3 Retire the server-side LLM

- Delete `packages/engine/src/llm/` (vercel.ts, prompts.ts, types.ts) and the
  `llm` constructor param on `CtxEngine`.
- `apps/mcp-server`: remove `buildLlm()`, `--no-ai`, `CTXVAULT_MODEL`, `aiStatus`.
  The status line becomes: `DB: … . Search: fts5[+embeddings]`.
- Playground: `apps/playground/lib/chat.ts` keeps its own `generateText` (pane chat is a
  demo concern, not the engine) — but the playground's save path must now build the
  structured handoff the same way an agent would (its `/api/save` route constructs the
  HandoffNote via its chat model when a key exists, else a template from the messages).
- Keep `packages/engine/src/ai/provider.ts` (playground + optional embedder still use it).

**Why full delete, not "legacy fallback":** two save paths = two things to test and
explain. The raw-transcript fallback (no handoff supplied) already covers the degraded
case.

---

## Phase 2 — FTS5 (BM25) search by default, hybrid when a key exists

### 2.1 `packages/engine/src/storage/sqlite.ts`

- Add an FTS5 virtual table in `migrate()`:
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
    project UNINDEXED, kind UNINDEXED, ref_id UNINDEXED, file_path UNINDEXED,
    title, tags, body
  );
  ```
  (better-sqlite3 bundles FTS5 — verify once with `PRAGMA compile_options`.)
- Index on write: `saveFact()` and `saveSnapshot()` (handoff text) upsert into `mem_fts`
  (delete-then-insert by `ref_id` for fact updates).
- One-time backfill in `migrate()`: if `mem_fts` is empty but `facts` is not, re-index
  existing rows so current users keep their search.
- New adapter method `searchText(project, query, k): SearchHit[]` — `bm25(mem_fts)`
  ranking, normalize score to ~0..1 so it can blend with cosine.
  Sanitize the query for FTS syntax (quote terms; `OR` the words — agent queries are
  natural language, not FTS expressions).

### 2.2 `packages/engine/src/engine.ts` — `search()` becomes hybrid

- No embedder → pure FTS (BM25 + the existing recency blend in `retriever.ts`).
- Embedder present → run both, blend: `score = 0.5·bm25 + 0.3·cosine + 0.2·recency`
  (weights in `retriever.ts`, one place). Union candidates by `ref_id`.
- Delete `LocalEmbedder` (`packages/engine/src/embed/local.ts`) — FTS replaces it and is
  strictly better at the same price. Relevance floor logic simplifies accordingly.
- `rankFactsForHandoff()` in resume: works unchanged, now backed by FTS.

### 2.3 MCP server wiring

- Embedder only when `canEmbed()` — otherwise none (no local fallback needed anymore).
- `search_memory` tool description: add *"If nothing relevant comes back, retry once with
  different keywords."* (agentic retry is the cheapest quality boost).

---

## Phase 3 — Export: paste-anywhere packet + harness files

### 3.1 Engine: `export()` = `resume()` renderer, second output channel

- `engine.export({ project, session?, budget? })` → returns the same packed markdown
  `resume()` builds (reuse the packer verbatim; no new packing logic).

### 3.2 New MCP tool `export_context`

- Returns the packet as text + writes it to a file the user names (or clipboard note).
- Description: "when the user wants to continue in a tool that doesn't have CtxVault
  (ChatGPT web, claude.ai, Gemini), export a paste-able context packet."

### 3.3 Harness-file writer (the killer integration)

- `engine.exportToFile({ target: "claude" | "agents", dir })`:
  - Writes/replaces a **bounded, marked section** in `CLAUDE.md` / `AGENTS.md`:
    ```
    <!-- ctxvault:start (auto-generated, do not edit) -->
    …latest handoff, ≤500 tokens…
    <!-- ctxvault:end -->
    ```
  - **Replace, never append** — the file must not grow across sessions.
  - Create the file if missing; if markers missing, append the block once at the end.
- Expose as part of `export_context` (`target` param) and in the CLI (3.4).

### 3.4 Minimal CLI (`ctx`)

- New bin in `apps/mcp-server` (or a tiny `apps/cli`): `ctx export [--to claude|agents|clipboard] [--project X]`,
  `ctx list`, `ctx search <q>`. Reuses the engine directly. This is what makes CtxVault
  usable outside any agent at all.

---

## Phase 4 — Sync via the user's own git remote (later / stretch)

- `ctx sync init <remote-url>` → `git init` inside `~/.ctxvault`, add remote.
- `ctx sync` → commit-all + pull --rebase + push. Conflicts: facts are one-file-per-fact
  markdown, so conflicts are rare and human-fixable; SQLite is **not synced** — it's an
  index, rebuild it from the markdown (add `ctx reindex`).
- This ordering forces a good invariant: **markdown files are the source of truth,
  SQLite is a derived index.** Worth stating in SPEC.md.

---

## Phase 5 — Reposition (README, SPEC, playground)

- README: new pitch up top — zero keys, agent-authored handoffs, FTS default,
  hybrid as an upgrade, export-anywhere, git sync. The comparison table gains a
  "needs its own API key" row: everyone else ✅, CtxVault ❌.
- Address the CLAUDE.md-bloat critique head-on (it's our best argument):
  *"Don't stuff working memory into an always-loaded file — vault it, inject only the
  relevant slice, under a budget."*
- SPEC.md: document the flipped save contract + "markdown is truth, SQLite is index".
- Playground: Save button now builds the structured handoff (1.3); add an **Export**
  button showing the paste-anywhere packet — that's the new demo moment.

---

## Order of work & effort

| # | Task | Size | Depends on |
|---|------|------|-----------|
| 1 | Schema flip (1.1–1.3) | ~½ day | — |
| 2 | FTS5 + hybrid (2.x) | ~½ day | — (parallel-safe with 1) |
| 3 | Export tool + CLAUDE.md writer (3.1–3.3) | ~½ day | 1 |
| 4 | CLI (3.4) | small | 3 |
| 5 | README/SPEC/playground reposition (5) | ~½ day | 1–3 |
| 6 | Git sync (4) | stretch | 3 |

## Risks / decisions already made

- **Delete server-side LLM, don't keep as fallback** — raw-transcript mode is the fallback.
- **Delete LocalEmbedder** — FTS5 replaces it outright.
- **BM25 vs embeddings honesty:** default is FTS (zero setup); a key upgrades search to
  hybrid automatically. Never claim BM25 is universally better.
- **Vectors table stays** — hybrid path still uses it; only comparisons within one
  embedder id (unchanged rule).
- Old snapshots saved by v1 keep working: resume/list read `handoff_json` the same way.
