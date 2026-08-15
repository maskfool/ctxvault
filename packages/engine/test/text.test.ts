import { describe, expect, it } from "vitest";
import { ftsQuery, tokenize, queryTerms, bm25Rank, handoffSearchBody, normalizeBm25 } from "../src/lib/text.js";
import type { HandoffNote } from "../src/types.js";

/**
 * Everything a user (or an agent) types becomes an FTS5 MATCH expression via
 * ftsQuery. If natural language ever reaches FTS5 raw, "?", AND, NEAR or a
 * stray quote is a syntax error that takes search down — and keyword search is
 * the half that must NEVER be down.
 */

describe("ftsQuery", () => {
  it("quotes every term and makes it a prefix match, OR-joined", () => {
    expect(ftsQuery("auth middleware")).toBe(`"auth"* OR "middleware"*`);
    expect(ftsQuery("Intl.DateTimeFormat")).toBe(`"intl.datetimeformat"*`);
  });

  it("tokens can never carry FTS syntax — quotes and operators vanish at tokenization", () => {
    expect(ftsQuery('say "hi"')).toBe(`"say"* OR "hi"*`);
    expect(ftsQuery("what AND why NEAR(x)")).not.toContain(" NEAR");
    expect(ftsQuery("test-query")).toBe(`"test-query"*`);
    expect(ftsQuery("a ? b")).toBeNull(); // 1-char tokens are dropped, ? is not a token
  });

  it("returns null for a query with no usable terms — callers treat as no-results", () => {
    expect(ftsQuery("")).toBeNull();
    expect(ftsQuery("!?!?")).toBeNull();
    expect(ftsQuery("a")).toBeNull(); // single letters are dropped (length > 1)
  });

  it("falls back to raw tokens when the query is ALL stopwords — search never silently empties", () => {
    expect(ftsQuery("the what")).toBe(`"the"* OR "what"*`);
  });
});

describe("tokenize / queryTerms", () => {
  it("keeps identifiers whole — the high-signal terms in developer memory", () => {
    expect(tokenize("use Intl.DateTimeFormat for next_step here-now")).toEqual([
      "use",
      "intl.datetimeformat",
      "for",
      "next_step",
      "here-now",
    ]);
  });

  it("strips stopwords from queries but keeps signal words", () => {
    expect(queryTerms("what did we decide about auth")).toEqual(["decide", "auth"]);
  });
});

describe("bm25Rank (the no-FTS5 fallback)", () => {
  const docs = [
    { haystack: "Password hashing uses argon2id for auth" },
    { haystack: "CSS grid layout conventions for the dashboard" },
    { haystack: "argon2id benchmark results versus bcrypt" },
  ];

  it("ranks matching docs best-first and normalizes to 0..1", () => {
    const ranked = bm25Rank(docs, "argon2id hashing", 3);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].score).toBeCloseTo(1, 10);
    expect(docs[ranked[0].index].haystack).toContain("argon2id");
  });

  it("prefix-matches, mirroring the FTS5 \"term\"* behaviour", () => {
    const ranked = bm25Rank(docs, "hashin", 3);
    expect(ranked.some(({ index }) => docs[index].haystack.includes("hashing"))).toBe(true);
  });

  it("returns [] when nothing matches — no participation trophies", () => {
    expect(bm25Rank(docs, "kubernetes gibberish", 3)).toEqual([]);
  });

  it("normalizeBm25 maps SQLite's negative-is-better scores to 0..1", () => {
    expect(normalizeBm25([-2.0, -1.0, 0])).toEqual([1, 0.5, 0]);
    expect(normalizeBm25([0, 0])).toEqual([0, 0]);
  });
});

describe("handoffSearchBody", () => {
  it("indexes the distilled meaning of the note, not the transcript it replaced", () => {
    const note: HandoffNote = {
      goal: "ship the export feature",
      decisions: [{ what: "marker-based replace", why: "bounded files" }],
      currentState: "half done",
      openTodos: ["write tests"],
      filesTouched: [],
      gotchas: ["FTS5 has no upsert"],
      nextStep: "test the markers",
    };
    const body = handoffSearchBody(note);
    for (const needle of ["ship the export feature", "marker-based replace: bounded", "write tests", "FTS5 has no upsert"]) {
      expect(body).toContain(needle);
    }
  });
});
