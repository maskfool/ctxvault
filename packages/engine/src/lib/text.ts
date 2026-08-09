/**
 * lib/text.ts — keyword-search plumbing shared by both storage adapters.
 *
 * v2 makes BM25 the DEFAULT search path (embeddings became an optional upgrade),
 * so the query the agent types has to survive the trip into an FTS5 expression
 * without exploding. Agents write natural language — "what did we decide about
 * auth middleware?" — which is not valid FTS5 syntax: bare `?`, `AND`, `NEAR`,
 * quotes and hyphens are all operators or syntax errors there.
 *
 * So we never pass user text to FTS5 raw. We tokenize it ourselves, quote every
 * term (making it a literal), add a prefix `*` so "middlewar" still finds
 * "middleware", and OR them together — recall first, then let the ranker sort it
 * out. That's the right bias here: the retriever re-scores everything anyway.
 */

import type { HandoffNote } from "../types.js";

/**
 * The searchable prose of a handoff. A HandoffNote is far more searchable than
 * the raw transcript it came from (it's the distilled meaning), so both indexes
 * — keyword and vector — index THIS rather than the transcript. Shared so the
 * two never drift apart, which would make a doc findable by one and not the other.
 */
export function handoffSearchBody(note: HandoffNote): string {
  return [
    note.goal,
    note.currentState,
    note.nextStep,
    ...note.decisions.map((d) => `${d.what}: ${d.why}`),
    ...note.openTodos,
    ...note.gotchas,
  ].join("\n");
}

/** Words too common to carry signal — they'd match every document. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for",
  "with", "we", "i", "you", "it", "is", "are", "was", "were", "be", "been",
  "do", "did", "does", "what", "which", "who", "how", "why", "when", "where",
  "about", "that", "this", "there", "here", "our", "my", "me", "us", "have",
  "has", "had", "not", "no", "yes", "can", "could", "should", "would", "will",
]);

/**
 * Split text into lowercase search terms. Keeps `.` and `_` inside words so
 * identifiers survive whole ("Intl.DateTimeFormat", "next_step"), because those
 * are exactly the high-signal terms in a developer's memory.
 */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? []).filter(
    (t) => t.length > 1,
  );
}

/** Query terms: tokens minus stopwords. Falls back to the raw tokens if the
 *  query was ALL stopwords, so a search never silently becomes empty. */
export function queryTerms(query: string): string[] {
  const all = tokenize(query);
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  return meaningful.length ? meaningful : all;
}

/**
 * Build an FTS5 MATCH expression: `"auth"* OR "middleware"*`.
 * Returns null when the query has no usable terms — callers must treat that as
 * "no results" rather than running an empty MATCH (which is a syntax error).
 */
export function ftsQuery(query: string): string | null {
  const terms = queryTerms(query);
  if (!terms.length) return null;
  // Double quotes are the only character that can escape a quoted FTS5 string,
  // and they escape by doubling. Everything else inside quotes is a literal.
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
}

/**
 * Turn raw BM25 output into a 0..1 score where 1 is the best hit in this result
 * set. SQLite's bm25() returns NEGATIVE numbers (more negative = better match),
 * and its absolute scale depends on the corpus, so it is only meaningful
 * relative to the other hits for the same query — which is precisely what the
 * hybrid blend needs it to be.
 */
export function normalizeBm25(rawScores: number[]): number[] {
  const positives = rawScores.map((s) => Math.max(0, -s));
  const max = Math.max(...positives, 0);
  if (max === 0) return positives.map(() => 0);
  return positives.map((p) => p / max);
}

// ---------------------------------------------------------------------------
// A small BM25 implementation, for the two places SQLite's FTS5 isn't there:
// the in-memory adapter (the hosted playground) and the rare better-sqlite3
// build compiled without FTS5. Same ranking function, ~40 lines, no dependency —
// which is the point: keyword search must NEVER be the thing that's unavailable.
// ---------------------------------------------------------------------------
const K1 = 1.2; // term-frequency saturation
const B = 0.75; // length normalization

export interface RankableDoc {
  /** Searchable text, already concatenated (title + tags + body). */
  haystack: string;
}

/**
 * Score `docs` against `query`, returning {index, score} for matching docs only,
 * best first. Score is normalized to 0..1 within the result set, matching what
 * normalizeBm25 does for the FTS5 path so the two are interchangeable upstream.
 */
export function bm25Rank(
  docs: RankableDoc[],
  query: string,
  k: number,
): { index: number; score: number }[] {
  const terms = queryTerms(query);
  if (!terms.length || !docs.length) return [];

  const tokenized = docs.map((d) => tokenize(d.haystack));
  const lengths = tokenized.map((t) => t.length);
  const avgLen = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);

  // Document frequency per term, for IDF. A term in every doc carries no signal.
  const df = new Map<string, number>();
  for (const term of terms) {
    let n = 0;
    for (const toks of tokenized) if (toks.some((t) => t.startsWith(term))) n++;
    df.set(term, n);
  }

  const raw = tokenized.map((toks, i) => {
    let score = 0;
    for (const term of terms) {
      const n = df.get(term) ?? 0;
      if (n === 0) continue;
      // Prefix match, mirroring the `"term"*` we send to FTS5.
      const tf = toks.filter((t) => t.startsWith(term)).length;
      if (tf === 0) continue;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + (B * lengths[i]) / (avgLen || 1)));
      score += idf * norm;
    }
    return { index: i, score };
  });

  const max = Math.max(...raw.map((r) => r.score), 0);
  return raw
    .filter((r) => r.score > 0)
    .map((r) => ({ index: r.index, score: max ? r.score / max : 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
