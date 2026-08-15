import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffNote, Snapshot, StoredFact } from "../src/types.js";
import {
  writeOkfFile,
  readOkfFile,
  listOkfFiles,
  writeHandoffFile,
  readHandoffFile,
  listHandoffFiles,
} from "../src/index.js";

/**
 * "Markdown is the truth, SQLite is a derived index" only holds if the markdown
 * round-trips losslessly. These tests write files and read them back through the
 * same code paths `ctx reindex` uses — a failure here means a rebuilt vault is
 * NOT the vault you saved.
 */

const dir = mkdtempSync(join(tmpdir(), "ctxvault-okf-"));

const fact = (over: Partial<StoredFact> = {}): StoredFact => ({
  project: "myapp",
  slug: "password-hashing-argon2",
  type: "decision",
  title: "Password hashing uses argon2id",
  body: "Chose argon2id over bcrypt for the memory-hardness; verified against OWASP 2026 guidance.",
  tags: ["auth", "security"],
  session: "main",
  updatedAt: "2026-08-15T10:00:00.000Z",
  filePath: null,
  ...over,
});

const note: HandoffNote = {
  goal: "Migrate the auth layer to argon2id",
  decisions: [{ what: "argon2id over bcrypt", why: "memory-hard, OWASP-recommended" }],
  currentState: "hashing done, tests pending",
  openTodos: ["add burst-traffic test"],
  filesTouched: ["src/auth/hash.ts"],
  gotchas: ["argon2 needs node-argon2 native build on CI"],
  nextStep: "Write the burst-traffic test",
};

describe("OKF fact files", () => {
  it("round-trips a fact losslessly through frontmatter + body", () => {
    const path = writeOkfFile(dir, fact());
    expect(existsSync(path)).toBe(true);

    const back = readOkfFile(path, "myapp", "password-hashing-argon2");
    expect(back.slug).toBe(fact().slug);
    expect(back.type).toBe(fact().type);
    expect(back.title).toBe(fact().title);
    expect(back.body).toBe(fact().body);
    expect(back.tags).toEqual(fact().tags);
    expect(back.project).toBe("myapp"); // the RAW project string survives, not the dir name
    expect(back.session).toBe("main");
    expect(back.updatedAt).toBe("2026-08-15T10:00:00.000Z");
  });

  it("re-saving the same slug overwrites — one file, not a duplicate", () => {
    writeOkfFile(dir, fact());
    writeOkfFile(dir, fact({ body: "updated reasoning" }));
    const files = readdirSync(join(dir, "myapp")).filter((f) => f.endsWith(".md"));
    expect(files).toEqual(["password-hashing-argon2.md"]);
    const back = listOkfFiles(dir, "myapp");
    expect(back).toHaveLength(1);
    expect(back[0].body).toBe("updated reasoning");
  });

  it("keeps the original project string readable in frontmatter for odd names", () => {
    // Dir becomes "my-app", but the query key recorded inside is "My App".
    writeOkfFile(dir, fact({ project: "My App", slug: "odd-project" }));
    const [read] = listOkfFiles(dir, "My App");
    expect(read.project).toBe("My App");
  });
});

describe("handoff files", () => {
  const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
    id: "8097f474-a85b-43f9-9340-3c8615293293",
    project: "myapp",
    session: "main",
    createdAt: "2026-08-15T09:08:00.116Z",
    rawTranscript: "User: do the thing\nAssistant: did the thing",
    handoffNote: note,
    ...over,
  });

  it("round-trips a snapshot with its structured note losslessly", () => {
    const path = writeHandoffFile(dir, snap());
    const [back] = listHandoffFiles(dir, "myapp");

    expect(back.id).toBe(snap().id);
    expect(back.project).toBe("myapp");
    expect(back.session).toBe("main");
    expect(back.createdAt).toBe(snap().createdAt);
    expect(back.rawTranscript).toBe(snap().rawTranscript);
    expect(back.handoffNote).toEqual(note);
    expect(path).toContain("20260815-090800--8097f474");
  });

  it("round-trips a raw snapshot as RAW — no note invented from empty strings", () => {
    writeHandoffFile(dir, snap({ handoffNote: null, session: "rawline" }));
    const raws = listHandoffFiles(dir, "myapp").filter((s) => s.session === "rawline");
    expect(raws).toHaveLength(1);
    expect(raws[0].handoffNote).toBeNull();
    expect(raws[0].rawTranscript).toContain("did the thing");
  });

  it("skips a hand-edited file with a broken note instead of crashing the rebuild", () => {
    const broken = join(dir, "myapp", "brokenline", "20260815-000000--deadbeef.md");
    mkdirSync(join(dir, "myapp", "brokenline"), { recursive: true });
    // goal present (so it tries to parse a note) but decisions is a string —
    // schema validation must reject it and leave the note null, not throw.
    writeFileSync(
      broken,
      "---\nid: deadbeef-0000-0000-0000-000000000000\nproject: myapp\nsession: brokenline\ncreated: 2026-08-15T00:00:00.000Z\ngoal: fix me\ndecisions: not-an-array\n---\ntranscript body\n",
      "utf8",
    );
    // Note: `created` is deliberately UNQUOTED — exactly what a hand edit looks
    // like. YAML parses it as a Date; the reader must coerce, not drop the file.
    const parsed = readHandoffFile(broken, "myapp");
    expect(parsed).not.toBeNull();
    expect(parsed!.createdAt).toBe("2026-08-15T00:00:00.000Z");
    expect(parsed!.handoffNote).toBeNull(); // decisions: not-an-array → schema rejects
    expect(parsed!.rawTranscript).toBe("transcript body");
  });
});
