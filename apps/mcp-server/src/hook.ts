import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { createRuntime } from "./runtime.js";

/**
 * hook.ts — auto-capture, so the flagship scenario actually works.
 *
 * THE HOLE THIS FILLS. The pitch is "you hit your usage limit, open another
 * tool, type resume". But `save_context` needs the agent to have a turn left to
 * write the handoff — and the moment you most need the save is exactly the
 * moment it can no longer produce one. Demo works, real life doesn't.
 *
 * So the vault stops depending on the agent's cooperation. Claude Code fires
 * PreCompact before it discards context and SessionEnd when a session closes;
 * this command runs on both and writes a raw snapshot of the transcript tail.
 *
 * MODEL-FREE, by rule (AGENTS.md 7). It summarizes nothing — it slices the tail
 * of a JSONL file and stores it. No key, no network, no per-call cost, and it
 * cannot fail because a provider is down.
 *
 * Two tiers, not one: the agent-authored handoff stays the good record, and
 * this is the floor under it. Which is why `decideCapture` exists — an
 * automatic raw snapshot must never become "newest" and shadow a curated
 * handoff the agent wrote minutes earlier.
 */

/** The JSON Claude Code writes to our stdin. Extra fields vary by event; we ignore them. */
export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  trigger?: string;
  reason?: string;
}

/** Auto-captures land in their own session, never mixed into the agent's threads. */
export const AUTO_SESSION = "auto";

const STATE_PATH = join(config.home, ".hook-state.json");

/** Don't write a snapshot more than once per this window, per project. */
export const DEFAULT_THROTTLE_MS = 5 * 60 * 1000;

/**
 * If the agent wrote a real handoff this recently, the auto snapshot would be a
 * strictly worse record arriving later — so we stand down instead.
 */
export const DEFAULT_FRESHNESS_MS = 30 * 60 * 1000;

// --- the decision (pure) ----------------------------------------------------

export interface CaptureInput {
  /** ISO time of our last auto-capture for this project, if any. */
  lastAutoAt: string | null;
  /** ISO time of the newest AGENT-authored handoff for this project, if any. */
  latestAgentSaveAt: string | null;
  /**
   * ISO time of the newest turn in the transcript we are about to capture.
   * This is what makes "is it already covered?" an exact question instead of a
   * guess — see decideCapture.
   */
  lastTurnAt: string | null;
  now: Date;
  throttleMs: number;
  freshnessMs: number;
  /** False when the transcript yielded nothing worth storing. */
  hasContent: boolean;
}

export interface CaptureDecision {
  capture: boolean;
  reason: string;
}

/**
 * Should this hook invocation write a snapshot?
 *
 * Pure on purpose: this is the whole policy of the feature, and it is the part
 * that is easy to get subtly wrong (a hook that fires on every tool call, or
 * one that buries a good handoff under a raw dump).
 */
export function decideCapture(input: CaptureInput): CaptureDecision {
  if (!input.hasContent) {
    return { capture: false, reason: "transcript had no usable turns" };
  }

  const nowMs = input.now.getTime();

  if (input.latestAgentSaveAt) {
    const savedAt = Date.parse(input.latestAgentSaveAt);

    if (input.lastTurnAt) {
      // The exact question: did the agent's handoff come AFTER the last thing
      // that happened in this transcript? If so it already describes this work
      // and a raw dump would only shadow it. If the conversation continued past
      // the handoff, that later work is uncovered and must be captured.
      //
      // A time window cannot answer this. "Saved 15 minutes ago" is a skip if
      // the session ended 16 minutes ago and a DATA LOSS if the user kept
      // working for another hour — which is the common case across a long
      // ticket with several short sessions.
      if (savedAt >= Date.parse(input.lastTurnAt)) {
        return { capture: false, reason: "the agent's handoff already covers this transcript" };
      }
    } else {
      // No usable timestamps in the transcript — fall back to the time window.
      const age = nowMs - savedAt;
      if (age >= 0 && age < input.freshnessMs) {
        return {
          capture: false,
          reason: `an agent-authored handoff was saved ${Math.round(age / 60000)}m ago — not shadowing it`,
        };
      }
    }
  }

  if (input.lastAutoAt) {
    const age = nowMs - Date.parse(input.lastAutoAt);
    if (age >= 0 && age < input.throttleMs) {
      return {
        capture: false,
        reason: `throttled — last auto-capture was ${Math.round(age / 1000)}s ago`,
      };
    }
  }

  return { capture: true, reason: "no recent handoff for this project" };
}

// --- transcript rendering (pure) --------------------------------------------

/** One block of a Claude Code assistant/user message. */
type ContentBlock = { type?: string; text?: string; name?: string };

/**
 * Turn a Claude Code transcript (JSONL) into plain text, newest content last.
 *
 * Tolerant by design: this file is written by another program and its shape
 * changes between versions. A line we can't parse is skipped, never fatal —
 * a partial capture beats a crashed hook.
 */
export function renderTranscript(jsonl: string, maxChars = 12_000): string {
  const turns: string[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;

    const content = entry.message?.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = (content as ContentBlock[])
        .map((b) => {
          if (b?.type === "text" && b.text) return b.text;
          // Tool calls are signal — "it was editing serve.ts" is worth keeping —
          // but their arguments are bulky, so keep only the name.
          if (b?.type === "tool_use" && b.name) return `[tool: ${b.name}]`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    text = text.trim();
    if (text) turns.push(`### ${entry.message?.role ?? entry.type}\n${text}`);
  }

  if (!turns.length) return "";

  // Keep the TAIL: the end of a session is what the next tool needs to continue.
  let out = turns.join("\n\n");
  if (out.length > maxChars) {
    out = out.slice(out.length - maxChars);
    const nextTurn = out.indexOf("\n### ");
    // Start at a turn boundary so we never open mid-sentence.
    out = (nextTurn === -1 ? out : out.slice(nextTurn + 1)).trimStart();
    out = `_[earlier turns trimmed]_\n\n${out}`;
  }
  return out;
}

/**
 * The timestamp of the newest conversation turn in a transcript, if it has one.
 *
 * Claude Code stamps each JSONL line, but that is another program's format and
 * may change — a missing or unparseable stamp returns null and `decideCapture`
 * falls back to its time window rather than treating "unknown" as "now".
 */
export function lastActivityAt(jsonl: string): string | null {
  let newest: number | null = null;
  let newestIso: string | null = null;

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: string; timestamp?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!entry.timestamp) continue;
    const ms = Date.parse(entry.timestamp);
    if (Number.isNaN(ms)) continue;
    // Scan for the MAX rather than taking the last line: ordering is the
    // writer's business, not a guarantee we should depend on.
    if (newest === null || ms > newest) {
      newest = ms;
      newestIso = entry.timestamp;
    }
  }
  return newestIso;
}

// --- throttle state ---------------------------------------------------------

type HookState = Record<string, { lastAutoAt: string }>;

function readState(): HookState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as HookState;
  } catch {
    return {}; // missing or corrupt state means "never captured" — safe either way
  }
}

function writeState(state: HookState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

// --- the command ------------------------------------------------------------

/** Read the hook payload from stdin. Empty stdin is normal when run by hand. */
async function readPayload(): Promise<HookPayload> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookPayload;
  } catch {
    return {};
  }
}

/**
 * Run one auto-capture. Returns the lines to report.
 *
 * NEVER THROWS PAST THE CALLER for anything environmental. A hook that fails
 * loudly interrupts the user's actual session — the tool we're protecting.
 */
export async function runHook(argv: string[]): Promise<string[]> {
  const payload = await readPayload();
  const event = payload.hook_event_name ?? "manual";
  const cwd = payload.cwd ?? process.cwd();
  const project = basename(cwd);

  const transcriptPath = payload.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return [`ctxvault hook (${event}): no transcript to capture — skipped`];
  }

  let rendered = "";
  let lastTurnAt: string | null = null;
  try {
    const jsonl = readFileSync(transcriptPath, "utf8");
    rendered = renderTranscript(jsonl);
    lastTurnAt = lastActivityAt(jsonl);
  } catch (err) {
    return [`ctxvault hook (${event}): could not read transcript — ${(err as Error).message}`];
  }

  const { store, engine } = createRuntime(() => {});
  try {
    const latest = await engine.getLatest(project);
    // Only an agent-authored note counts as "already covered"; our own raw
    // snapshots are exactly what the throttle is for.
    const latestAgentSaveAt = latest?.handoffNote ? latest.createdAt : null;
    const state = readState();

    const decision = decideCapture({
      lastAutoAt: state[project]?.lastAutoAt ?? null,
      latestAgentSaveAt,
      lastTurnAt,
      now: new Date(),
      throttleMs: numberFlag(argv, "throttle", DEFAULT_THROTTLE_MS),
      freshnessMs: numberFlag(argv, "freshness", DEFAULT_FRESHNESS_MS),
      hasContent: rendered.length > 0,
    });

    if (!decision.capture) {
      return [`ctxvault hook (${event}): ${decision.reason}`];
    }

    // A resuming agent must be able to tell this apart from a curated handoff,
    // or it will trust a raw dump as if someone had vouched for it.
    const banner =
      `_Auto-captured by CtxVault on ${event} — this is a raw transcript tail, ` +
      `not an agent-authored handoff. Treat it as evidence, not as a summary._\n\n`;

    const result = await engine.save({
      project,
      session: AUTO_SESSION,
      handoff: null, // model-free: we summarize nothing
      facts: [],
      transcript: banner + rendered,
    });

    state[project] = { lastAutoAt: new Date().toISOString() };
    writeState(state);

    return [
      `ctxvault hook (${event}): saved ${result.savedChars} chars for "${project}" ` +
        `→ session "${AUTO_SESSION}"`,
    ];
  } finally {
    await store.close();
  }
}

function numberFlag(argv: string[], name: string, fallback: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(argv[i + 1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// --- `ctx hook install` -----------------------------------------------------

/** The `ctx` CLI as an absolute command, so the hook doesn't depend on PATH. */
function hookCommand(): string {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} hook`;
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

/**
 * Merge our hook into an existing hooks array without duplicating it on repeat
 * installs and without disturbing anyone else's hooks. Pure, and exported
 * because "install twice, still one hook" is the property worth testing.
 */
export function mergeHookEntries(existing: HookEntry[], command: string): HookEntry[] {
  const isOurs = (e: HookEntry) => e.hooks?.some((h) => h.command?.includes("cli.js") && h.command?.includes(" hook"));
  const others = existing.filter((e) => !isOurs(e));
  return [...others, { hooks: [{ type: "command", command, timeout: 15 }] }];
}

/** The events worth capturing on: right before context is discarded, and at close. */
export const HOOK_EVENTS = ["PreCompact", "SessionEnd"] as const;

export function installHooks(): string[] {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });

  let doc: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8").trim();
    if (raw) doc = JSON.parse(raw) as Record<string, unknown>;
    const backupPath = `${settingsPath}.ctxvault-backup`;
    if (!existsSync(backupPath)) copyFileSync(settingsPath, backupPath);
  }

  const command = hookCommand();
  const hooks = (doc.hooks as Record<string, HookEntry[]> | undefined) ?? {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = mergeHookEntries(hooks[event] ?? [], command);
  }
  doc.hooks = hooks;
  writeFileSync(settingsPath, `${JSON.stringify(doc, null, 2)}\n`);

  return [
    `Installed CtxVault auto-capture in ${settingsPath}`,
    `Events: ${HOOK_EVENTS.join(", ")}`,
    `Command: ${command}`,
    "",
    "From now on, Claude Code saves a raw snapshot before compacting and at session end —",
    "so context survives even when the agent has no turn left to write a handoff.",
    "Restart Claude Code to load the hooks.",
  ];
}

/** `ctx hook status` — what the throttle currently knows. */
export function hookStatus(): string[] {
  const state = readState();
  const entries = Object.entries(state);
  if (!entries.length) return ["No auto-captures recorded yet.", `State file: ${STATE_PATH}`];
  return [
    "Last auto-capture per project:",
    ...entries.map(([project, s]) => `• ${project} — ${s.lastAutoAt}`),
    "",
    `State file: ${STATE_PATH}`,
  ];
}
