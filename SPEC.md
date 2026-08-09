# CtxVault — Implementation Spec

> One engine, several front doors. Read this before touching code.

## What it is

**CtxVault is the handoff button for AI tools.** You start work in one AI CLI (Claude
Code), hit your usage limit or want a different model, open another (Codex), type
`resume`, and your full working context is restored. Memory is stored **locally** in a
SQLite file plus human-readable markdown files in **Google's Open Knowledge Format
(OKF)** — so any agent, or a human, can read it without CtxVault running.

## The v2 contract: the agent thinks, the vault remembers

v1 accepted a raw transcript and called its OWN LLM to summarize it and extract facts.
That made an API key a hard requirement and paid twice to understand one session: once
in the coding agent that lived through it, and again in us.

**v2 inverts it.** The calling agent authors the `HandoffNote` and the facts — the MCP
tool's input schema *is* that form — and CtxVault validates, stores, indexes, ranks,
packs and exports. Consequences, all load-bearing:

- **No API key, no model config, no per-call cost.** `npm run build` and go.
- **Better source material.** The agent summarizing its own live session beats an
  external model reading a pasted transcript.
- **The tool description is the prompt.** Every field carries a `.describe()`; that
  text is the only instruction the agent gets. Vague descriptions → vague handoffs →
  failed resumes. Treat `apps/mcp-server/src/schema.ts` as prompt engineering.
- **An embedding model is an optional upgrade**, never a requirement (see SEARCH).

## Architecture

```
        CtxVault Memory Engine  (packages/engine — shared TypeScript, NO model)
        indexer · retriever · packer · exporter · StorageAdapter
           │                    │                      │
     MCP over stdio      markdown packet        HTTP (Next.js API)
           │                    │                      │
  LOCAL: Claude Code /   ANYWHERE: claude.ai,   HOSTED: Vercel playground
  Codex / Cursor         ChatGPT, CLAUDE.md     in-memory Map per session
  SQLite + OKF on disk
```

The engine never talks to a transport directly. It talks to a **StorageAdapter**.
- Local adapter = SQLite + FTS5 (+ OKF markdown files on disk).
- Hosted adapter = in-memory `Map` keyed by session (Vercel is stateless).

## Source of truth

**Markdown files are the truth; SQLite is a derived index.** Every fact is a real file
at `knowledge/<project>/<slug>.md`; the database can be rebuilt from stored documents
(`ctx reindex`). This is what makes a vault syncable as a plain folder, and it is the
invariant to preserve when adding storage features.

## StorageAdapter interface

```ts
interface StorageAdapter {
  saveSnapshot(input): Promise<Snapshot>      // transcript + agent-authored handoff
  getLatest(project, session?): Promise<Snapshot|null>
  listSnapshots(project, limit?): Promise<Snapshot[]>

  saveFact(fact): Promise<StoredFact>         // upsert OKF fact by (project, slug)
  listFacts(project): Promise<StoredFact[]>

  indexText(doc): Promise<void>               // keyword index — ALWAYS available
  searchText(project, query, k): Promise<SearchHit[]>   // BM25, lexical normalized 0..1

  saveVector(vec): Promise<void>              // optional: only with an embedder
  search(project, queryVec, k, embedder?): Promise<SearchHit[]>  // cosine top-k

  listSessions(project): Promise<Session[]>
  close(): Promise<void>
}
```

Two search methods because there are two indexes over the same documents, identified in
both by `(project, kind, refId)` so results can be merged.

## Engine flows

### SAVE `save_context(project, handoff, facts?, transcript?, session?)`
1. Persist the snapshot (handoff + optional verbatim tail).
2. Index the handoff for keyword search; embed it too if an embedder is configured.
3. For each fact: write `knowledge/<project>/<slug>.md`, upsert the row, index it.
4. Embed all facts in **one batched call** (never one call per fact).

No handoff supplied → raw storage, `mode: "raw"`. Every index step is best-effort: a
failure costs discoverability, never the saved context.

### RESUME `resume_context(project, budget=4000, session?)`
Priority stack, truncate lowest first (chars/4 ≈ tokens):
1. Latest HandoffNote (force-included)
2. Knowledge index — every fact's title + one-liner
3. Top ~5 relevant fact bodies (ranked against the note's goal/next-step)
4. Recent verbatim transcript tail — fills whatever budget remains

### EXPORT `export_context(project, target, dir?, budget?)`
Same packer, different address. `target: "text"` returns a paste-able packet;
`"claude"` / `"agents"` write a compact block (default 600-token budget, no transcript)
into `CLAUDE.md` / `AGENTS.md`.

**The block is bounded by construction:** one marked region, always REPLACED, never
appended; everything outside the markers is preserved byte for byte. The vault grows;
that file must not. This is the whole answer to "don't stuff your context file."

### SEARCH `search_memory(project, query, k=5)`
Keyword (BM25) always runs; vector search joins in when an embedder exists. Both halves
are best-effort — whichever works still answers.

```
hybrid:        score = 0.45·lexical + 0.30·similarity + 0.25·recency
keyword-only:  score = 0.70·lexical + 0.30·recency
```

`recency` = `recencyDecay(ageDays)`, 3-day half-life. **Relevance floor:** a hit must
have `lexical > 0` or `similarity ≥ 0.3` — "no match" must be said, not implied by a
low number.

Never claim BM25 beats embeddings. The claim is that keyword is the right *default*
(free, instant, strong on short titled technical notes) and that a key upgrades search
rather than unlocking it.

## Token model
Store everything (free) → search inside the vault (costs zero context; the scan happens
in SQLite, not in the model's window) → inject only the ranked slice → budget the
packet. **OKF is a shelf, not a compressor — never claim OKF saves tokens.**

## Memory tiers
working = verbatim tail · episodic = HandoffNotes · semantic = OKF facts.

## Hard rules
- **Never write to stdout in the MCP server** — stdio transport uses stdout for the
  JSON-RPC protocol. Log to **stderr only**.
- SQLite in WAL mode, prepared statements.
- OKF slug match = overwrite + bump date. No merge intelligence.
- Fact slugs arrive from a model and become filenames — always `slugify()` them.
- FTS5 has no upsert: delete-then-insert, inside one transaction.
- The engine imports no model SDK on the save/resume path. If that changes, v2's
  central promise is gone.
