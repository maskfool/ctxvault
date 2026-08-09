# The Playground (Phase 3) — what it does, why, and how to deploy

The playground is the **second front door** — the hosted prototype judges can poke
without installing anything. Same memory engine as the local MCP server; only the
transport (HTTP + in-memory store) differs. The whole demo is visual: **watch the
Vault fill with a readable HandoffNote and OKF facts as you save.**

## What a visitor does

1. Land on the page — **Tool A** already has a seeded planning session.
2. Hit **💾 Save context** → a HandoffNote and durable facts are written into the
   middle **Vault** panel, live.
3. Hit **🔁 Resume in Tool B** → the packed context is injected into the other
   pane, which greets with *"picking up where you left off: &lt;next step&gt;."*
4. **🔍 Search memory** for a decision — BM25 across everything saved, upgraded to
   hybrid if the deployment has an embedding key.

## The files

```
apps/playground/
├── app/
│   ├── page.tsx          # the three-pane client UI (chat A · Vault · chat B)
│   ├── layout.tsx        # root layout + metadata
│   ├── globals.css       # the dark theme
│   └── api/
│       ├── chat/route.ts   # POST — free-form chat with a persona (+ demo fallback)
│       ├── save/route.ts   # POST — distill (the fake agent) then engine.save
│       ├── resume/route.ts # POST — engine.resume (the packer)
│       ├── search/route.ts # POST — engine.search (semantic)
│       ├── vault/route.ts  # GET  — current note + facts + sessions (Vault state)
│       └── reset/route.ts  # POST — wipe this session's vault
└── lib/
    ├── session.ts        # per-session engine registry (globalThis) ⭐
    ├── personas.ts       # Tool A / Tool B system prompts
    ├── chat.ts           # pane chat + keyless demo reply
    ├── distill.ts        # the playground PLAYING an agent — writes the handoff ⭐
    └── seed.ts           # the pre-filled Tool A conversation
```

### `lib/distill.ts` — the one file that doesn't exist in the product ⭐

In real use nothing like this runs on our side: Claude Code (or Codex, or Cursor)
fills in the `save_context` schema itself, because it already has the session in
its context window. That's the whole v2 point — CtxVault ships no summarizer.

The playground has no such agent. The panes are a simulation, so *something* has to
do the agent's job of turning a conversation into a handoff. That job lives here,
in the playground, deliberately **outside `@ctxvault/engine`** — so nobody reading
the engine mistakes it for a dependency the product has.

This is also the only thing the playground's API key is for. Save, resume, search
and export all run keyless here exactly as they do on your machine; without a key,
`distill` falls back to a mechanical handoff built from the messages and the UI
says so.

### `lib/session.ts` — the crux of the hosted design ⭐
- Imports the engine from **`@ctxvault/engine/web`**, a barrel that excludes
  `SqliteAdapter` (native `better-sqlite3`) and the OKF file writer. Those don't
  belong in a serverless bundle. So the playground runs the *same* `CtxEngine`
  with a **`MemoryAdapter`** — one engine, two front doors.
- Keeps a registry of engines **keyed by a session cookie**, so each visitor has
  their own isolated vault. Vercel is stateless, so we say so on the page.
- The registry lives on **`globalThis`**, not module scope. Next.js can hand each
  API route its own copy of a module — a plain `const map = new Map()` would not
  be shared between `/api/save` and `/api/resume`, and a save would vanish on
  resume. `globalThis` is one-per-process, so all routes in a warm instance share
  it. (This was a real bug caught in the browser and fixed.)

### `app/page.tsx` — the UI
A single client component. It never imports the engine (that's server-only) — it
only `fetch`es the API routes. It tracks two message lists, the active pane, and the
resumed context per pane; the "active tool" is highlighted to reinforce the
switching-tools story.

## Guardrails (from the plan)
- **Keys stay server-side** — only the API routes touch them; the client never sees a key.
- **Rate limited** per session (40 req/min) in `session.ts`.
- **Input caps** — transcript ≤ 40k chars, chat messages ≤ 8k each.
- **Keyless fallback** — no key for the configured provider ⇒ chat returns a
  clearly labelled canned reply and `distill` builds the handoff mechanically. The
  vault itself never degrades. Never a dead button. Set a **~$5 budget cap** on the
  key you use.

## Run it locally

```bash
cd ctxvault
npm install          # builds the engine automatically (its `prepare` script)
npm run playground   # → http://localhost:3111
```

Add `apps/playground/.env.local` with a `CTXVAULT_MODEL` and the matching key to
make the two panes behave like real agents, and optionally `CTXVAULT_EMBED_MODEL` +
its key for hybrid search. See `.env.example` for every supported provider. Without
them it runs in demo mode — still fully clickable, and the vault behaves identically.

The header badges report the model actually in use and whether search is keyword or
hybrid, so a misconfigured deployment is visible at a glance.

## Deploy to Vercel

The engine builds itself on install via its `prepare` script, so a stock Vercel
Next.js deploy works with these settings:

- **Root Directory:** `ctxvault/apps/playground` (the Next app). Enable *"Include
  source files outside the Root Directory"* so the workspace + engine come along.
- **Install Command:** `npm install` (run at the monorepo root; triggers the
  engine's `prepare` build).
- **Framework preset:** Next.js (auto-detected).
- **Environment variables (all optional):** `CTXVAULT_MODEL` (only powers the
  simulated agents), `CTXVAULT_EMBED_MODEL` (hybrid search), and the key for
  whichever provider you picked — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
  `OPENROUTER_API_KEY`.

Then — the plan's number-one silent killer — **open the deployed URL on your phone
over mobile data** to confirm it's actually public, not just working on your wifi.

## Quiz yourself

1. **Why does the playground import `@ctxvault/engine/web` instead of
   `@ctxvault/engine`?**
2. **Why is the engine registry on `globalThis` and not a module-level `const`?**
3. **Why does `page.tsx` never import the engine directly?**
4. **What makes this "the same engine" as the local MCP server, concretely?**

<details><summary>Answers</summary>

1. The main barrel pulls in `better-sqlite3` (a native binary) and the OKF file
   writer (`node:fs`), neither of which belongs in a Vercel serverless function.
   `/web` exports only the portable pieces (engine + MemoryAdapter + embedders).
2. Next.js may give each API route its own module instance, so a module-level Map
   wouldn't be shared across routes — a save in one route would be invisible to
   resume in another. `globalThis` is shared per process.
3. It's a client component; importing server-only code (with keys and Node APIs)
   into the client would leak secrets and break the build. It talks to the engine
   only through the API routes.
4. Byte-for-byte the same `CtxEngine` class — indexer, retriever, packer, exporter
   and fact logic — runs in both. Only the injected `StorageAdapter` differs
   (`MemoryAdapter` here vs `SqliteAdapter` locally). The interface is the seam.
   `distill.ts` is the one piece that is playground-only, and that's precisely
   because in the real product the *user's own agent* fills that role.

</details>
