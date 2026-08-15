import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  START_MARKER,
  END_MARKER,
  upsertSection,
  writeHarnessFile,
} from "../src/export/harness.js";

/**
 * The invariant that matters most in this file: THE VAULT GROWS, THE FILE DOES
 * NOT. A context file (CLAUDE.md/AGENTS.md) is read in full by every future
 * session, so an exporter that appends per export recreates the exact problem
 * CtxVault exists to fix. Every test here pins some facet of that.
 */

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("upsertSection", () => {
  it("replaces the region in place — exporting twice never grows the file", () => {
    const first = upsertSection("", "block one");
    const second = upsertSection(first.text, "block two, which is substantially longer than block one");
    const third = upsertSection(second.text, "b3");

    expect(third.action).toBe("replaced");
    expect(third.text).toContain("b3");
    expect(third.text).not.toContain("block one");
    // Exactly one region, no matter how many exports happened.
    expect(count(third.text, START_MARKER)).toBe(1);
    expect(count(third.text, END_MARKER)).toBe(1);
    // The bounded property, directly: a longer block replaces, it never stacks.
    expect(second.text.length).toBeGreaterThan(first.text.length);
    expect(third.text.length).toBeLessThan(second.text.length);
  });

  it("preserves everything outside the markers byte for byte", () => {
    const userContent =
      "# My project rules\n\nAlways run tests before pushing.\n\n## Notes\n\n" + "x".repeat(500);
    const withBlock = upsertSection(userContent, "the context");
    const again = upsertSection(withBlock.text, "newer context");

    // User content leads the file, untouched, and the region sits after it.
    expect(again.text.startsWith("# My project rules")).toBe(true);
    expect(again.text).toContain("Always run tests before pushing.");
    expect(again.text).toContain("x".repeat(500));
    expect(again.text.indexOf("## Notes")).toBeLessThan(again.text.indexOf(START_MARKER));
    expect(again.text.endsWith(END_MARKER + "\n")).toBe(true);
  });

  it("appends cleanly to a file with no markers, and ends with a newline", () => {
    const { text, action } = upsertSection("# Just user content\n", "block");
    expect(action).toBe("appended");
    expect(text).toContain("# Just user content");
    expect(text.indexOf(START_MARKER)).toBeGreaterThan(0);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("repairs a half-written region instead of trapping a stray marker", () => {
    // Simulate an interrupted write: start marker present, end marker missing.
    // The orphan MARKER lines are removed so the next write can't be trapped;
    // the partial content itself is conservatively kept as user content — the
    // writer never destroys bytes it isn't sure it owns.
    const broken = `# Header\n\n${START_MARKER}\npartial block without end marker\n`;
    const fixed = upsertSection(broken, "clean block");

    expect(fixed.action).toBe("appended"); // it rebuilds the region, not "replaced"
    expect(fixed.text).toContain("clean block");
    expect(count(fixed.text, START_MARKER)).toBe(1);
    expect(count(fixed.text, END_MARKER)).toBe(1);
    expect(fixed.text).toContain("partial block without end marker"); // kept, not destroyed
    expect(fixed.text).toContain("# Header");

    // Reversed markers must be cleaned the same way.
    const reversed = `# Header\n\n${END_MARKER}\n${START_MARKER}\nbody\n`;
    const fixed2 = upsertSection(reversed, "clean block");
    expect(count(fixed2.text, START_MARKER)).toBe(1);
    expect(count(fixed2.text, END_MARKER)).toBe(1);
    expect(fixed2.text).toContain("clean block");
  });
});

describe("writeHarnessFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxvault-harness-"));

  it("creates CLAUDE.md, then replaces the block on the second write", () => {
    const first = writeHarnessFile(dir, "claude", "first context");
    expect(first.action).toBe("created");
    expect(first.path.endsWith("CLAUDE.md")).toBe(true);

    const second = writeHarnessFile(dir, "claude", "second context");
    expect(second.action).toBe("replaced");

    const text = readFileSync(first.path, "utf8");
    expect(text).toContain("second context");
    expect(text).not.toContain("first context");
    expect(count(text, START_MARKER)).toBe(1);
  });

  it("writes AGENTS.md separately and never touches CLAUDE.md's region", () => {
    writeHarnessFile(dir, "claude", "claude context");
    const agents = writeHarnessFile(dir, "agents", "agents context");
    expect(agents.path.endsWith("AGENTS.md")).toBe(true);

    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("claude context");
    expect(claude).not.toContain("agents context");
  });

  it("respects hand-written content that already exists in the file", () => {
    const sub = join(dir, "with-existing");
    rmSync(sub, { recursive: true, force: true });
    mkdirSync(sub, { recursive: true });
    const file = join(sub, "CLAUDE.md");
    writeFileSync(file, "# Team conventions\n\nRun `npm run test`.\n", "utf8");

    writeHarnessFile(sub, "claude", "ctx");
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("# Team conventions")).toBe(true);
    expect(text).toContain("Run `npm run test`.");
  });
});
