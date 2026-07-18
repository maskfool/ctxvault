/**
 * vector.ts — tiny vector math for semantic search.
 *
 * cosineSimilarity measures the ANGLE between two embedding vectors, ignoring
 * their length. Two texts that "mean the same thing" point the same direction,
 * so their cosine is near 1 even if the words differ ("auth flow" ↔ "login
 * handling"). That is exactly what a keyword LIKE match cannot do.
 */
export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function magnitude(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  const denom = magnitude(a) * magnitude(b);
  return denom === 0 ? 0 : dot(a, b) / denom;
}

/**
 * recencyDecay — exponential half-life decay. A memory saved `ageDays` ago is
 * worth `0.5 ^ (ageDays / halfLifeDays)`. Newer memories score higher without
 * ever fully erasing old ones.
 */
export function recencyDecay(ageDays: number, halfLifeDays = 3): number {
  return Math.pow(0.5, ageDays / halfLifeDays);
}
