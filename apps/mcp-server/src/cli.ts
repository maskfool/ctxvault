#!/usr/bin/env node
import { basename } from "node:path";
import {
  CtxEngine,
  SqliteAdapter,
  VercelEmbedder,
  canEmbed,
  embeddingModelRef,
  writeHarnessFile,
  type Embedder,
  type HarnessTarget,
} from "@ctxvault/engine";
import { config } from "./config.js";
import { syncInit, syncRun, syncStatus } from "./sync.js";

/**
 * cli.ts — CtxVault without an agent.
 *
 * The MCP server is how agents talk to the vault; this is how the HUMAN does.
 * It matters more than it looks: it's what lets someone paste their context into
 * a tool that will never support MCP (claude.ai, ChatGPT, Gemini), check what
 * the vault actually holds, and repair the index — all from a terminal, with no
 * API key and no running server.
 *
 * Reuses the engine directly; no duplicated logic, just a different front door.
 */

const HELP = `ctx — CtxVault CLI

Usage
  ctx export [--to text|claude|agents] [--project P] [--session S] [--budget N] [--dir D]
  ctx search <query...> [--project P] [-k N]
  ctx list [--project P]                 durable facts stored for the project
  ctx sessions [--project P]             saved sessions/threads
  ctx reindex                            rebuild the database from the markdown files

  ctx sync init <remote-url>             put the vault on YOUR private git remote
  ctx sync                               commit · pull --rebase · push · reindex
  ctx sync status                        remote, branch, uncommitted changes

Options
  --project P   defaults to the current directory name ("${basename(process.cwd())}")
  --to          export target. 'text' prints the packet; 'claude'/'agents' write
                a bounded, replaceable block into CLAUDE.md / AGENTS.md
  --dir D       directory for --to claude|agents (default: current directory)

Vault: ${config.home}
`;

interface Args {
  cmd: string;
  rest: string[];
  flags: Record<string, string>;
}

/** Parse `--key value`, `--key=value` and `-k N`. Everything else is positional. */
function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...tail] = argv;
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = tail[++i] ?? "";
    } else if (a === "-k") {
      flags.k = tail[++i] ?? "";
    } else {
      rest.push(a);
    }
  }
  return { cmd, rest, flags };
}

/**
 * Default the project to the current folder name. This is the same convention an
 * agent naturally uses ("the repo I'm in"), which is what makes `ctx export` in a
 * project directory Just Work without the user remembering what they called it.
 */
const projectFrom = (flags: Record<string, string>) => flags.project || basename(process.cwd());

function buildEmbedder(): Embedder | null {
  const ref = embeddingModelRef();
  if (!canEmbed(ref)) return null;
  try {
    return new VercelEmbedder({ ref });
  } catch {
    return null; // keyword search still works; never block the CLI on this
  }
}

async function main() {
  const { cmd, rest, flags } = parseArgs(process.argv.slice(2));

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }

  const store = new SqliteAdapter(config.dbPath, {
    knowledgeDir: config.knowledgeDir,
    handoffDir: config.handoffDir,
  });
  const engine = new CtxEngine(store, buildEmbedder());
  const project = projectFrom(flags);

  switch (cmd) {
    case "export": {
      const to = (flags.to ?? "text") as "text" | HarnessTarget;
      const toFile = to === "claude" || to === "agents";
      const result = await engine.exportPacket({
        project,
        session: flags.session,
        budget: flags.budget ? Number(flags.budget) : toFile ? 600 : 4000,
        compact: toFile,
      });

      if (!result.found) {
        process.stderr.write(`${result.packed}\n`);
        process.exitCode = 1;
        break;
      }

      if (!toFile) {
        // Straight to stdout so it pipes: `ctx export | pbcopy`.
        process.stdout.write(result.packed + "\n");
        process.stderr.write(`\n[~${result.estimatedTokens} tokens]\n`);
        break;
      }

      const written = writeHarnessFile(flags.dir ?? process.cwd(), to, result.packed);
      process.stdout.write(
        `${written.action === "created" ? "Created" : "Updated"} ${written.path} ` +
          `(~${result.estimatedTokens} tokens). The CtxVault block is replaced on every export.\n`,
      );
      break;
    }

    case "search": {
      const query = rest.join(" ");
      if (!query) {
        process.stderr.write("ctx search <query>\n");
        process.exitCode = 1;
        break;
      }
      const hits = await engine.search(project, query, flags.k ? Number(flags.k) : 5);
      if (!hits.length) {
        process.stdout.write(`No memory matched "${query}" in "${project}".\n`);
        break;
      }
      for (const [i, h] of hits.entries()) {
        const where = h.filePath ? ` · ${h.filePath}` : "";
        process.stdout.write(
          `\n${i + 1}. [${h.kind}] score ${h.score.toFixed(3)}${where}\n` +
            `${h.text.replace(/\n/g, "\n   ").slice(0, 400)}\n`,
        );
      }
      break;
    }

    case "list": {
      const facts = await engine.listFacts(project);
      if (!facts.length) {
        process.stdout.write(`No facts stored for "${project}".\n`);
        break;
      }
      process.stdout.write(`Knowledge for "${project}" (${facts.length}):\n`);
      for (const f of facts) {
        process.stdout.write(`• [${f.type}] ${f.title} (${f.slug})${f.filePath ? ` — ${f.filePath}` : ""}\n`);
      }
      break;
    }

    case "sessions": {
      const sessions = await engine.listSessions(project);
      if (!sessions.length) {
        process.stdout.write(`No saved sessions for "${project}".\n`);
        break;
      }
      for (const s of sessions) {
        process.stdout.write(`• ${s.session} — ${s.snapshotCount} snapshot(s), last ${s.updatedAt}\n`);
      }
      break;
    }

    case "reindex": {
      // Files first, then the FTS mirror: the markdown is the truth, so a
      // reindex that only rebuilt the mirror would faithfully preserve whatever
      // the database had already lost.
      const { facts, handoffs } = await store.importFromFiles();
      const n = store.reindex();
      process.stdout.write(
        `Rebuilt from ${config.home}: ${facts} fact(s), ${handoffs} handoff(s); ` +
          `${n} document(s) indexed.\n`,
      );
      break;
    }

    case "sync": {
      const sub = rest[0];
      if (sub === "init") {
        const remote = rest[1];
        if (!remote) {
          process.stderr.write("ctx sync init <remote-url>\n");
          process.exitCode = 1;
          break;
        }
        process.stdout.write(syncInit(remote).join("\n") + "\n");
      } else if (sub === "status") {
        process.stdout.write(syncStatus().join("\n") + "\n");
      } else {
        const lines = await syncRun(async () => {
          const counts = await store.importFromFiles();
          store.reindex();
          return counts;
        });
        process.stdout.write(lines.join("\n") + "\n");
      }
      break;
    }

    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exitCode = 1;
  }

  await store.close();
}

main().catch((err) => {
  process.stderr.write(`ctx: ${(err as Error).message}\n`);
  process.exit(1);
});
