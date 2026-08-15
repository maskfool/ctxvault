import { describe, expect, it } from "vitest";
import { blendHits } from "../src/retriever.js";
import { recencyDecay } from "../src/lib/vector.js";
import type { SearchHit } from "../src/types.js";

/**
 * The retriever's blend is the ranking contract: hybrid 0.45·lex + 0.30·sim +
 * 0.25·recency, keyword-only 0.70·lex + 0.30·recency. The SPEC quotes these
 * numbers to users — a change here is a product decision, not a refactor, and
 * these tests are what makes an accidental change visible.
 */

const NOW = new Date("2026-08-15T12:00:00.000Z");

const hit = (over: Partial<SearchHit>): SearchHit => ({
  project: "p",
  kind: "fact",
  refId: "x",
  filePath: null,
  text: "",
  createdAt: NOW.toISOString(),
  score: 0,
  similarity: 0,
  lexical: 0,
  ...over,
});

describe("blendHits", () => {
  it("keyword-only: 0.70·lexical + 0.30·recency", () => {
    const fresh = hit({ lexical: 1, refId: "fresh" }); // age 0 → recency 1
    const [ranked] = blendHits([fresh], [], NOW);
    expect(ranked.score).toBeCloseTo(0.7 * 1 + 0.3 * 1, 10);
  });

  it("hybrid: 0.45·lexical + 0.30·similarity + 0.25·recency", () => {
    const fresh = hit({ lexical: 1, similarity: 0.8, refId: "both" });
    const [ranked] = blendHits([fresh], [fresh], NOW);
    expect(ranked.score).toBeCloseTo(0.45 * 1 + 0.3 * 0.8 + 0.25 * 1, 10);
  });

  it("a doc found by BOTH indexes keeps both scores and beats either half alone", () => {
    const both = hit({ lexical: 0.8, similarity: 0.8, refId: "both" });
    const lexOnly = hit({ lexical: 1.0, refId: "lex" });
    const semOnly = hit({ similarity: 1.0, refId: "sem" });

    const ranked = blendHits([both, lexOnly], [both, semOnly], NOW);
    expect(ranked[0].refId).toBe("both");
    // Both halves agree — the strongest signal available.
    expect(ranked[0].lexical).toBe(0.8);
    expect(ranked[0].similarity).toBe(0.8);
  });

  it("recency tilts without burying: 3-day half-life, never fully zero", () => {
    expect(recencyDecay(0)).toBe(1);
    expect(recencyDecay(3)).toBeCloseTo(0.5, 10);
    expect(recencyDecay(30)).toBeGreaterThan(0);

    // 14 days old → recency ≈ 0.037. Old perfect match ≈ 0.711, fresh
    // 0.6-lexical match ≈ 0.72 — recency tilts the ranking to the fresh one…
    const old = hit({ lexical: 1, refId: "old", createdAt: "2026-08-01T12:00:00.000Z" }); // 14 days
    const newButWeaker = hit({ lexical: 0.6, refId: "new" });
    const ranked = blendHits([old, newButWeaker], [], NOW);
    expect(ranked[0].refId).toBe("new");
    // …but never buries: the old match still ranks, decayed not deleted.
    expect(ranked[1].refId).toBe("old");
    expect(ranked[1].score).toBeGreaterThan(0.7);
    expect(ranked[1].score).toBeLessThan(0.72);
  });

  it("an unparseable timestamp is treated as very old, not as NaN poison", () => {
    const weird = hit({ lexical: 1, refId: "w", createdAt: "not-a-date" });
    const [ranked] = blendHits([weird], [], NOW);
    expect(Number.isFinite(ranked.score)).toBe(true);
    // decay(9999 days) underflows to 0 → the score collapses to the lexical
    // share exactly, which is the honest outcome for an unknown timestamp.
    expect(ranked.score).toBeCloseTo(0.7, 10);
  });
});
