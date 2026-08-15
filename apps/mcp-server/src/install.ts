import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST, DEFAULT_PORT } from "./serve.js";

/**
 * install.ts — `ctx install <client>`, the adoption wall removed.
 *
 * Before this, setup was: clone, install, build, find the absolute path to
 * dist/index.js, then hand-edit a different config file per client — one of
 * them TOML, one of them keyed "servers" instead of "mcpServers", one of them
 * inside "Application Support". Every step is a place to give up.
 *
 * Two rules make editing someone's config file safe enough to do for them:
 *   1. Back up before the first write (`<file>.ctxvault-backup`).
 *   2. MERGE, never replace. We add or update exactly the "ctxvault" entry and
 *      leave every other server, and every unrelated setting, byte-identical.
 */

/** Where this build's stdio server lives — resolved from the running CLI, so it is right by construction. */
export function serverEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "index.js");
}

export type ClientId = "claude-code" | "claude-desktop" | "cursor" | "codex" | "vscode";

export const CLIENT_IDS: ClientId[] = ["claude-code", "claude-desktop", "cursor", "codex", "vscode"];

export interface InstallOptions {
  /** stdio spawns the server per client; http points every client at one `ctx serve`. */
  mode: "stdio" | "http";
  url: string;
  token?: string;
}

// --- config shapes ----------------------------------------------------------

/** The stdio form every JSON client understands. */
export function stdioEntry(): Record<string, unknown> {
  return { command: process.execPath, args: [serverEntryPath()] };
}

/** The remote form, for clients that can talk to a URL instead of spawning us. */
export function httpEntry(url: string, token?: string): Record<string, unknown> {
  const entry: Record<string, unknown> = { type: "http", url };
  if (token) entry.headers = { Authorization: `Bearer ${token}` };
  return entry;
}

function entryFor(opts: InstallOptions): Record<string, unknown> {
  return opts.mode === "http" ? httpEntry(opts.url, opts.token) : stdioEntry();
}

// --- file helpers -----------------------------------------------------------

function backup(path: string): void {
  const dest = `${path}.ctxvault-backup`;
  if (existsSync(path) && !existsSync(dest)) copyFileSync(path, dest);
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Merge our entry under `key` (mcpServers / servers) and write the file back.
 * Everything else in the document survives — including other MCP servers.
 */
function writeJsonClient(path: string, key: string, entry: Record<string, unknown>): string[] {
  mkdirSync(dirname(path), { recursive: true });
  const doc = readJson(path);
  const servers = (doc[key] as Record<string, unknown> | undefined) ?? {};
  const existed = Object.hasOwn(servers, "ctxvault");
  backup(path);
  doc[key] = { ...servers, ctxvault: entry };
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return [`${existed ? "Updated" : "Added"} "ctxvault" in ${path}`];
}

// --- TOML (Codex) -----------------------------------------------------------

/**
 * Replace the `[mcp_servers.ctxvault]` table — and every subtable under it —
 * with `block`, leaving the rest of the file untouched. Appends if absent.
 *
 * Pure and exported so the merge behaviour is testable without a Codex install:
 * the property that matters is that OTHER tables survive, because this edits a
 * file the user configured by hand.
 */
export function upsertTomlTable(source: string, tableName: string, block: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let skipping = false;
  let replaced = false;

  const isOurs = (header: string) => header === tableName || header.startsWith(`${tableName}.`);

  for (const line of lines) {
    const match = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(line);
    if (match) {
      // A new table header always ends a skip; whether we start a new one
      // depends on if this header is ours.
      skipping = isOurs(match[1]);
      if (skipping && !replaced) {
        out.push(block.trimEnd());
        replaced = true;
      }
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }

  let result = out.join("\n");
  if (!replaced) {
    result = result.trimEnd();
    result = result ? `${result}\n\n${block.trimEnd()}\n` : `${block.trimEnd()}\n`;
  }
  return result.endsWith("\n") ? result : `${result}\n`;
}

/** Serialize our entry as a TOML table. Codex spawns processes; it has no URL form. */
function codexBlock(): string {
  const args = JSON.stringify([serverEntryPath()]);
  return `[mcp_servers.ctxvault]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${args}\n`;
}

// --- the client registry ----------------------------------------------------

interface Client {
  id: ClientId;
  label: string;
  /** Returns the report lines, or throws with a human explanation. */
  install(opts: InstallOptions): string[];
}

const CLIENTS: Record<ClientId, Client> = {
  // Claude Code reads ~/.claude.json; top-level mcpServers apply to every project.
  "claude-code": {
    id: "claude-code",
    label: "Claude Code (CLI + desktop app)",
    install: (opts) =>
      writeJsonClient(join(homedir(), ".claude.json"), "mcpServers", entryFor(opts)).concat(
        "Restart Claude Code, then run /mcp to confirm ctxvault is connected.",
      ),
  },

  "claude-desktop": {
    id: "claude-desktop",
    label: "Claude Desktop",
    install: (opts) => {
      if (opts.mode === "http") {
        // Being honest beats writing a key the app ignores: Desktop takes remote
        // servers through its Connectors UI, not through this file.
        return [
          "Claude Desktop adds remote servers through its UI, not this config file.",
          "  Settings → Connectors → Add custom connector",
          `  URL: ${opts.url}`,
          ...(opts.token ? [`  Header: Authorization: Bearer ${opts.token}`] : []),
        ];
      }
      return writeJsonClient(
        join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        "mcpServers",
        entryFor(opts),
      ).concat("Fully quit Claude Desktop (⌘Q) and reopen it — it only reads this file at launch.");
    },
  },

  cursor: {
    id: "cursor",
    label: "Cursor",
    install: (opts) =>
      writeJsonClient(join(homedir(), ".cursor", "mcp.json"), "mcpServers", entryFor(opts)).concat(
        "Reload Cursor, then check Settings → MCP.",
      ),
  },

  codex: {
    id: "codex",
    label: "Codex CLI",
    install: (opts) => {
      if (opts.mode === "http") {
        throw new Error(
          "Codex launches MCP servers as processes and has no URL form — install it without --http.",
        );
      }
      const path = join(homedir(), ".codex", "config.toml");
      mkdirSync(dirname(path), { recursive: true });
      const source = existsSync(path) ? readFileSync(path, "utf8") : "";
      backup(path);
      writeFileSync(path, upsertTomlTable(source, "mcp_servers.ctxvault", codexBlock()));
      return [`Wrote [mcp_servers.ctxvault] in ${path}`, "Start a new codex session to pick it up."];
    },
  },

  // VS Code keys its MCP config "servers", not "mcpServers" — a one-word
  // difference that silently does nothing if you copy another client's file.
  vscode: {
    id: "vscode",
    label: "VS Code (Copilot MCP)",
    install: (opts) =>
      writeJsonClient(
        join(homedir(), "Library", "Application Support", "Code", "User", "mcp.json"),
        "servers",
        entryFor(opts),
      ).concat("Reload the VS Code window."),
  },
};

/** The default URL an --http install points at, matching `ctx serve`'s defaults. */
export const defaultServeUrl = () => `http://${DEFAULT_HOST}:${DEFAULT_PORT}/mcp`;

export function installClient(id: string, opts: InstallOptions): string[] {
  const client = CLIENTS[id as ClientId];
  if (!client) {
    throw new Error(`Unknown client "${id}". Try one of: ${CLIENT_IDS.join(", ")}`);
  }
  return [`${client.label} — ${opts.mode === "http" ? `remote ${opts.url}` : "stdio"}`, ...client.install(opts)];
}

/** `ctx install all` — every client, skipping the ones that don't apply. */
export function installAll(opts: InstallOptions): string[] {
  const lines: string[] = [];
  for (const id of CLIENT_IDS) {
    try {
      lines.push(...installClient(id, opts), "");
    } catch (err) {
      lines.push(`${id}: skipped — ${(err as Error).message}`, "");
    }
  }
  return lines;
}
