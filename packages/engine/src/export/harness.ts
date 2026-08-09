import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * export/harness.ts — write a context packet into the files coding agents
 * already read on their own: CLAUDE.md, AGENTS.md.
 *
 * This is how CtxVault reaches tools that will never speak MCP. But it is also
 * the feature most able to recreate the exact problem CtxVault exists to fix:
 * developers are (rightly) told to keep these files small, because everything in
 * them is loaded into EVERY session whether it's relevant or not. A naive
 * exporter that appended each session's handoff would grow the file forever and
 * poison every future session.
 *
 * So this writer is bounded by construction:
 *   - It owns exactly one marked region and REPLACES it. Never appends.
 *   - The caller passes a compact, budgeted packet (see CtxEngine.exportPacket
 *     with `compact: true`), so the region stays a small current-state card.
 *   - Everything outside the markers is the user's, and is preserved byte for
 *     byte — including a file we never created.
 *
 * The invariant to keep: the vault grows, this file does not.
 */
export const START_MARKER = "<!-- ctxvault:start — auto-generated, edits are overwritten -->";
export const END_MARKER = "<!-- ctxvault:end -->";

export type HarnessTarget = "claude" | "agents";

const FILENAMES: Record<HarnessTarget, string> = {
  claude: "CLAUDE.md",
  agents: "AGENTS.md",
};

export interface HarnessWriteResult {
  path: string;
  action: "created" | "replaced" | "appended";
  bytes: number;
}

/**
 * Replace (or add) the CtxVault region inside `existing`.
 *
 * Pure and exported so the behaviour is testable without touching a disk, and so
 * the "never grows" property can be verified directly: calling this twice with
 * different blocks yields a file of the same shape, not a longer one.
 */
export function upsertSection(
  existing: string,
  block: string,
): { text: string; action: "replaced" | "appended" } {
  const region = `${START_MARKER}\n${block.trim()}\n${END_MARKER}`;

  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER);

  // Both markers present and in order → swap the region in place.
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + END_MARKER.length);
    return { text: `${before}${region}${after}`, action: "replaced" };
  }

  // A half-written region (one marker, or reversed) means a previous write was
  // interrupted or hand-edited. Appending would leave a stray marker that traps
  // the NEXT write too, so drop the orphan and start the region clean.
  const cleaned =
    start !== -1 || end !== -1
      ? existing.split("\n").filter((l) => !l.includes("ctxvault:start") && !l.includes("ctxvault:end")).join("\n")
      : existing;

  const base = cleaned.trimEnd();
  return {
    text: base ? `${base}\n\n${region}\n` : `${region}\n`,
    action: "appended",
  };
}

/**
 * Write the packet into `dir`'s CLAUDE.md or AGENTS.md, creating the file if it
 * doesn't exist. Returns what happened so the caller can tell the user plainly —
 * "replaced" vs "created" matters when we just edited a file they maintain.
 */
export function writeHarnessFile(
  dir: string,
  target: HarnessTarget,
  block: string,
): HarnessWriteResult {
  const path = join(dir, FILENAMES[target]);
  const exists = existsSync(path);
  const existing = exists ? readFileSync(path, "utf8") : "";

  const { text, action } = upsertSection(existing, block);
  writeFileSync(path, text, "utf8");

  return {
    path,
    action: exists ? action : "created",
    bytes: Buffer.byteLength(text, "utf8"),
  };
}
