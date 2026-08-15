#!/usr/bin/env node
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listProjectDirs, writeHarnessFile, type HarnessTarget } from "@ctxvault/engine";
import { config } from "./config.js";
import { createRuntime } from "./runtime.js";
import { syncInit, syncRun, syncStatus } from "./sync.js";
import { serve, DEFAULT_HOST, DEFAULT_PORT } from "./serve.js";
import { CLIENT_IDS, defaultServeUrl, installAll, installClient } from "./install.js";
import { hookStatus, installHooks, runHook } from "./hook.js";

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

Setup
  ctx install <client|all>               wire CtxVault into an AI tool's config
                                         clients: ${CLIENT_IDS.join(", ")}
  ctx install <client> --http            point it at a running 'ctx serve' instead
  ctx serve [--port N] [--token T]       Streamable HTTP MCP for browser/desktop clients
  ctx hook install                       auto-capture in Claude Code (PreCompact/SessionEnd)
  ctx hook status                        when each project was last auto-captured

Memory
  ctx export [--to text|claude|agents] [--project P] [--session S] [--budget N] [--dir D]
  ctx search <query...> [--project P] [-k N]
  ctx projects                           every project in the vault (canonical names)
  ctx list [--project P]                 durable facts stored for the project
  ctx sessions [--project P]             saved sessions/threads
  ctx reindex                            rebuild the database from the markdown files

Sync
  ctx sync init <remote-url>             put the vault on YOUR private git remote
  ctx sync                               commit · pull --rebase · push · reindex
  ctx sync status                        remote, branch, uncommitted changes

Options
  --project P   defaults to the current directory name ("${basename(process.cwd())}")
  --to          export target. 'text' prints the packet; 'claude'/'agents' write
                a bounded, replaceable block into CLAUDE.md / AGENTS.md
  --dir D       directory for --to claude|agents (default: current directory)
  --port N      'ctx serve' port (default ${DEFAULT_PORT})
  --host H      'ctx serve' bind address (default ${DEFAULT_HOST} — localhost only)
  --token T     require 'Authorization: Bearer T' on the HTTP endpoint

Vault: ${config.home}
`;

interface Args {
  cmd: string;
  rest: string[];
  flags: Record<string, string>;
}

/**
 * Flags that are switches, not key/value pairs.
 *
 * Without this list a switch eats the next argument: `--http --token abc` parsed
 * as `http="--token"` and silently dropped the token, so the install wrote an
 * unauthenticated entry and said nothing. Switches have to be declared.
 */
const BOOLEAN_FLAGS = new Set(["http", "verbose"]);

/** Parse `--key value`, `--key=value`, bare `--switch` and `-k N`. Everything else is positional. */
export function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...tail] = argv;
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        // A switch consumes nothing. So does a value flag at the end of the
        // line, or one followed by another flag — better an empty value than
        // eating the next option.
        const next = tail[i + 1];
        if (BOOLEAN_FLAGS.has(key)) flags[key] = "true";
        else if (next === undefined || next.startsWith("--")) flags[key] = "";
        else flags[key] = tail[++i];
      }
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

const say = (lines: string[]) => process.stdout.write(`${lines.join("\n")}\n`);

async function main() {
  const { cmd, rest, flags } = parseArgs(process.argv.slice(2));

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }

  // --- commands that must NOT open the vault the normal way -----------------
  // `serve` owns the database for its whole lifetime, `hook` opens and closes
  // its own, and `install` only edits config files. Opening a SQLite handle
  // here and closing it at the bottom of main() would be wrong for all three.

  if (cmd === "serve") {
    await serve({
      port: flags.port ? Number(flags.port) : DEFAULT_PORT,
      host: flags.host || DEFAULT_HOST,
      token: flags.token || process.env.CTXVAULT_TOKEN || undefined,
      // stdout stays clean so `ctx serve` can be piped/logged; status goes to stderr.
      log: (msg) => process.stderr.write(`[ctxvault] ${msg}\n`),
    });
    return;
  }

  if (cmd === "install") {
    const target = rest[0];
    if (!target) {
      process.stderr.write(`ctx install <${CLIENT_IDS.join("|")}|all> [--http] [--token T]\n`);
      process.exitCode = 1;
      return;
    }
    const useHttp = "http" in flags;
    const opts = {
      mode: (useHttp ? "http" : "stdio") as "http" | "stdio",
      url: flags.url || defaultServeUrl(),
      token: flags.token || process.env.CTXVAULT_TOKEN || undefined,
    };
    say(target === "all" ? installAll(opts) : installClient(target, opts));
    if (useHttp) {
      say(["", "Remember to start the server: ctx serve" + (opts.token ? ` --token ${opts.token}` : "")]);
    }
    return;
  }

  if (cmd === "hook") {
    const sub = rest[0];
    if (sub === "install") say(installHooks());
    else if (sub === "status") say(hookStatus());
    // Bare `ctx hook` IS the hook: Claude Code runs it with a JSON payload on
    // stdin. Report to stderr — stdout of a hook is surfaced to the user's session.
    else process.stderr.write(`${(await runHook(process.argv.slice(2))).join("\n")}\n`);
    return;
  }

  const { store, engine } = createRuntime((msg) => process.stderr.write(`[ctxvault] ${msg}\n`));
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

    case "projects": {
      // Read the DIRECTORIES, not the database: the folder names are the
      // canonical project keys by construction (normalizeProject === slugify),
      // so this answers "what am I allowed to type" without a query.
      const names = new Set([
        ...listProjectDirs(config.knowledgeDir),
        ...listProjectDirs(config.handoffDir),
      ]);
      if (!names.size) {
        process.stdout.write(`No projects in ${config.home} yet.\n`);
        break;
      }
      process.stdout.write(`Projects in ${config.home}:\n`);
      for (const name of [...names].sort()) {
        const facts = await engine.listFacts(name);
        const sessions = await engine.listSessions(name);
        process.stdout.write(`• ${name} — ${facts.length} fact(s), ${sessions.length} session(s)\n`);
      }
      process.stdout.write(
        `\nUse these names with --project, or when you tell an agent to resume.\n` +
          `Case and punctuation are normalised: "My App", "my-app" and "MY_APP" all\n` +
          `resolve to "my-app". Word breaks are NOT guessed — "myapp" is its own project.\n`,
      );
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

/**
 * Only run when this file IS the program. Without the guard, a test that
 * imports `parseArgs` from here would execute the CLI as a side effect of the
 * import — and under vitest that means running `ctx` with vitest's own argv.
 */
const isEntrypoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
})();

if (isEntrypoint) {
  main().catch((err) => {
    process.stderr.write(`ctx: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
