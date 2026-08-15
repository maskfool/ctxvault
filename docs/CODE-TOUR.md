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
│           ├── lib/
│           │   ├── text.ts           # FTS query building + JS BM25 fallback
│           │   ├── vector.ts         # cosine similarity + recency decay
│           │   ├── tokens.ts         # token budgeting (chars/4 rule)
│           │   └── slug.ts           # safe slug → filename (path-traversal guard)
│           └── ../test/              # the invariants, as executable claims
├── apps/
│   ├── mcp-server/        # THE FRONT DOORS + the `ctx` CLI
│   │   ├── src/
│   │   │   ├── tools.ts   # the 6 MCP tools — registered by BOTH transports
│   │   │   ├── index.ts   # stdio MCP (spawned by Claude Code, Cursor, Codex…)
│   │   │   ├── serve.ts   # HTTP MCP (browser + remote connectors), localhost-only
│   │   │   ├── install.ts # `ctx install` — merges config per client
│   │   │   ├── hook.ts    # `ctx hook` — model-free auto-capture
│   │   │   ├── runtime.ts # one way to open the vault, shared by all four
│   │   │   ├── sync.ts    # the vault over your own git remote
│   │   │   ├── schema.ts  # the handoff form the agent fills — see HANDOFF.md
│   │   │   ├── cli.ts     # `ctx` — install / serve / hook / export / search / sync
│   │   │   └── config.ts  # where the vault lives on disk (~/.ctxvault)
│   │   └── test/          # hook policy, config merging, arg parsing
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
> agent writes the handoff, so the only prompts left in the codebase are the
> field descriptions in `apps/mcp-server/src/schema.ts` and the tool descriptions
> in `apps/mcp-server/src/tools.ts`. See [HANDOFF.md](HANDOFF.md).

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

### `packages/engine/src/lib/slug.ts` — the identity boundary ⭐
**What:** `slugify()` (untrusted LLM string → safe filename) and
`normalizeProject()` (any spelling of a project → its canonical key).
**Why `normalizeProject` exists:** `project` is the vault's primary key and it
arrives from three sources that disagree — the CLI and the hook use
`basename(cwd)`, an agent uses whatever the human said. Storage used to be split
on this: file paths ran through `slugify`, so every spelling shared a directory,
while SQL matched the raw string, so every spelling was a different vault. You
could save context and be told *"No saved context found"* for the same folder —
which reads as data loss, not a typo.
**The invariant:** `normalizeProject` **is** `slugify`, deliberately — not merely
similar. That equality means the database key is always exactly the directory
name holding that project's files, which is what lets `ctx projects` answer from
the filesystem and lets `importFromFiles` heal a legacy vault in place (the row
id is stable, so the UPSERT rewrites rather than duplicates).
**Known limit:** word breaks aren't guessed. `myapp` and `my app` stay distinct,
because collapsing them would break the invariant above. `ctx projects` is the
escape hatch.

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

### `apps/mcp-server/src/runtime.ts` — one way to open the vault
**What:** `createRuntime()` → `{ store, engine, searchStatus }`.
**Why:** four front doors now reach the same memory (stdio, HTTP, CLI, hook). If each
built its own adapter and made its own embedder decision, "the same vault everywhere"
would quietly become "almost the same vault everywhere". The decision lives here once.
**Note:** it never throws on a bad embedder — keyword search needs no key, so a broken
embedder is a downgrade to lexical search, never a failure to start (AGENTS.md rule 8).

### `apps/mcp-server/src/tools.ts` — the 6 tools, transport-free ⭐
**What:** `registerTools({ server, engine, log, defaultDir })` registers `save_context`,
`resume_context`, `export_context`, `list_sessions`, `search_memory`, `list_facts` onto
*any* `McpServer`.
**Why it's separate:** stdio and HTTP both register **these**, so a Claude Code process
and a browser connector get a byte-identical contract. One definition, two transports.
**The `.describe()` strings are the product.** They are the only instructions a calling
agent ever receives — they say *when* to reach for the tool ("when you are about to hit a
usage limit") and that the **caller** writes the handoff. That's the v2 contract, encoded
as a schema instead of a prompt we control.
**`defaultDir`:** where `export_context` writes `CLAUDE.md` when the caller gives no
`dir`. stdio passes `process.cwd()` (the client launched us inside the project); HTTP
passes `null`, because the server's cwd has nothing to do with the caller's — so the tool
asks instead of writing a file into the wrong repo.

### `apps/mcp-server/src/index.ts` — the LOCAL front door ⭐
**What:** the stdio MCP server. An MCP client spawns it and speaks JSON-RPC over
stdin/stdout.
**Contains:** `createRuntime()`, `registerTools(...)`, then `StdioServerTransport` +
`server.connect()`. It is deliberately thin — the tools moved to `tools.ts`.
**The one rule that will bite you:** **never `console.log`.** stdio MCP uses **stdout for
the JSON-RPC protocol**. All logging goes to **stderr** via `console.error`. One stray
stdout write corrupts the stream and the client silently drops the server. That's why the
file defines `const log = (...) => console.error(...)` and uses it everywhere.

### `apps/mcp-server/src/serve.ts` — the REMOTE front door
**What:** `ctx serve` — Streamable HTTP MCP on `127.0.0.1:7077/mcp`, plus `/health`.
**Why:** stdio only works for clients that can spawn a process, which rules out browser
clients, sandboxed apps and remote-connector fields. Those speak HTTP MCP.
**Stateless by choice:** a fresh `McpServer` + transport per request over the **shared**
engine. No session state means no leak between clients and nothing to reap on disconnect;
the state worth keeping is on disk anyway. The engine (and its SQLite handle) is the
expensive part and it's created once.
**Safety, because this is memory on a port:** binds localhost only, optional bearer token
compared with `timingSafeEqual` (a plain `===` leaks the prefix), DNS-rebinding protection
on, and an 8 MB body cap.

### `apps/mcp-server/src/install.ts` — `ctx install <client>`
**What:** writes the MCP config for Claude Code, Claude Desktop, Cursor, Codex, VS Code.
**Why:** the old quick start was clone → build → copy an absolute path → hand-edit a
different file per client, one of them TOML, one of them keyed `servers` instead of
`mcpServers`. Every step is a place to give up.
**Two rules that make editing someone's config safe:** back up before the first write, and
**merge, never replace** — other servers and unrelated settings survive byte-identical.
**`upsertTomlTable` is pure and tested** because it edits a hand-written file: it must also
drop stale *subtables* (an old `[mcp_servers.ctxvault.env]` full of API keys would
otherwise survive a header-only replace and keep being loaded).

### `apps/mcp-server/src/hook.ts` — auto-capture ⭐
**What:** `ctx hook` runs on Claude Code's **PreCompact** and **SessionEnd** and stores a
raw transcript tail.
**The hole it fills:** `save_context` needs the agent to have a turn left to write the
handoff — and the moment you most need the save is exactly the moment it can't produce
one. The demo works; the real limit scenario doesn't. This makes the vault independent of
the agent's cooperation.
**Model-free by rule (AGENTS.md 7):** it summarizes nothing. It slices JSONL and stores
it. No key, no network, nothing that can be down.
**`decideCapture` is the whole feature, and it's pure.** Two tiers must not fight: an
automatic raw snapshot arriving *later* than a curated handoff would become "newest" and
shadow it on resume. So capture stands down if an agent-authored handoff landed within 30
minutes, and throttles to once per 5 minutes per project. Saved snapshots carry a banner
marking them as raw evidence, not a summary — so the next agent knows what it's reading.

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
| `ctx sync` — vault over your own git remote | ✅ done | `sync.ts` |
| Test suite + CI (the invariants) | ✅ done | `packages/engine/test/`, `apps/mcp-server/test/`, `.github/workflows/ci.yml` |
| Shared tool definitions (one contract, two transports) | ✅ done | `tools.ts` |
| `ctx serve` — HTTP MCP for browser/desktop clients | ✅ done | `serve.ts` |
| `ctx install <client>` — one-command setup | ✅ done | `install.ts` |
| `ctx hook` — model-free auto-capture | ✅ done | `hook.ts` |
| Project-identity normalisation (`MyApp` vs `myapp`) | ✅ done | `lib/slug.ts` `normalizeProject` + `engine.ts` entry points |
| npm publish (install via `npx`, no absolute paths) | ⏳ next | `apps/mcp-server/package.json` |
| Secret redaction before `ctx sync` pushes transcripts | ⏳ next | `sync.ts` |
