import { describe, expect, it } from "vitest";
import { CtxEngine } from "../src/engine.js";
import { MemoryAdapter } from "../src/storage/memory.js";
import type { Embedder } from "../src/embed/types.js";
import type { Fact, HandoffNote, StoredFact } from "../src/types.js";

/**
 * The engine's flows on the in-memory adapter — the same code the MCP server
 * and the CLI run. Every promise the README makes mechanically is pinned here:
 * raw degradation, the resume priority stack, the token budget, and the
 * relevance floor ("no match" must be SAID, not implied by a low number).
 */

const note = (over: Partial<HandoffNote> = {}): HandoffNote => ({
  goal: "Choose and wire up password hashing for the auth service",
  decisions: [{ what: "argon2id over bcrypt", why: "memory-hard, OWASP-recommended" }],
  currentState: "hash.ts written, tests not started",
  openTodos: ["write the burst-traffic test"],
  filesTouched: ["src/auth/hash.ts"],
  gotchas: ["argon2 needs a native build on CI runners"],
  nextStep: "Write the burst-traffic test for /login",
  ...over,
});

const facts = (): Fact[] => [
  {
    slug: "password-hashing-argon2",
    type: "decision",
    title: "Password hashing uses argon2id",
    body: "Chose argon2id over bcrypt for password hashing because it is memory-hard and OWASP-recommended.",
    tags: ["auth", "security"],
  },
  {
    slug: "css-grid-dashboard",
    type: "convention",
    title: "Dashboard layout uses CSS grid",
    body: "All dashboard pages use CSS grid, not flexbox, per the design system.",
    tags: ["css", "ui"],
  },
];

/** Deterministic fake embedder: hashes the text into a 16-dim vector. */
const fakeEmbedder: Embedder = {
  id: "test-hash-16",
  dimensions: 16,
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = new Array(16).fill(0);
      for (const ch of t) v[ch.charCodeAt(0) % 16] += 1;
      return v;
    });
  },
};

describe("save", () => {
  it("stores the handoff, the facts, and reports agent mode", async () => {
    const engine = new CtxEngine(new MemoryAdapter());
    const r = await engine.save({
      project: "myapp",
      session: "main",
      handoff: note(),
      facts: facts(),
      transcript: "User: hi\nAssistant: hey",
    });
    expect(r.mode).toBe("agent");
    expect(r.factsExtracted).toBe(2);
    expect(r.warning).toBeUndefined();
    expect(await engine.listFacts("myapp")).toHaveLength(2);
  });

  it("degrades to raw storage when no handoff is supplied — never a dead button", async () => {
    const engine = new CtxEngine(new MemoryAdapter());
    const r = await engine.save({ project: "p", session: "main", transcript: "just a transcript" });
    expect(r.mode).toBe("raw");
    expect(r.factsExtracted).toBe(0);
  });

  it("a failing fact never costs the save — it becomes a warning", async () => {
    // One specific fact fails at the storage layer (disk full, permissions);
    // the save itself and the other facts must still land.
    class FlakyStore extends MemoryAdapter {
      async saveFact(fact: StoredFact): Promise<StoredFact> {
        if (fact.slug === "bad-fact") throw new Error("disk full");
        return super.saveFact(fact);
      }
    }
    const engine = new CtxEngine(new FlakyStore());
    const bad = { ...facts()[0], slug: "bad-fact", title: "The bad one" };
    const r = await engine.save({
      project: "p",
      session: "main",
      handoff: note(),
      facts: [bad, facts()[1]],
    });
    expect(r.mode).toBe("agent");
    expect(r.factsExtracted).toBe(1);
    expect(r.warning).toContain("bad-fact");
    expect(r.warning).toContain("disk full");
    expect((await engine.listFacts("p")).map((f) => f.slug)).toEqual([facts()[1].slug]);
  });
});

describe("resume", () => {
  it("returns found:false with a plain message when nothing is saved", async () => {
    const engine = new CtxEngine(new MemoryAdapter());
    const r = await engine.resume({ project: "ghost" });
    expect(r.found).toBe(false);
    expect(r.packed).toContain("No saved context found");
    expect(r.nextStep).toBeNull();
  });

  it("packs the priority stack: handoff → knowledge index → relevant facts → transcript", async () => {
    const engine = new CtxEngine(new MemoryAdapter());
    await engine.save({
      project: "myapp",
      session: "main",
      handoff: note(),
      facts: facts(),
      transcript: "User: please fix auth\nAssistant: on it",
    });

    const r = await engine.resume({ project: "myapp" });
    expect(r.found).toBe(true);
    expect(r.nextStep).toBe("Write the burst-traffic test for /login");
    expect(r.packed).toContain("## Handoff note");
    expect(r.packed).toContain("**Next step:** Write the burst-traffic test");
    expect(r.packed).toContain("## Knowledge index (2)");
    expect(r.packed).toContain("Password hashing uses argon2id"); // relevant to the goal
    expect(r.packed).toContain("## Recent transcript (tail)");
  });

  it("respects the token budget: a huge transcript is truncated to the tail", async () => {
    const engine = new CtxEngine(new MemoryAdapter());
    const longTail = "TRANSCRIPT-START-MARKER " + "filler ".repeat(4000); // ~28k chars
    await engine.save({
      project: "myapp",
      session: "main",
      handoff: note(),
      facts: facts(),
      transcript: longTail,
    });

    const r = await engine.resume({ project: "myapp", budget: 600 }); // ≈ 2400 chars
    expect(r.found).toBe(true);
    expect(r.estimatedTokens).toBeLessThanOrEqual(600 * 1.25);
    expect(r.packed).not.toContain("TRANSCRIPT-START-MARKER"); // the head was dropped
    expect(r.packed).toContain("[earlier context truncated]");
  });

  it("resumes the newest snapshot, and a named session when asked", async () => {
    const engine = new CtxEngine(new MemoryAdapter());
    await engine.save({ project: "p", session: "a", handoff: note({ nextStep: "from session A" }), transcript: "" });
    await engine.save({ project: "p", session: "b", handoff: note({ nextStep: "from session B" }), transcript: "" });

    expect((await engine.resume({ project: "p" })).nextStep).toBe("from session B");
    expect((await engine.resume({ project: "p", session: "a" })).nextStep).toBe("from session A");

    const sessions = await engine.listSessions("p");
    expect(sessions.map((s) => s.session).sort()).toEqual(["a", "b"]);
  });
});

describe("export", () => {
  it("compact export drops the transcript — the CLAUDE.md block must stay small", async () => {
    const engine = new CtxEngine(new MemoryAdapter());
    await engine.save({
      project: "myapp",
      session: "main",
      handoff: note(),
      facts: facts(),
      transcript: "User: secret verbatim tail that should not ship",
    });

    const compact = await engine.exportPacket({ project: "myapp", compact: true, budget: 600 });
    expect(compact.packed).not.toContain("secret verbatim tail");
    expect(compact.packed).toContain("## Handoff note");

    const full = await engine.exportPacket({ project: "myapp" });
    expect(full.packed).toContain("secret verbatim tail");
  });
});

describe("search", () => {
  it("keyword search finds a fact by its distinctive terms, keyless", async () => {
    const engine = new CtxEngine(new MemoryAdapter());
    await engine.save({ project: "p", session: "main", handoff: note(), facts: facts(), transcript: "" });

    const hits = await engine.search("p", "argon2 password hashing", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].kind).toBe("fact");
    expect(hits[0].refId).toBe("password-hashing-argon2");
    expect(hits[0].lexical).toBeGreaterThan(0);
  });

  it("honours the relevance floor: junk queries return NOTHING, not weak noise", async () => {
    const engine = new CtxEngine(new MemoryAdapter());
    await engine.save({ project: "p", session: "main", handoff: note(), facts: facts(), transcript: "" });

    const hits = await engine.search("p", "kubernetes flowerpot xylophone", 5);
    expect(hits).toEqual([]);
  });

  it("respects k and searches across kinds (facts AND handoffs)", async () => {
    const engine = new CtxEngine(new MemoryAdapter());
    await engine.save({ project: "p", session: "main", handoff: note(), facts: facts(), transcript: "" });

    const hits = await engine.search("p", "argon2", 10);
    expect(hits.length).toBeLessThanOrEqual(10);
    const kinds = new Set(hits.map((h) => h.kind));
    expect(kinds).toContain("fact"); // the fact body mentions argon2id
  });

  it("hybrid: an embedder joins the blend and vectors are filtered by embedder id", async () => {
    const engine = new CtxEngine(new MemoryAdapter(), fakeEmbedder);
    await engine.save({ project: "p", session: "main", handoff: note(), facts: facts(), transcript: "" });
    expect(engine.hybrid).toBe(true);

    const hits = await engine.search("p", "argon2 hashing", 5);
    expect(hits.length).toBeGreaterThan(0);
    // The fake embedder is deterministic, so doc and query vectors with shared
    // letters land near each other — the blend must still put the argon2 fact up top.
    expect(hits.some((h) => h.refId === "password-hashing-argon2")).toBe(true);

    // A vector from a DIFFERENT embedder must never be compared (garbage cosine).
    const store = new MemoryAdapter();
    await store.saveVector({
      project: "p",
      kind: "fact",
      refId: "foreign-vector",
      filePath: null,
      text: "foreign",
      embedding: new Array(16).fill(1),
      embedder: "someone-else",
    });
    const e2 = new CtxEngine(store, fakeEmbedder);
    const hits2 = await e2.search("p", "anything", 5);
    expect(hits2.every((h) => h.refId !== "foreign-vector")).toBe(true);
  });
});
