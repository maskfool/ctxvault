import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { slugify } from "../src/lib/slug.js";
import { okfPath } from "../src/okf/okf.js";
import { handoffPath } from "../src/okf/handoff.js";

/**
 * slugify is a SECURITY BOUNDARY, not formatting: the slug arrives from a model
 * and becomes a filename under knowledge/<project>/. If it can carry "/" or
 * "..", a hallucinated (or malicious) slug writes outside the vault directory.
 */

describe("slugify", () => {
  it("neutralizes path traversal — the security boundary", () => {
    expect(slugify("../../etc/passwd")).toBe("etc-passwd");
    expect(slugify("..")).not.toContain("..");
    expect(slugify("a/../../b")).not.toMatch(/\.\./);
  });

  it("never contains a slash, ever — derived paths stay inside the vault", () => {
    for (const input of ["a/b/c", "x\\y", "step/../../..", "  spaces  ", "Ünïcödé!"]) {
      expect(slugify(input)).not.toMatch(/[/\\]/);
    }
    const factPath = okfPath("/vault", "proj/sub", "sl/ash");
    expect(factPath).toBe(join("/vault", "proj-sub", "sl-ash.md"));

    // "../escape" collapses to the plain directory name "escape" — a safe
    // single segment inside the vault, with no traversal anywhere.
    const snapPath = handoffPath("/vault", {
      id: "abcd1234-abcd-1234-abcd-1234abcd5678",
      project: "p",
      session: "../escape",
      createdAt: "2026-08-15T10:00:00.000Z",
      rawTranscript: "",
      handoffNote: null,
    });
    expect(snapPath).toBe(join("/vault", "p", "escape", "20260815-100000--abcd1234.md"));
    expect(snapPath).not.toMatch(/\.\./);
  });

  it("is stable and idempotent — same knowledge, same file", () => {
    const once = slugify("Use Intl.DateTimeFormat for timezone display");
    const twice = slugify(once);
    expect(twice).toBe(once);
    expect(once).toBe("use-intl-datetimeformat-for-timezone-display");
  });

  it("normalizes case, punctuation, runs, and unicode", () => {
    expect(slugify("My App!!")).toBe("my-app");
    expect(slugify("  --Multiple   dashes--  ")).toBe("multiple-dashes");
    // NFKD decomposes accents; the combining marks are non-alphanumeric and
    // become separators. Deterministic either way — that's what filenames need.
    expect(slugify("Ünïcödé")).toBe("u-ni-co-de");
  });

  it("degrades safely on empty or all-symbol input", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("!!!***")).toBe("untitled");
  });

  it("caps length so filenames stay sane", () => {
    expect(slugify("a".repeat(500)).length).toBeLessThanOrEqual(80);
  });
});
