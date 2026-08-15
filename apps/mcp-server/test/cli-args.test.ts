import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";

/**
 * Argument parsing, pinned after a real bug.
 *
 * `ctx install claude-code --http --token abc` used to parse `--http` as a
 * key/value flag, so it swallowed `--token`, wrote an UNAUTHENTICATED config
 * entry, and reported success. A silent security downgrade is exactly the kind
 * of thing a two-line parser gets wrong, so it gets tests.
 */
describe("parseArgs", () => {
  it("reads the command and positionals", () => {
    const { cmd, rest } = parseArgs(["search", "argon2", "hashing"]);
    expect(cmd).toBe("search");
    expect(rest).toEqual(["argon2", "hashing"]);
  });

  it("parses --key value and --key=value alike", () => {
    expect(parseArgs(["export", "--project", "ctxvault"]).flags.project).toBe("ctxvault");
    expect(parseArgs(["export", "--project=ctxvault"]).flags.project).toBe("ctxvault");
  });

  it("treats a declared switch as a switch, not a key expecting a value", () => {
    const { flags } = parseArgs(["install", "claude-code", "--http", "--token", "abc"]);
    expect(flags.http).toBe("true");
    expect(flags.token).toBe("abc"); // the regression: this used to be lost
  });

  it("keeps the positional after a switch", () => {
    const { rest, flags } = parseArgs(["install", "--http", "claude-code"]);
    expect(flags.http).toBe("true");
    expect(rest).toEqual(["claude-code"]);
  });

  it("does not let a value flag eat the following flag", () => {
    const { flags } = parseArgs(["serve", "--token", "--port", "7099"]);
    expect(flags.token).toBe("");
    expect(flags.port).toBe("7099");
  });

  it("tolerates a value flag at the end of the line", () => {
    expect(parseArgs(["serve", "--port"]).flags.port).toBe("");
  });

  it("still handles -k", () => {
    expect(parseArgs(["search", "auth", "-k", "3"]).flags.k).toBe("3");
  });
});
