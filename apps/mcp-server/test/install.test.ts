import { describe, expect, it } from "vitest";
import { httpEntry, stdioEntry, upsertTomlTable } from "../src/install.js";

/**
 * `ctx install` edits config files a human wrote by hand. The property that
 * matters is not "our entry is correct" — it's "nothing else changed". These
 * tests pin the merge, because the failure mode is destroying someone's setup.
 */

describe("upsertTomlTable", () => {
  const block = '[mcp_servers.ctxvault]\ncommand = "node"\nargs = ["/new/path.js"]\n';

  it("appends to a file that has no such table", () => {
    const source = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n';
    const out = upsertTomlTable(source, "mcp_servers.ctxvault", block);
    expect(out).toContain('model = "o3"');
    expect(out).toContain("[mcp_servers.other]");
    expect(out).toContain("[mcp_servers.ctxvault]");
  });

  it("replaces an existing table in place", () => {
    const source = '[mcp_servers.ctxvault]\ncommand = "node"\nargs = ["/OLD/path.js"]\n';
    const out = upsertTomlTable(source, "mcp_servers.ctxvault", block);
    expect(out).toContain("/new/path.js");
    expect(out).not.toContain("/OLD/path.js");
  });

  it("removes stale SUBTABLES of ours, not just the header", () => {
    // The real bug this guards: an old [mcp_servers.ctxvault.env] carrying API
    // keys would survive a header-only replace and keep being loaded.
    const source = [
      "[mcp_servers.ctxvault]",
      'command = "node"',
      'args = ["/OLD/path.js"]',
      "",
      "[mcp_servers.ctxvault.env]",
      'OPENAI_API_KEY = "sk-old"',
      "",
      "[mcp_servers.other]",
      'command = "keep-me"',
      "",
    ].join("\n");

    const out = upsertTomlTable(source, "mcp_servers.ctxvault", block);
    expect(out).not.toContain("sk-old");
    expect(out).not.toContain("mcp_servers.ctxvault.env");
    expect(out).toContain("/new/path.js");
    // and the unrelated server is untouched
    expect(out).toContain("[mcp_servers.other]");
    expect(out).toContain('command = "keep-me"');
  });

  it("does not match a table that merely shares a prefix", () => {
    const source = '[mcp_servers.ctxvault_backup]\ncommand = "keep"\n';
    const out = upsertTomlTable(source, "mcp_servers.ctxvault", block);
    expect(out).toContain("[mcp_servers.ctxvault_backup]");
    expect(out).toContain('command = "keep"');
  });

  it("is idempotent — running install twice yields the same file", () => {
    const once = upsertTomlTable("", "mcp_servers.ctxvault", block);
    const twice = upsertTomlTable(once, "mcp_servers.ctxvault", block);
    expect(twice).toBe(once);
  });

  it("preserves settings that appear before any table header", () => {
    const source = 'model = "o3"\napproval_policy = "on-request"\n\n[mcp_servers.ctxvault]\ncommand = "old"\n';
    const out = upsertTomlTable(source, "mcp_servers.ctxvault", block);
    expect(out).toContain('model = "o3"');
    expect(out).toContain('approval_policy = "on-request"');
  });
});

describe("client entries", () => {
  it("stdio entry points at an absolute server path with an absolute node", () => {
    const entry = stdioEntry() as { command: string; args: string[] };
    // Depending on PATH is how "it worked yesterday" happens — both halves are absolute.
    expect(entry.command.startsWith("/")).toBe(true);
    expect(entry.args[0].startsWith("/")).toBe(true);
    expect(entry.args[0].endsWith("index.js")).toBe(true);
  });

  it("http entry carries the bearer token only when there is one", () => {
    expect(httpEntry("http://127.0.0.1:7077/mcp")).toEqual({
      type: "http",
      url: "http://127.0.0.1:7077/mcp",
    });
    expect(httpEntry("http://127.0.0.1:7077/mcp", "s3cret")).toMatchObject({
      headers: { Authorization: "Bearer s3cret" },
    });
  });
});
