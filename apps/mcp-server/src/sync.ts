import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * sync.ts — the vault travels over YOUR git remote.
 *
 * "Continue anywhere" usually means someone runs a sync service and holds your
 * memory. It doesn't have to. The vault is already a folder of markdown, and
 * every developer already has a git remote — so `ctx sync` is `git add/commit/
 * pull --rebase/push` against a private repo you own. No account, no server, no
 * one else's disk. The same command gives a team a shared vault, and a laptop +
 * desktop the same memory.
 *
 * WHAT IS NOT SYNCED: `ctxvault.db`. It's a derived index, and a binary file in
 * git is a merge conflict waiting to happen — the exact failure that would make
 * people distrust the tool. Instead the markdown syncs and `importFromFiles()`
 * rebuilds the database on the other side. That's why handoffs became files
 * (okf/handoff.ts) before this feature could exist.
 *
 * Vectors aren't synced either: regenerating them needs an API call, so hybrid
 * users re-embed on their next save. Keyword search is fully restored on arrival.
 */

const VAULT_GITIGNORE = `# CtxVault — the database is a DERIVED INDEX, not the source of truth.
# The markdown below it is. \`ctx reindex\` rebuilds the .db from those files,
# so syncing a binary (and fighting its merge conflicts) buys nothing.
ctxvault.db
ctxvault.db-wal
ctxvault.db-shm
`;

export interface GitResult {
  ok: boolean;
  output: string;
}

/** Run git inside the vault. Never throws — callers decide what a failure means. */
function git(args: string[]): GitResult {
  try {
    const output = execFileSync("git", ["-C", config.home, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: (e.stderr || e.stdout || e.message).trim() };
  }
}

const isRepo = () => existsSync(join(config.home, ".git"));

/** Current branch name, defaulting to main on a fresh repo with no commits. */
function currentBranch(): string {
  const r = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok && r.output && r.output !== "HEAD" ? r.output : "main";
}

/**
 * `ctx sync init <remote>` — turn the vault into a git repo pointed at a remote.
 *
 * Idempotent: re-running it against a different URL just updates the remote,
 * which is what someone moving from a gist to a private repo actually wants.
 */
export function syncInit(remote: string): string[] {
  const log: string[] = [];

  if (!isRepo()) {
    const init = git(["init", "-b", "main"]);
    if (!init.ok) throw new Error(`git init failed: ${init.output}`);
    log.push(`Initialized a git repo at ${config.home}`);
  } else {
    log.push(`${config.home} is already a git repo`);
  }

  // Always (re)write the ignore file: an older vault won't have it, and a vault
  // that starts tracking the .db is the one bad outcome here.
  writeFileSync(join(config.home, ".gitignore"), VAULT_GITIGNORE, "utf8");
  log.push("Wrote .gitignore (the database stays local)");

  const existing = git(["remote", "get-url", "origin"]);
  const remoteCmd = existing.ok
    ? git(["remote", "set-url", "origin", remote])
    : git(["remote", "add", "origin", remote]);
  if (!remoteCmd.ok) throw new Error(`setting remote failed: ${remoteCmd.output}`);
  log.push(`${existing.ok ? "Updated" : "Added"} remote origin → ${remote}`);

  log.push("", "Now run:  ctx sync");
  return log;
}

/**
 * `ctx sync` — commit local changes, rebase on the remote, push, then rebuild
 * the index from whatever markdown arrived.
 *
 * `pull --rebase` rather than merge: the vault's history is a log of saves, and
 * replaying yours on top of a teammate's reads far better than a merge bubble
 * for every sync. Conflicts stay rare because facts are one-file-per-fact and
 * handoffs are append-only — and when one does happen it's a markdown file a
 * human can just open and fix.
 */
export async function syncRun(
  reindexFromFiles: () => Promise<{ facts: number; handoffs: number }>,
): Promise<string[]> {
  if (!isRepo()) {
    throw new Error(
      `${config.home} is not a git repo yet. Run:  ctx sync init <remote-url>`,
    );
  }
  const log: string[] = [];
  const branch = currentBranch();

  git(["add", "-A"]);
  const staged = git(["diff", "--cached", "--quiet"]);
  if (!staged.ok) {
    // Non-zero from `--quiet` means there ARE staged changes.
    const commit = git(["commit", "-m", `ctxvault sync ${new Date().toISOString()}`]);
    if (!commit.ok) throw new Error(`commit failed: ${commit.output}`);
    log.push("Committed local vault changes");
  } else {
    log.push("No local changes to commit");
  }

  const hasRemote = git(["remote", "get-url", "origin"]).ok;
  if (!hasRemote) throw new Error("No 'origin' remote. Run: ctx sync init <remote-url>");

  const pull = git(["pull", "--rebase", "origin", branch]);
  if (pull.ok) {
    log.push(`Pulled and rebased on origin/${branch}`);
  } else if (/couldn't find remote ref|no such ref|not found/i.test(pull.output)) {
    log.push(`origin/${branch} doesn't exist yet — this push creates it`);
  } else {
    // A rebase conflict leaves the repo mid-rebase; say so plainly rather than
    // pushing something half-merged.
    throw new Error(
      `pull --rebase failed:\n${pull.output}\n\n` +
        `Fix the conflicting markdown in ${config.home}, then:\n` +
        `  git -C ${config.home} add -A && git -C ${config.home} rebase --continue && ctx sync`,
    );
  }

  const push = git(["push", "-u", "origin", branch]);
  if (!push.ok) throw new Error(`push failed:\n${push.output}`);
  log.push(`Pushed to origin/${branch}`);

  const { facts, handoffs } = await reindexFromFiles();
  log.push(`Rebuilt the index from files: ${facts} fact(s), ${handoffs} handoff(s)`);

  return log;
}

/** `ctx sync status` — where the vault stands, without changing anything. */
export function syncStatus(): string[] {
  if (!isRepo()) return [`${config.home} is not a git repo. Run: ctx sync init <remote-url>`];
  const remote = git(["remote", "get-url", "origin"]);
  const dirty = git(["status", "--porcelain"]);
  return [
    `Vault:  ${config.home}`,
    `Remote: ${remote.ok ? remote.output : "(none — run ctx sync init <remote-url>)"}`,
    `Branch: ${currentBranch()}`,
    dirty.output
      ? `Uncommitted: ${dirty.output.split("\n").length} file(s) — run ctx sync`
      : "Uncommitted: none",
  ];
}
