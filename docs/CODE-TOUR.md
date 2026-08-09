# CtxVault — Code Tour (what every file does & why)

This is your learning map. Read it top to bottom once; after that, use it as a lookup.
Each entry says **what the file is**, **what's inside it**, and **why it exists**.
At the end there are two "trace the request" walkthroughs and quiz questions.

---

## 1. The one-sentence mental model

> **One engine, two front doors.** All the memory logic lives in `packages/engine`.
> It never knows how it's being called. A thin *transport* wraps it: locally an MCP
> server over stdio (`apps/mcp-server`), and in Phase 3 an HTTP API on Vercel
> (`apps/playground`). Swap the transport, keep the brain.

The trick that makes this possible is the **StorageAdapter interface**. The engine
talks to storage through that interface only — so "SQLite on disk" and "in-memory on a
server" are just two implementations of the same shape.

```
apps/mcp-server ─┐
                 ├─► CtxEngine ──► StorageAdapter ─┬─► SqliteAdapter (disk)
apps/playground ─┘   (the brain)   (the seam)      └─► MemoryAdapter (Phase 2)
```

---

## 2. Directory map

```
ctxvault/
├── package.json          # npm workspaces root: ties the packages together
├── SPEC.md               # the implementation spec (read first)
├── AGENTS.md             # rules for AI coding agents working in this repo
├── .mcp.json             # Claude Code auto-discovers the server from here
├── packages/
│   └── engine/           # THE BRAIN — all memory logic, zero transport code
│       └── src/
│           ├── types.ts              # shared data shapes (+ zod validators)
│           ├── engine.ts             # save / resume / search / export verbs
│           ├── index.ts              # the package's public exports
│           ├── storage/
│           │   ├── adapter.ts        # StorageAdapter INTERFACE (the seam)
│           │   ├── sqlite.ts         # SQLite impl (durable, FTS5 index, writes OKF files)
│           │   └── memory.ts         # in-memory impl (Vercel playground)
│           ├── okf/okf.ts           # Open Knowledge Format files — see OKF-FACTS.md
│           ├── retriever.ts          # blendHits: keyword + vector + recency
│           ├── export/harness.ts     # CLAUDE.md / AGENTS.md block (bounded, replaceable)
│           ├── embed/                # OPTIONAL vector search — see SEARCH.md
│           │   ├── types.ts          # Embedder interface (the model seam)
│           │   └── vercel.ts         # VercelEmbedder (any AI SDK embedding model)
│           └── lib/
│               ├── text.ts           # FTS query building + JS BM25 fallback
│               ├── vector.ts         # cosine similarity + recency decay
│               ├── tokens.ts         # token budgeting (chars/4 rule)
│               └── slug.ts           # safe slug → filename (path-traversal guard)
├── apps/
│   ├── mcp-server/        # LOCAL front door — stdio MCP server + the `ctx` CLI
│   │   └── src/
│   │       ├── index.ts   # registers the 6 MCP tools, boots the transport
│   │       ├── schema.ts  # the handoff form the agent fills — see HANDOFF.md
│   │       ├── cli.ts     # `ctx` — export / search / list / reindex
│   │       └── config.ts  # where the vault lives on disk (~/.ctxvault)
│   └── playground/        # HOSTED front door — Next.js on Vercel — see PLAYGROUND.md
│       ├── app/           # three-pane UI + /api routes (save/resume/search/…)
│       └── lib/           # per-session engine registry + distill.ts (the fake agent)
└── docs/
    ├── CODE-TOUR.md       # ← you are here
    ├── REGISTER.md        # wire the server into Claude Code / Codex
    ├── HANDOFF.md · SEARCH.md · OKF-FACTS.md · PLAYGROUND.md · DATA-FLOW.md
    └── PLAN-V2.md         # the keyless pivot: what changed and why
```

> **There is no `llm/` directory, and that's the headline.** v1 had one — a
> summarizer and prompts that called our own model. v2 deleted it: the calling
> agent writes the handoff, so the only prompt left in the codebase is the field
> descriptions in `apps/mcp-server/src/schema.ts`. See [HANDOFF.md](HANDOFF.md).

---

## 3. File-by-file

### `package.json` (root)
**What:** the npm **workspaces** manifest.
**Contains:** `"workspaces": ["packages/*", "apps/mcp-server"]` and convenience scripts
(`build`, `mcp`). `"type": "module"` = the whole repo is ESM.
**Why:** workspaces let `apps/mcp-server` import `@ctxvault/engine` by name (npm creates
a symlink in `node_modules`) instead of by relative path. One `npm install` wires
everything.

### `SPEC.md`
**What:** the frozen implementation spec.
**Contains:** architecture, the SAVE/RESUME/SEARCH flows, the token model, the phase
plan, and the hard rules (WAL, stderr-only).
**Why:** so any coding agent (or future you) rebuilds the same thing without re-deciding.

### `AGENTS.md`
**What:** the working agreement for AI agents editing this repo.
**Contains:** "one phase at a time", "never stdout in mcp-server", the teach-back ritual.
**Why:** keeps generated code disciplined and inside the plan.

---

### `packages/engine/src/types.ts` — the vocabulary
**What:** every data shape the system passes around.
**Contains:**
- **zod schemas** for things an LLM will produce and we must *validate*:
  - `HandoffNoteSchema` — the structured session summary (`goal`, `decisions[{what,why}]`,
    `currentState`, `openTodos`, `filesTouched`, `gotchas`, `nextStep`). This is the
    **episodic** memory.
  - `FactSchema` — one durable knowledge item (`slug`, `type`, `title`, `body`, `tags`).
    This is the **semantic** memory, later written as an OKF markdown file.
- **TS interfaces** for rows we store: `Snapshot`, `StoredFact`, `Session`, `NewVector`,
  `SearchHit`.
**Why zod for some and plain types for others?** zod = *runtime* validation of untrusted
data (an LLM can return malformed JSON). Plain interfaces = *compile-time* shape of data
we ourselves create. Use the heavier tool only where the danger is.

### `packages/engine/src/storage/adapter.ts` — the seam ⭐
**What:** the `StorageAdapter` **interface** — the single most important design decision.
**Contains:** method signatures only: `saveSnapshot`, `getLatest`, `listSnapshots`,
`saveFact`, `listFacts`, `saveVector`, `search`, `listSessions`, `close`.
**Why:** the engine depends on this interface, never on a concrete database. That's what
lets the *same* engine run on SQLite locally and in-memory on Vercel. This file is the
"two front doors" enabler in one page of TypeScript.

### `packages/engine/src/storage/sqlite.ts` — durable local storage
**What:** the `SqliteAdapter` class — the on-disk implementation of the interface.
**Contains:**
- `migrate()` — creates 3 tables: `snapshots` (episodic), `facts` (semantic/OKF),
  `vectors` (embeddings).
- The CRUD methods, all using **prepared statements** (compiled once, injection-safe).
- `search()` — loads a project's vectors and does **brute-force cosine** in JS.
- `listSessions()` — *derived* from snapshots with `GROUP BY session` (no separate table
  to keep in sync).
- snake_case row → camelCase object mappers at the bottom.
**Why these choices (be ready to defend to a judge):**
- **WAL mode** → readers don't block the writer; crash-safe.
- **better-sqlite3 is synchronous** → we still return Promises so this class is
  drop-in interchangeable with async adapters.
- **JSON embeddings + brute-force cosine** → trivially simple and instant at hundreds of
  vectors. No vector-DB dependency to justify.

### `packages/engine/src/lib/vector.ts` — the math
**What:** pure functions, no state.
**Contains:** `dot`, `magnitude`, `cosineSimilarity`, `recencyDecay`.
**Why:** `cosineSimilarity` is *why semantic search beats keyword search* — it compares
meaning (vector direction), so "auth flow" matches "login handling" even with zero shared
words. `recencyDecay` (half-life 3 days) makes newer memories rank higher without deleting
old ones.

### `packages/engine/src/lib/tokens.ts` — budgeting
**What:** cheap token estimation.
**Contains:** `estimateTokens` (chars/4), `tokensToChars`, `truncateHead` (keeps the
*tail* of a transcript — the most recent messages — within a budget).
**Why:** RESUME must fit the restored context into a token budget. We don't need an exact
tokenizer to decide what to drop; chars/4 is accurate enough and dependency-free.

### `packages/engine/src/engine.ts` — the brain ⭐
**What:** `CtxEngine`, the class every front door calls.
**Contains:** the verbs:
- `save({project, session, handoff, facts, transcript?})` → validates the
  agent-authored handoff, stores a snapshot, writes each fact as an OKF file,
  indexes everything. Returns a receipt.
- `resume({project, budget})` → gets the latest snapshot, packs it under budget,
  returns the text to inject into the new tool.
- `exportPacket({project, compact})` → the same packer, addressed to a tool that
  has never heard of CtxVault.
- `search(project, query, k)` → hybrid retrieval; `listFacts`, `listSessions`.

**What it deliberately does NOT contain:** a model. `save` performs no inference —
the calling agent already did the thinking, so this method's job is validation,
durability and indexing. Constructor is `(store, embedder?)`, and the embedder is
optional because keyword search lives in the storage adapter.

### `packages/engine/src/index.ts` — public API
**What:** the curated export list.
**Contains:** re-exports of `CtxEngine`, `SqliteAdapter`, the types, and the helpers.
**Why:** front doors import only from `@ctxvault/engine`, so we can refactor internals
freely without breaking callers.

---

### `apps/mcp-server/src/config.ts` — where memory lives
**What:** resolves the vault location.
**Contains:** `~/.ctxvault/ctxvault.db` and `~/.ctxvault/knowledge/`, overridable via
`CTXVAULT_HOME`.
**Why:** a *shared* on-disk location is what lets Claude Code and Codex see each other's
saves. `CTXVAULT_HOME` gives demos a clean vault.

### `apps/mcp-server/src/index.ts` — the LOCAL front door ⭐
**What:** the stdio MCP server.
**Contains:**
- Builds one `SqliteAdapter` + `CtxEngine`.
- `server.registerTool(...)` × 3: `save_context`, `resume_context`, `list_sessions`.
  Their **descriptions are written as prompts** — they tell the model *when* to call the
  tool ("when you are about to hit a usage limit", "when the user says resume").
- `StdioServerTransport` + `server.connect()` to start listening.
**The one rule that will bite you:** **never `console.log`.** stdio MCP uses **stdout for
the JSON-RPC protocol**. All logging goes to **stderr** via `console.error`. One stray
stdout write corrupts the stream and the client silently drops the server. That's why the
file defines `const log = (...) => console.error(...)` and uses it everywhere.

---

## 4. Trace a request

### SAVE (Claude Code → vault)
1. Model decides to call `save_context` (guided by the tool description).
2. `apps/mcp-server/src/index.ts` handler runs → `engine.save({project, session, transcript})`.
3. `engine.ts` → `store.saveSnapshot(...)`.
4. `sqlite.ts` → prepared `INSERT` into `snapshots`, returns a `Snapshot` with a UUID.
5. Handler returns a text receipt to the model. Log line goes to **stderr**.

### RESUME (Codex, later, different process)
1. Model calls `resume_context({project})`.
2. Handler → `engine.resume(...)`.
3. The **packer** assembles a priority stack within the token budget:
   HandoffNote (force-included) → knowledge index (all fact titles) → relevant fact
   bodies (ranked by the note's goal/next-step via the embedder) → recent transcript
   tail. Lowest priority is truncated first when the budget is tight.
4. Handler returns the packed context; Codex reads it and continues the task.

The two processes never talk — they meet at `~/.ctxvault/ctxvault.db`.

---

## 5. Quiz yourself (from the plan's learning ritual)

1. **Why does the engine depend on `StorageAdapter` instead of importing `SqliteAdapter`
   directly?** (What does that buy the playground?)
2. **Why must the MCP server log to stderr, never stdout?**
3. **Why can vector search match "auth flow" ↔ "login handling" when a `LIKE` query
   can't?**
4. **Why is `listSessions` derived from the snapshots table instead of its own table?**
5. **Why return Promises from `SqliteAdapter` when better-sqlite3 is synchronous?**

<details><summary>Answers</summary>

1. The engine stays transport/storage-agnostic; the playground hands it a different
   adapter (in-memory) and the same logic runs on Vercel. "One engine, two doors."
2. stdio MCP uses stdout for the JSON-RPC message stream; any extra stdout bytes corrupt
   it and the client drops the server.
3. Embeddings place similar *meanings* near each other in vector space; cosine similarity
   measures that closeness by direction, so different words with the same meaning still
   match. `LIKE` only matches literal characters.
4. Sessions are just a grouping of snapshots — deriving them with `GROUP BY` means there's
   no second table to keep consistent; it can never drift.
5. So `SqliteAdapter` is interchangeable with async adapters (in-memory/HTTP). The
   interface is async; sync implementations just resolve immediately.

</details>

---

## 6. What's built vs. what's next

| Layer | Status | File(s) |
|---|---|---|
| StorageAdapter interface | ✅ done | `storage/adapter.ts` |
| SQLite adapter (durable) | ✅ done | `storage/sqlite.ts` |
| MCP server + 6 tools | ✅ done | `apps/mcp-server` |
| Cross-tool handoff proven | ✅ done | (smoke-tested) |
| Agent-authored handoff (no LLM) | ✅ done | `schema.ts` + `engine.ts` — see [HANDOFF.md](HANDOFF.md) |
| Keyword search (FTS5/BM25) | ✅ done | `storage/sqlite.ts` + `lib/text.ts` — see [SEARCH.md](SEARCH.md) |
| Hybrid search when a key exists | ✅ done | `embed/` + `retriever.ts` |
| OKF writer | ✅ done | `okf/okf.ts` — see [OKF-FACTS.md](OKF-FACTS.md) |
| In-memory adapter | ✅ done | `storage/memory.ts` |
| Packer (priority-stack resume) | ✅ done | `engine.ts` `resume()` |
| Export: paste packet + CLAUDE.md/AGENTS.md | ✅ done | `export/harness.ts` + `cli.ts` |
| `ctx` CLI | ✅ done | `apps/mcp-server/src/cli.ts` |
| **Memory engine complete** | ✅ | all of `packages/engine` |
| Web-safe engine barrel | ✅ done | `packages/engine/src/web.ts` |
| Vercel playground (3-pane UI + API) | ✅ done | `apps/playground` — see [PLAYGROUND.md](PLAYGROUND.md) |
| `ctx sync` — vault over your own git remote | ⏳ next | see [PLAN-V2.md](PLAN-V2.md) phase 4 |
