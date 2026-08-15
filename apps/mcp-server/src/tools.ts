import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CtxEngine } from "@ctxvault/engine";
import { slugify, writeHarnessFile, type HarnessTarget } from "@ctxvault/engine";
import { z } from "zod";
import { HandoffInput, FactInput } from "./schema.js";

/**
 * tools.ts — the six MCP tools, registered onto ANY server.
 *
 * The tool definitions (especially every `.describe()`) are prompt engineering:
 * they are the only instructions a calling agent ever gets. stdio (index.ts)
 * and HTTP (serve.ts) both register THESE, so a Claude Code process and a
 * browser connector talk to the exact same vault with the exact same contract —
 * one definition, two transports, zero drift.
 */

/** Identity both transports advertise, so a client sees one server, not two. */
export const SERVER_INFO = { name: "ctxvault", version: "0.3.0" } as const;

export interface ToolDeps {
  server: McpServer;
  engine: CtxEngine;
  log: (...args: unknown[]) => void;
  /**
   * Where `export_context` writes CLAUDE.md/AGENTS.md when the caller gives no
   * `dir`. Over stdio the client launched us inside the user's project, so
   * `process.cwd()` is right. Over HTTP it is the SERVER's directory and has
   * nothing to do with the caller — so serve.ts passes null and the tool asks
   * for an explicit path instead of writing a file somewhere surprising.
   */
  defaultDir: string | null;
}

export function registerTools({ server, engine, log, defaultDir }: ToolDeps): void {
  // --- save_context ----------------------------------------------------------
  // The description is a PROMPT. It has two jobs: say WHEN to reach for the tool,
  // and make clear that the CALLER writes the summary — that's the v2 contract.
  server.registerTool(
    "save_context",
    {
      title: "Save working context",
      description:
        "Save the current working context to CtxVault so you — or another AI tool " +
        "like Codex, Cursor or Gemini — can resume it later. Call this when you are " +
        "about to hit a usage limit, when the user says they are switching tools or " +
        "wrapping up, or at a natural stopping point in a task.\n\n" +
        "YOU write the handoff: you have this session in your context, so distill it " +
        "yourself from what actually happened — do not guess or pad. Also extract any " +
        "durable knowledge worth keeping long after this session (decisions and why " +
        "they won, conventions, gotchas) as `facts`; each becomes a markdown file the " +
        "user can read, edit and commit. Extract 0-5 facts — only genuinely reusable " +
        "ones, not a summary of the session.",
      inputSchema: {
        project: z
          .string()
          .describe("Short project identifier, e.g. 'ctxvault'. Use the repo/folder name so other tools resolve the same vault."),
        handoff: HandoffInput.describe(
          "The structured handoff: everything the next tool needs to continue this work.",
        ),
        facts: z
          .array(FactInput)
          .optional()
          .describe("Durable knowledge from this session. Omit or leave empty if nothing is worth keeping."),
        transcript: z
          .string()
          .optional()
          .describe(
            "Optional verbatim tail of the conversation, kept as backup detail behind the handoff. " +
              "A few thousand characters at most — the handoff is the primary record.",
          ),
        session: z
          .string()
          .optional()
          .describe("Optional session/thread name, for keeping parallel lines of work apart. Defaults to 'main'."),
      },
    },
    async ({ project, handoff, facts, transcript, session }) => {
      // The slug becomes a filename, and it arrived from a model — slugify it
      // ourselves rather than trusting it.
      const cleanFacts = (facts ?? []).map((f) => ({
        ...f,
        slug: slugify(f.slug || f.title),
        tags: f.tags ?? [],
      }));

      const result = await engine.save({
        project,
        session: session ?? "main",
        handoff,
        facts: cleanFacts,
        transcript,
      });

      log(
        `saved snapshot ${result.snapshotId} (mode=${result.mode}, ${result.factsExtracted} fact(s)) for "${project}"` +
          (result.warning ? ` — ${result.warning}` : ""),
      );
      return {
        content: [
          {
            type: "text",
            text:
              `✅ Saved context for project "${project}" (session "${result.session}").\n` +
              `Handoff stored + ${result.factsExtracted} durable fact(s) written as OKF markdown.\n` +
              (result.warning ? `⚠️  ${result.warning}\n` : "") +
              `Open another AI tool and call resume_context with project "${project}" to continue, ` +
              `or use export_context to paste this into a tool that doesn't have CtxVault.`,
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
        "work done elsewhere. Returns a packed context — read it and continue from it. " +
        "The vault holds every past session, but this returns only the relevant slice " +
        "within a token budget, so it is safe to call at the top of any session.",
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

  // --- export_context --------------------------------------------------------
  server.registerTool(
    "export_context",
    {
      title: "Export context for another tool",
      description:
        "Export the saved context as a self-contained markdown packet for a tool that " +
        "does NOT have CtxVault installed — claude.ai, ChatGPT, Gemini, a fresh Cursor " +
        "chat. Call this when the user says they want to continue somewhere else, wants " +
        "something to paste, or asks to write the context into their project files.\n\n" +
        "With target 'claude' or 'agents' it writes a compact, size-bounded block into " +
        "CLAUDE.md / AGENTS.md instead of returning text. That block is REPLACED on every " +
        "export and everything outside it is preserved, so those files never grow — " +
        "durable knowledge stays in the vault, not in an always-loaded file.",
      inputSchema: {
        project: z.string().describe("The project identifier to export."),
        target: z
          .enum(["text", "claude", "agents"])
          .optional()
          .describe(
            "'text' (default) returns the packet to paste. 'claude' writes CLAUDE.md, 'agents' writes AGENTS.md.",
          ),
        dir: z
          .string()
          .optional()
          .describe("Directory for the CLAUDE.md/AGENTS.md write. Defaults to the current working directory."),
        budget: z
          .number()
          .optional()
          .describe("Approximate token budget. Default 4000 for text, 600 for a file target."),
        session: z.string().optional().describe("Export a specific session. Defaults to the newest."),
      },
    },
    async ({ project, target, dir, budget, session }) => {
      const mode = target ?? "text";
      const toFile = mode === "claude" || mode === "agents";

      // A file target must stay small: it is re-read in EVERY future session.
      const result = await engine.exportPacket({
        project,
        session,
        budget: budget ?? (toFile ? 600 : 4000),
        compact: toFile,
      });

      if (!result.found) {
        return { content: [{ type: "text", text: result.packed }] };
      }

      if (!toFile) {
        log(`export "${project}" → ~${result.estimatedTokens} tokens of text`);
        return { content: [{ type: "text", text: result.packed }] };
      }

      const outDir = dir ?? defaultDir;
      if (!outDir) {
        // HTTP transport: we have no idea which project directory the caller is
        // sitting in. Writing to the server's cwd would put the block in the
        // wrong repo — asking is the only honest answer.
        return {
          content: [
            {
              type: "text",
              text:
                `This CtxVault server is running over HTTP, so it cannot tell which directory ` +
                `you are working in. Re-call export_context with an absolute \`dir\` (the project ` +
                `root), or use target 'text' and paste the packet yourself.`,
            },
          ],
        };
      }

      const written = writeHarnessFile(outDir, mode as HarnessTarget, result.packed);
      log(`export "${project}" → ${written.action} ${written.path}`);
      return {
        content: [
          {
            type: "text",
            text:
              `✅ ${written.action === "created" ? "Created" : "Updated"} ${written.path} ` +
              `(~${result.estimatedTokens} tokens in the CtxVault block).\n` +
              `The block is replaced on every export, so this file will not grow. ` +
              `Any other AI tool that reads it will now start with this context.`,
          },
        ],
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
        "Search everything CtxVault has saved for a project — every past handoff and " +
        "every durable fact, however old. Call this when the user asks 'what did we " +
        "decide about X', 'have I worked on Y before', or wants to recall an earlier " +
        "choice. Searching is free and costs no extra context: the whole history is " +
        "scanned in the vault and only the top matches come back.\n\n" +
        "If nothing relevant comes back, retry once with different keywords — the " +
        "index matches terms, so the words in the stored note matter.",
      inputSchema: {
        project: z.string().describe("The project identifier to search within."),
        query: z.string().describe("What to look for. Include the distinctive technical terms you expect to appear."),
        k: z.number().optional().describe("How many results to return. Default 5."),
      },
    },
    async ({ project, query, k }) => {
      const hits = await engine.search(project, query, k ?? 5);
      log(`search "${project}" q="${query}" → ${hits.length} hit(s)`);
      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `No memory matched "${query}" in project "${project}". ` +
                `Try different keywords, or call list_facts to see what is stored.`,
            },
          ],
        };
      }
      const blocks = hits.map((h, i) => {
        const when = h.createdAt ? ` · saved ${h.createdAt}` : "";
        const where = h.filePath ? ` · ${h.filePath}` : "";
        return `### Result ${i + 1} — ${h.kind}, score ${h.score.toFixed(3)}${when}${where}\n${h.text}`;
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
}
