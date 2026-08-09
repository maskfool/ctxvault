# AGENTS.md — working agreement for AI coding agents

Read `SPEC.md` first. Then:

1. **One phase at a time**, and only the phase named in the prompt. Do not build ahead.
2. **Never log to stdout in `apps/mcp-server`.** stdio MCP uses stdout for JSON-RPC. Use `console.error` (stderr) only.
3. After each milestone: **walk the human through the code function by function, then ask 3 quiz questions.** The human writes the commit message.
4. Bad generation → `git checkout .`, tighter re-prompt. Never spend >20 min debugging spaghetti.
5. Anything a model produced — tool arguments, fact slugs — goes through zod before it is stored, and through `slugify()` before it becomes a filename. Never trust it raw.
6. Keep the engine transport-agnostic: it depends only on the `StorageAdapter` interface, never on SQLite or HTTP directly.
7. **The engine imports no model SDK on the save/resume path.** The calling agent writes the handoff; we validate, store, index and pack. If you find yourself adding an LLM call there, you are undoing v2 — see `docs/HANDOFF.md`.
8. Keyword search must always work: no key, no network, no model download. An embedder is an optional upgrade, never a requirement.

## Layout
- `packages/engine` — all memory logic + storage adapters. No transport code.
- `apps/mcp-server` — thin stdio MCP wrapper around the engine (local, SQLite adapter) + the `ctx` CLI.
- `apps/playground` — Next.js on Vercel (in-memory adapter). `lib/distill.ts` there simulates the calling agent; it must never move into the engine.
- `docs/` — teaching notes: what each file does and why.
