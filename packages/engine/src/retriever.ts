import type { SearchHit } from "./types.js";
import { recencyDecay } from "./lib/vector.js";

/**
 * retriever.ts — turns raw matches into one ranked result list.
 *
 * Two things get blended here.
 *
 * RELEVANCE is hybrid. Keyword (BM25) is the default and always runs: it needs
 * no API key, and on this corpus — a few hundred short, titled, tagged notes
 * full of distinctive technical terms — exact term matching is genuinely strong.
 * Vector similarity runs ONLY when the user configured an embedding model, and
 * covers what keywords miss: the paraphrase ("date formatting library" vs a note
 * that says "Intl.DateTimeFormat"). We do not claim BM25 beats embeddings; we
 * claim it is the right *default*, and that a key upgrades search rather than
 * unlocking it.
 *
 * RECENCY then tilts the result. A slightly-worse match from an hour ago usually
 * beats a perfect match from three weeks back, so recencyDecay (3-day half-life)
 * contributes a share of the score without ever fully burying old memory.
 *
 *   hybrid:      score = 0.45·lexical + 0.30·similarity + 0.25·recency
 *   keyword-only: score = 0.70·lexical + 0.30·recency
 *
 * The keyword-only weights are the hybrid ones with the vector share folded back
 * into lexical, so turning embeddings on doesn't change what "a good score"
 * means by an order of magnitude.
 */
const W_LEXICAL_HYBRID = 0.45;
const W_SIMILARITY_HYBRID = 0.3;
const W_RECENCY = 0.3;
const W_LEXICAL_ONLY = 0.7;

/** Identity of a document across the two indexes. */
const keyOf = (h: SearchHit) => `${h.kind}::${h.refId}`;

/**
 * Merge keyword and vector hits into one ranked list.
 *
 * A document found by BOTH indexes keeps both scores and is rewarded by the
 * blend — that agreement is the strongest signal available, and it's the reason
 * hybrid retrieval outranks either half on its own.
 *
 * @param lexical  BM25 hits (lexical normalized 0..1). May be empty.
 * @param semantic Cosine hits. Empty when no embedding model is configured.
 */
export function blendHits(
  lexical: SearchHit[],
  semantic: SearchHit[],
  now = new Date(),
): SearchHit[] {
  const merged = new Map<string, SearchHit>();

  for (const h of lexical) merged.set(keyOf(h), { ...h });
  for (const h of semantic) {
    const existing = merged.get(keyOf(h));
    if (existing) existing.similarity = h.similarity;
    else merged.set(keyOf(h), { ...h });
  }

  // No embedding model → nothing to blend, so lexical carries the vector share.
  const hybrid = semantic.length > 0;
  const wLex = hybrid ? W_LEXICAL_HYBRID : W_LEXICAL_ONLY;
  const wSim = hybrid ? W_SIMILARITY_HYBRID : 0;
  const wRec = hybrid ? 1 - wLex - wSim : W_RECENCY;

  return [...merged.values()]
    .map((h) => ({
      ...h,
      score: wLex * h.lexical + wSim * h.similarity + wRec * recencyDecay(ageInDays(h.createdAt, now)),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Legacy single-index ranking, kept for callers that only have cosine hits.
 * Equivalent to blendHits(_, hits) for a vector-only result set.
 */
export function rankHits(hits: SearchHit[], now = new Date()): SearchHit[] {
  return blendHits([], hits, now);
}

function ageInDays(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 9999; // unknown timestamp → treat as very old
  const ms = now.getTime() - then;
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}
