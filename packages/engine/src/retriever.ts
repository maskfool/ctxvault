import type { SearchHit } from "./types.js";
import { recencyDecay } from "./lib/vector.js";

/**
 * retriever.ts — turns raw cosine matches into a ranked result list.
 *
 * Pure similarity isn't enough: a slightly-less-similar note from an hour ago is
 * usually more useful than a perfect match from three weeks back. So we blend
 * three signals (the weights come straight from SPEC.md):
 *
 *   score = 0.6·similarity + 0.3·recencyDecay(age, 3d) + 0.1·sameProjectBoost
 *
 * We search within a single project, so sameProjectBoost is a constant 0.1 here
 * (it exists in the formula for future cross-project search). recencyDecay has a
 * 3-day half-life: a note from 3 days ago contributes half what a fresh one does,
 * without ever fully vanishing.
 */
const W_SIMILARITY = 0.6;
const W_RECENCY = 0.3;
const W_SAME_PROJECT = 0.1;

export function rankHits(hits: SearchHit[], now = new Date()): SearchHit[] {
  return hits
    .map((h) => {
      const ageDays = ageInDays(h.createdAt, now);
      const recency = recencyDecay(ageDays);
      const score =
        W_SIMILARITY * h.similarity + W_RECENCY * recency + W_SAME_PROJECT * 1;
      return { ...h, score };
    })
    .sort((a, b) => b.score - a.score);
}

function ageInDays(iso: string, now: Date): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 9999; // unknown timestamp → treat as very old
  const ms = now.getTime() - then;
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}
