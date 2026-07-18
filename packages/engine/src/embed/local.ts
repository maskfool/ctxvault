import type { Embedder } from "./types.js";

/**
 * embed/local.ts — the zero-dependency fallback embedder.
 *
 * This is a "hashing vectorizer": tokenize text into words, hash each word into
 * one of D buckets, and accumulate a weight per bucket, then L2-normalize. Two
 * texts that share words point in a similar direction, so cosine similarity
 * still surfaces lexical overlap.
 *
 * Be honest about what this is: it captures WORD overlap, not MEANING. It will
 * NOT match "auth flow" ↔ "login handling" (no shared words) the way a real
 * embedding model does. Its job is to keep search alive with no API key and no
 * network — a graceful degrade, not a replacement for VercelEmbedder.
 */
const DIMS = 256;

export class LocalEmbedder implements Embedder {
  readonly id = `local-hash-${DIMS}`;
  readonly dimensions = DIMS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => embedText(t, this.dimensions));
  }
}

function embedText(text: string, dims: number): number[] {
  const vec = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  for (const tok of tokens) {
    // Down-weight very common short tokens so content words dominate.
    const weight = tok.length <= 2 ? 0.3 : 1;
    vec[hash(tok) % dims] += weight;
  }
  return l2normalize(vec);
}

/** FNV-1a — a fast, deterministic string hash. */
function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0; // unsigned
}

function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const mag = Math.sqrt(sum);
  if (mag === 0) return vec;
  return vec.map((v) => v / mag);
}
