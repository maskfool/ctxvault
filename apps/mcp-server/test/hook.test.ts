import { describe, expect, it } from "vitest";
import {
  decideCapture,
  lastActivityAt,
  mergeHookEntries,
  renderTranscript,
  DEFAULT_FRESHNESS_MS,
  DEFAULT_THROTTLE_MS,
} from "../src/hook.js";

/**
 * The auto-capture policy, tested where it actually lives.
 *
 * `decideCapture` is the whole feature: a hook that fires too often spams the
 * vault, and one that fires at the wrong moment buries a good agent-authored
 * handoff under a raw transcript dump. Both failures are invisible until a
 * resume comes back worse than it should — so they get pinned here.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const base = {
  lastAutoAt: null,
  latestAgentSaveAt: null,
  lastTurnAt: null,
  now: NOW,
  throttleMs: DEFAULT_THROTTLE_MS,
  freshnessMs: DEFAULT_FRESHNESS_MS,
  hasContent: true,
};

describe("decideCapture", () => {
  it("captures when nothing has been saved for the project", () => {
    expect(decideCapture(base).capture).toBe(true);
  });

  it("never captures an empty transcript", () => {
    const d = decideCapture({ ...base, hasContent: false });
    expect(d.capture).toBe(false);
    expect(d.reason).toMatch(/no usable turns/);
  });

  it("stands down when the handoff came after the last turn", () => {
    // The anti-shadowing rule: the agent saved, then the session ended with
    // nothing further said. A raw dump would arrive later and displace it.
    const d = decideCapture({
      ...base,
      lastTurnAt: minutesAgo(20),
      latestAgentSaveAt: minutesAgo(19),
    });
    expect(d.capture).toBe(false);
    expect(d.reason).toMatch(/already covers/);
  });

  it("CAPTURES work done after the handoff — the multi-session case", () => {
    // A three-hour ticket in short sessions: the user saved manually at the end
    // of session 1, then worked another 15 minutes in session 2 and exited
    // without saving. That later work is uncovered and MUST be captured.
    //
    // The first version of this rule used a 30-minute window and silently
    // dropped session 2. This test is the regression.
    const d = decideCapture({
      ...base,
      latestAgentSaveAt: minutesAgo(15),
      lastTurnAt: minutesAgo(1),
    });
    expect(d.capture).toBe(true);
  });

  it("falls back to the time window when the transcript has no timestamps", () => {
    // Another program's format; if we can't read the stamps we must not treat
    // "unknown" as "nothing happened".
    expect(decideCapture({ ...base, latestAgentSaveAt: minutesAgo(3) }).capture).toBe(false);
    expect(decideCapture({ ...base, latestAgentSaveAt: minutesAgo(180) }).capture).toBe(true);
  });

  it("throttles repeat auto-captures inside the window", () => {
    const d = decideCapture({ ...base, lastAutoAt: minutesAgo(1) });
    expect(d.capture).toBe(false);
    expect(d.reason).toMatch(/throttled/);
  });

  it("captures once the throttle window has passed", () => {
    expect(decideCapture({ ...base, lastAutoAt: minutesAgo(10) }).capture).toBe(true);
  });

  it("ignores timestamps from the future rather than locking itself out", () => {
    // Clock skew across synced machines must not permanently disable capture.
    const future = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    expect(decideCapture({ ...base, lastAutoAt: future }).capture).toBe(true);
    expect(decideCapture({ ...base, latestAgentSaveAt: future }).capture).toBe(true);
  });
});

describe("renderTranscript", () => {
  const line = (type: string, content: unknown) =>
    JSON.stringify({ type, message: { role: type, content } });

  it("renders string and block content, keeping tool names but not their args", () => {
    const jsonl = [
      line("user", "add the serve command"),
      line("assistant", [
        { type: "text", text: "On it." },
        { type: "tool_use", name: "Write", input: { huge: "x".repeat(5000) } },
      ]),
    ].join("\n");

    const out = renderTranscript(jsonl);
    expect(out).toContain("add the serve command");
    expect(out).toContain("On it.");
    expect(out).toContain("[tool: Write]");
    expect(out).not.toContain("xxxxx"); // bulky tool arguments stay out
  });

  it("skips unparseable lines and non-conversation entries instead of throwing", () => {
    const jsonl = [
      "{not json",
      JSON.stringify({ type: "queue-operation", operation: "add" }),
      line("user", "still here"),
      "",
    ].join("\n");
    expect(renderTranscript(jsonl)).toContain("still here");
  });

  it("returns empty string when there is nothing to capture", () => {
    expect(renderTranscript("")).toBe("");
    expect(renderTranscript(JSON.stringify({ type: "queue-operation" }))).toBe("");
  });

  it("keeps the TAIL when over budget, cut at a turn boundary", () => {
    const jsonl = Array.from({ length: 50 }, (_, i) =>
      line("user", `turn ${i} ${"padding ".repeat(40)}`),
    ).join("\n");

    const out = renderTranscript(jsonl, 1000);
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain("turn 49"); // the end of the session survives
    expect(out).not.toContain("turn 0 "); // the beginning is what gets dropped
    expect(out).toContain("earlier turns trimmed");
    // No half-open turn: the body after the banner starts at a heading.
    expect(out.split("\n\n").slice(1).join("\n\n").startsWith("### ")).toBe(true);
  });
});

describe("lastActivityAt", () => {
  const stamped = (type: string, timestamp: string) =>
    JSON.stringify({ type, timestamp, message: { role: type, content: "hi" } });

  it("returns the newest conversation timestamp", () => {
    const jsonl = [
      stamped("user", "2026-08-15T10:00:00.000Z"),
      stamped("assistant", "2026-08-15T10:05:00.000Z"),
    ].join("\n");
    expect(lastActivityAt(jsonl)).toBe("2026-08-15T10:05:00.000Z");
  });

  it("takes the maximum, not the last line", () => {
    // Ordering is the writer's business; we don't depend on it.
    const jsonl = [
      stamped("user", "2026-08-15T10:09:00.000Z"),
      stamped("assistant", "2026-08-15T10:01:00.000Z"),
    ].join("\n");
    expect(lastActivityAt(jsonl)).toBe("2026-08-15T10:09:00.000Z");
  });

  it("ignores non-conversation lines and unparseable stamps", () => {
    const jsonl = [
      JSON.stringify({ type: "queue-operation", timestamp: "2026-08-15T23:00:00.000Z" }),
      stamped("user", "not-a-date"),
      stamped("user", "2026-08-15T10:00:00.000Z"),
    ].join("\n");
    expect(lastActivityAt(jsonl)).toBe("2026-08-15T10:00:00.000Z");
  });

  it("returns null when nothing is stamped, so the caller can fall back", () => {
    expect(lastActivityAt(JSON.stringify({ type: "user", message: { content: "hi" } }))).toBeNull();
    expect(lastActivityAt("")).toBeNull();
  });
});

describe("mergeHookEntries", () => {
  const ours = '"/usr/bin/node" "/opt/ctxvault/dist/cli.js" hook';

  it("adds our hook to an empty list", () => {
    expect(mergeHookEntries([], ours)).toHaveLength(1);
  });

  it("is idempotent — installing twice leaves one hook, not two", () => {
    const once = mergeHookEntries([], ours);
    const twice = mergeHookEntries(once, ours);
    expect(twice).toHaveLength(1);
  });

  it("preserves other people's hooks", () => {
    const existing = [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }];
    const merged = mergeHookEntries(existing, ours);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(existing[0]);
  });

  it("replaces a stale ctxvault path rather than stacking a second one", () => {
    // Reinstalling after moving the repo must not leave the old path firing.
    const old = mergeHookEntries([], '"/usr/bin/node" "/old/path/cli.js" hook');
    const merged = mergeHookEntries(old, ours);
    expect(merged).toHaveLength(1);
    expect(merged[0].hooks[0].command).toBe(ours);
  });
});
