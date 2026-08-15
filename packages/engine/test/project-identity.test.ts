import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CtxEngine } from "../src/engine.js";
import { SqliteAdapter } from "../src/storage/sqlite.js";
import { MemoryAdapter } from "../src/storage/memory.js";
import { normalizeProject, slugify } from "../src/lib/slug.js";
import type { HandoffNote } from "../src/types.js";

/**
 * Project identity — one folder, one vault, however you spell it.
 *
 * The bug this pins: file paths ran through `slugify` while database lookups
 * matched the raw string, so "CtxVault" and "ctxvault" shared a directory but
 * were two different vaults to every query. You could save context and then be
 * told "No saved context found" for the same folder — which reads as data loss,
 * not as a typo.
 */

const note: HandoffNote = {
  goal: "Ship project normalization",
  decisions: [{ what: "Key on the slug", why: "the directory already is one" }],
  currentState: "engine normalizes at every entry point",
  openTodos: ["publish to npm"],
  filesTouched: ["packages/engine/src/lib/slug.ts"],
  gotchas: ["the CLI, the hook and the agent all name the project differently"],
  nextStep: "Write the regression tests",
};

describe("normalizeProject", () => {
  it("collapses case — the variance a real vault actually sees", () => {
    // The folder name is fixed, so the CLI and the hook always agree. The
    // variance comes from the human (and the agent quoting them) retyping it.
    const forms = ["CtxVault", "ctxvault", "CTXVAULT", "ctxVault"];
    expect(new Set(forms.map(normalizeProject))).toEqual(new Set(["ctxvault"]));
  });

  it("collapses separators, so punctuation stops mattering", () => {
    const forms = ["My App", "my-app", "my_app", "my  app", "My.App"];
    expect(new Set(forms.map(normalizeProject))).toEqual(new Set(["my-app"]));
  });

  it("does NOT join words — a documented limit, not an accident", () => {
    // "ctxvault" and "ctx vault" stay distinct, because collapsing them would
    // mean the key could no longer equal the directory name (see below), and
    // that invariant is what makes `ctx projects` and reindex coherent.
    // `ctx projects` exists to show the canonical name when this bites.
    expect(normalizeProject("ctx vault")).toBe("ctx-vault");
    expect(normalizeProject("ctxvault")).toBe("ctxvault");
  });

  it("IS slugify — the invariant that keeps the key equal to the directory name", () => {
    // If these ever diverge, the database key and the folder holding that
    // project's files stop matching and the split-brain returns.
    for (const s of ["MyApp", "my app", "../etc/passwd", "", "Ünïcödé Prøject"]) {
      expect(normalizeProject(s)).toBe(slugify(s));
    }
  });

  it("still guards path traversal, because the key names a directory", () => {
    expect(normalizeProject("../../etc/passwd")).toBe("etc-passwd");
  });
});

describe("engine project identity", () => {
  let dir: string;
  let store: SqliteAdapter;
  let engine: CtxEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctxvault-identity-"));
    store = new SqliteAdapter(join(dir, "test.db"), {
      knowledgeDir: join(dir, "knowledge"),
      handoffDir: join(dir, "handoffs"),
    });
    engine = new CtxEngine(store);
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resumes work saved under a different spelling — the headline bug", async () => {
    // Claude Code's hook saves under basename(cwd).
    await engine.save({ project: "CtxVault", session: "main", handoff: note, facts: [] });

    // The next day, in Codex, the human says "resume project ctxvault".
    const resumed = await engine.resume({ project: "ctxvault" });
    expect(resumed.found).toBe(true);
    expect(resumed.packed).toContain("Ship project normalization");

    // …and every other casing they might use.
    for (const spelling of ["ctxvault", "CTXVAULT", "ctxVault"]) {
      expect((await engine.resume({ project: spelling })).found).toBe(true);
    }
  });

  it("agrees across facts, sessions and search — not just resume", async () => {
    await engine.save({
      project: "My App",
      session: "main",
      handoff: note,
      facts: [
        {
          slug: "argon2id-hashing",
          type: "decision",
          title: "Password hashing uses argon2id",
          body: "Chosen over bcrypt for memory-hardness.",
          tags: ["auth"],
        },
      ],
    });

    expect(await engine.listFacts("my-app")).toHaveLength(1);
    expect(await engine.listSessions("MY APP")).toHaveLength(1);
    expect(await engine.getLatest("my  app")).not.toBeNull();
    expect(await engine.search("My-App", "argon2id")).not.toHaveLength(0);
  });

  it("does not merge genuinely different projects", async () => {
    // Normalization must not become "everything is one vault".
    await engine.save({ project: "alpha", session: "main", handoff: note, facts: [] });
    expect((await engine.resume({ project: "beta" })).found).toBe(false);
  });

  it("writes files under the same name the database keys on", async () => {
    await engine.save({ project: "My App", session: "main", handoff: note, facts: [] });
    const sessions = await engine.listSessions("My App");
    expect(sessions).toHaveLength(1);

    // The stored snapshot's project is the canonical key, and it is exactly the
    // directory segment the handoff file was written into.
    const latest = await engine.getLatest("My App");
    expect(latest?.project).toBe("my-app");
  });

  it("heals a legacy vault on reindex instead of duplicating it", async () => {
    // Simulate a pre-normalization vault: write the files with a raw project
    // name straight through the adapter, bypassing the engine's front door.
    await store.saveSnapshot({
      project: "LegacyName",
      session: "main",
      rawTranscript: "",
      handoffNote: note,
    });
    expect(await store.getLatest("LegacyName")).not.toBeNull();

    // The rebuild reads the markdown (source of truth) and canonicalizes.
    await store.importFromFiles();

    const healed = await engine.resume({ project: "legacyname" });
    expect(healed.found).toBe(true);
    expect(healed.packed).toContain("Ship project normalization");

    // The snapshot id is stable, so the row was rewritten, not duplicated.
    expect(await store.listSnapshots("legacyname")).toHaveLength(1);
  });
});

describe("memory adapter honours the same rule", () => {
  it("normalizes identically, so the playground can't drift from the CLI", async () => {
    // Same engine, different adapter (AGENTS.md rule 6) — the behaviour lives in
    // the engine, so both front doors must agree.
    const engine = new CtxEngine(new MemoryAdapter());
    await engine.save({ project: "Playground Demo", session: "main", handoff: note, facts: [] });
    expect((await engine.resume({ project: "playground-demo" })).found).toBe(true);
  });
});
