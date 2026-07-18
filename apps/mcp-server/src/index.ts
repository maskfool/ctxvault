#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CtxEngine,
  SqliteAdapter,
  VercelLLM,
  VercelEmbedder,
  LocalEmbedder,
  languageModelRef,
  embeddingModelRef,
  hasApiKey,
  parseModelRef,
  type LLM,
  type Embedder,
} from "@ctxvault/engine";
import { z } from "zod";
import { config } from "./config.js";

/**
 * index.ts — the LOCAL front door: a stdio MCP server.
 *
 * An MCP client (Claude Code, Codex) launches this process and speaks JSON-RPC
 * over stdin/stdout. We register three tools that map straight onto the engine.
 *
 * ⚠️  GOLDEN RULE: never write to STDOUT. The transport owns stdout for the
 * protocol. Every log MUST go to stderr (console.error). One stray console.log
 * corrupts the JSON-RPC stream and the client silently drops the server.
 */

const log = (...args: unknown[]) => console.error("[ctxvault]", ...args);

// One engine, backed by the durable SQLite adapter.
// The LLM is optional: with a key we summarize into HandoffNotes; with --no-ai
// (or no key) we degrade to raw storage so a judge never sees a dead button.
//
// WHICH model is not decided here — CTXVAULT_MODEL / CTXVAULT_EMBED_MODEL pick
// the provider (Anthropic, OpenAI, OpenRouter, or any OpenAI-compatible server)
// and the AI SDK does the rest. All this file decides is on-vs-off.
const noAi = process.argv.includes("--no-ai") || process.env.CTXVAULT_NO_AI === "1";
const modelRef = languageModelRef();
const embedRef = embeddingModelRef();

// Why the LLM is off matters: "no key" and "you typo'd CTXVAULT_MODEL" need
// different fixes, and stdout is unavailable to say so — this is the one status
// line the user sees.
let aiStatus: string;
const llm: LLM | null = buildLlm();

function buildLlm(): LLM | null {
  if (noAi) {
    aiStatus = "off (--no-ai)";
    return null;
  }
  try {
    parseModelRef(modelRef);
  } catch (err) {
    aiStatus = `off (bad CTXVAULT_MODEL: ${(err as Error).message})`;
    return null;
  }
  if (!hasApiKey(modelRef)) {
    aiStatus = `off (no API key for ${modelRef})`;
    return null;
  }
  aiStatus = `on (${modelRef})`;
  return new VercelLLM({ ref: modelRef });
}

// Search always works: real embeddings when the configured provider has a key,
// otherwise the local hashing fallback (lexical, no key, no network). --no-ai
// forces local. A bad embed ref (e.g. anthropic:, which has no embeddings API)
// must not take the server down — fall back and say so.
const embedder: Embedder = buildEmbedder();

function buildEmbedder(): Embedder {
  if (noAi || !hasApiKey(embedRef)) return new LocalEmbedder();
  try {
    return new VercelEmbedder({ ref: embedRef });
  } catch (err) {
    log(`embedder ${embedRef} unavailable (${(err as Error).message}); using local fallback`);
    return new LocalEmbedder();
  }
}

// knowledgeDir on → facts are written as human-readable OKF markdown files.
const store = new SqliteAdapter(config.dbPath, { knowledgeDir: config.knowledgeDir });
const engine = new CtxEngine(store, llm, embedder);

const server = new McpServer({
  name: "ctxvault",
  version: "0.1.0",
});

// --- save_context ----------------------------------------------------------
// Descriptions are written as PROMPTS: they tell the model WHEN to reach for the
// tool, in the model's own decision-making language.
server.registerTool(
  "save_context",
  {
    title: "Save working context",
    description:
      "Save the current working context to CtxVault so you (or another AI tool " +
      "like Codex or Gemini) can resume it later. Call this when you are about to " +
      "hit a usage limit, when the user says they are switching to another AI tool, " +
      "or at a natural stopping point in a task. Pass the recent conversation/work " +
      "as the transcript.",
    inputSchema: {
      project: z
        .string()
        .describe("Short project identifier, e.g. 'ctxvault' or 'case-smith-v-jones'."),
      transcript: z
        .string()
        .describe("The recent working context to preserve: what was done, decided, and what's next."),
      session: z
        .string()
        .optional()
        .describe("Optional session/thread name. Defaults to 'main'."),
    },
  },
  async ({ project, transcript, session }) => {
    const result = await engine.save({
      project,
      session: session ?? "main",
      transcript,
    });
    log(
      `saved snapshot ${result.snapshotId} (${result.savedChars} chars, mode=${result.mode}) for "${project}"` +
        (result.warning ? ` — ${result.warning}` : ""),
    );
    const modeLine =
      result.mode === "intelligent"
        ? `Summarized into a HandoffNote + ${result.factsExtracted} durable OKF fact(s).`
        : `Stored as raw text${result.warning ? "" : " (--no-ai mode)"}.`;
    return {
      content: [
        {
          type: "text",
          text:
            `✅ Saved context for project "${project}" (session "${result.session}").\n` +
            `Snapshot ${result.snapshotId}, ${result.savedChars} chars. ${modeLine}\n` +
            (result.warning ? `⚠️  ${result.warning}\n` : "") +
            `Open another AI tool and call resume_context with project "${project}" to continue.`,
        },
      ],
    };
  },
);

// --- resume_context --------------------------------------------------------
server.registerTool(
  "resume_context",
  {
    title: "Resume working context",
    description:
      "Restore the working context for a project that was saved by CtxVault in a " +
      "previous session or a different AI tool. Call this at the START of a session " +
      "when the user says 'resume', 'pick up where I left off', or references earlier " +
      "work in another tool. Returns a packed context you should read and continue from.",
    inputSchema: {
      project: z.string().describe("The project identifier to resume."),
      budget: z
        .number()
        .optional()
        .describe("Approximate token budget for the restored context. Default 4000."),
      session: z
        .string()
        .optional()
        .describe(
          "Resume a specific session/thread (see list_sessions). Defaults to the most recently saved one.",
        ),
    },
  },
  async ({ project, budget, session }) => {
    const result = await engine.resume({ project, budget, session });
    log(`resume "${project}" → found=${result.found}, ~${result.estimatedTokens} tokens`);
    return {
      content: [{ type: "text", text: result.packed }],
    };
  },
);

// --- list_sessions ---------------------------------------------------------
server.registerTool(
  "list_sessions",
  {
    title: "List saved sessions",
    description:
      "List the saved sessions for a project so the user can see what context " +
      "CtxVault is holding. Useful before resuming.",
    inputSchema: {
      project: z.string().describe("The project identifier."),
    },
  },
  async ({ project }) => {
    const sessions = await engine.listSessions(project);
    if (sessions.length === 0) {
      return { content: [{ type: "text", text: `No saved sessions for "${project}".` }] };
    }
    const lines = sessions.map(
      (s) => `• ${s.session} — ${s.snapshotCount} snapshot(s), last saved ${s.updatedAt}`,
    );
    return {
      content: [{ type: "text", text: `Sessions for "${project}":\n${lines.join("\n")}` }],
    };
  },
);

// --- search_memory ---------------------------------------------------------
server.registerTool(
  "search_memory",
  {
    title: "Search saved memory",
    description:
      "Semantically search everything CtxVault has saved for a project — past " +
      "handoff notes and decisions. Call this when the user asks 'what did we " +
      "decide about X', 'have I worked on Y before', or wants to recall an earlier " +
      "choice. Matches on meaning, not just keywords.",
    inputSchema: {
      project: z.string().describe("The project identifier to search within."),
      query: z.string().describe("What to look for, in natural language."),
      k: z
        .number()
        .optional()
        .describe("How many results to return. Default 5."),
    },
  },
  async ({ project, query, k }) => {
    const hits = await engine.search(project, query, k ?? 5);
    log(`search "${project}" q="${query}" → ${hits.length} hit(s)`);
    if (hits.length === 0) {
      return {
        content: [
          { type: "text", text: `No memory matched "${query}" in project "${project}".` },
        ],
      };
    }
    const blocks = hits.map((h, i) => {
      const when = h.createdAt ? ` (saved ${h.createdAt})` : "";
      return `### Result ${i + 1} — score ${h.score.toFixed(3)}, similarity ${h.similarity.toFixed(3)}${when}\n${h.text}`;
    });
    return { content: [{ type: "text", text: blocks.join("\n\n") }] };
  },
);

// --- list_facts ------------------------------------------------------------
server.registerTool(
  "list_facts",
  {
    title: "List durable knowledge facts",
    description:
      "List the durable knowledge CtxVault has stored for a project — the OKF " +
      "facts (decisions, conventions, gotchas) that persist across sessions. " +
      "Useful to see what the project 'knows' before starting work.",
    inputSchema: {
      project: z.string().describe("The project identifier."),
    },
  },
  async ({ project }) => {
    const facts = await engine.listFacts(project);
    if (facts.length === 0) {
      return { content: [{ type: "text", text: `No facts stored for "${project}" yet.` }] };
    }
    const lines = facts.map((f) => {
      const where = f.filePath ? ` — ${f.filePath}` : "";
      return `• [${f.type}] ${f.title} (${f.slug})${where}\n  ${f.body.replace(/\n/g, " ").slice(0, 140)}`;
    });
    return {
      content: [
        { type: "text", text: `Knowledge for "${project}" (${facts.length}):\n${lines.join("\n")}` },
      ],
    };
  },
);

// --- boot ------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(
    `CtxVault MCP server ready. DB: ${config.dbPath}. ` +
      `AI: ${aiStatus}. ` +
      `Embeddings: ${embedder.id}.`,
  );
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
