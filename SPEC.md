# CtxVault — Implementation Spec

> One engine, two front doors. Read this before touching code.

## What it is

**CtxVault is the handoff button for AI tools.** You start work in one AI CLI (Claude
Code), hit your usage limit or want a different model, open another (Codex), type
`resume`, and your full working context is restored. Memory is stored **locally** in a
SQLite file plus human-readable markdown files in **Google's Open Knowledge Format
(OKF)** — so any agent, or a human, can read it without CtxVault running.

## Architecture: one engine, two transports

```
        CtxVault Memory Engine  (packages/engine — shared TypeScript)
        summarizer · extractor · embedder · retriever · packer · StorageAdapter
                 │                                  │
        MCP over stdio                        HTTP (Next.js API)
                 │                                  │
   LOCAL: Claude Code / Codex           HOSTED: Vercel playground
   SQLite + OKF files on disk           in-memory Map per session
```

The engine never talks to a transport directly. It talks to a **StorageAdapter**.
- Local adapter = SQLite (+ OKF markdown files on disk).
- Hosted adapter = in-memory `Map` keyed by session (Vercel is stateless).

Judge-facing line: *"same engine, only the transport differs — MCP over stdio locally,
HTTP in the cloud."*

## StorageAdapter interface (the enabler)

```ts
interface StorageAdapter {
  saveSnapshot(input): Promise<Snapshot>      // raw transcript + optional handoff note
  getLatest(project): Promise<Snapshot|null>  // newest snapshot for a project
  saveFact(fact): Promise<Fact>               // upsert OKF fact by slug
  listFacts(project): Promise<Fact[]>
  saveVector(vec): Promise<void>              // embedding + payload
  search(project, queryVec, k): Promise<...>  // cosine similarity top-k
  listSessions(project): Promise<Session[]>
}
```

## Engine flows

### SAVE  `save_context(project, transcript)`
1. Summarizer LLM → `HandoffNote` (strict JSON via zod, retry once, map-reduce if >20k chars).
2. Fact extractor LLM → `facts[]`.
3. OKF writer creates/overwrites `knowledge/<project>/<slug>.md` (frontmatter + body <150 words).
4. Embed note + fact bodies → store vectors (fact vectors carry `file_path`).

**Phase 1 does the DUMB version:** store the raw transcript as a snapshot, no LLM. Intelligence is layered in Phase 2.

### RESUME  `resume_context(project, budget=4000)`
Priority order, truncate lowest first (chars/4 ≈ tokens):
1. OKF index — titles + one-liners (~200 tok)
2. Top 3–5 relevant OKF bodies
3. Latest HandoffNote (full)
4. Last ~10 verbatim messages

### SEARCH  `search_memory(project, query)`
Embed query → cosine over vectors → return HandoffNote sections / OKF bodies with dates.

### Retriever score
`0.6·similarity + 0.3·recencyDecay(half-life 3d) + 0.1·sameProjectBoost`, always
force-include the latest HandoffNote.

## Token model (say this to judges)
Store everything (free) → retrieve little (top-k) → compress what you inject
(HandoffNote ≈ 60x semantic compression) → budget the packet. **OKF is a shelf, not a
compressor — never claim OKF saves tokens.**

## Memory tiers
working = last 10 verbatim · episodic = HandoffNotes · semantic = OKF facts.

## Build phases
- **Phase 1 (Day 1):** SQLite behind StorageAdapter + MCP server, stdio, save/resume RAW text. Register in Claude Code + Codex, prove a real handoff. ← highest priority, submittable-in-spirit.
- **Phase 2 (Day 2):** summarizer, embedder+search, fact extractor+OKF writer, in-memory adapter, retriever+packer, `--no-ai` flag.
- **Phase 3 (Day 3):** Next.js playground on Vercel, README, deck, 3-min video.

## Hard rules
- **Never write to stdout in the MCP server** — stdio transport uses stdout for the JSON-RPC protocol. Log to **stderr only**.
- SQLite in WAL mode, prepared statements.
- OKF slug match = overwrite + bump date. No merge intelligence.
