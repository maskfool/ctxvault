#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { createRuntime } from "./runtime.js";
import { registerTools, SERVER_INFO } from "./tools.js";

/**
 * index.ts — the LOCAL front door: a stdio MCP server.
 *
 * An MCP client (Claude Code, Codex, Cursor, Claude Desktop) launches this
 * process and speaks JSON-RPC over stdin/stdout.
 *
 * The six tools are NOT defined here — they live in tools.ts, which serve.ts
 * (HTTP) registers too. One definition, two transports: a Claude Code process
 * and a browser-side connector get a byte-identical contract, so "the same
 * memory everywhere" can't drift into "almost the same memory everywhere".
 *
 * V2: NO API KEY, NO MODEL, NO PER-CALL COST.
 * The old server called its own LLM to summarize the transcript it was handed.
 * But the agent calling `save_context` has just lived through that session — it
 * already knows the goal, the decisions and what's next. So the tool's input
 * schema IS the handoff form, and the agent fills it in using tokens the user
 * has already paid for. This process only validates, stores, indexes and packs.
 *
 * ⚠️  GOLDEN RULE: never write to STDOUT. The transport owns stdout for the
 * protocol. Every log MUST go to stderr (console.error). One stray console.log
 * corrupts the JSON-RPC stream and the client silently drops the server.
 */

const log = (...args: unknown[]) => console.error("[ctxvault]", ...args);

const { store, engine, searchStatus } = createRuntime((msg) => log(msg));

const server = new McpServer(SERVER_INFO);
// stdio: the client spawned us inside the user's project, so cwd is the right
// default for an export_context file write.
registerTools({ server, engine, log, defaultDir: process.cwd() });

// --- boot ------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`CtxVault MCP server ready. DB: ${config.dbPath}. Search: ${searchStatus}.`);
}

// Close the database on the way out so the WAL is checkpointed rather than left
// for the next process to recover.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void store.close().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
