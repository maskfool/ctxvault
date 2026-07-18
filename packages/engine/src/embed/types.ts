/**
 * embed/types.ts — the embedder seam.
 *
 * An embedder turns text into a fixed-length vector of floats. Texts that "mean
 * the same thing" land near each other, which is what powers semantic search
 * (cosine similarity in lib/vector.ts).
 *
 * Same seam pattern as LLM and StorageAdapter: the engine depends on THIS
 * interface, never on a concrete provider. Two implementations ship:
 *   - VercelEmbedder → hosted, real semantics, any provider the AI SDK reaches
 *                      (OpenAI, OpenRouter, Ollama — see ai/provider.ts).
 *   - LocalEmbedder  → deterministic hashing fallback, no key, no network.
 *
 * IMPORTANT invariant: the vectors you STORE and the query you SEARCH with must
 * come from the SAME embedder — different embedders produce different dimensions
 * and different geometry, so their cosine is meaningless. cosineSimilarity guards
 * against a length mismatch (returns 0) so this degrades safely rather than
 * crashing, but for good results keep one embedder per vault.
 */
export interface Embedder {
  /** A stable name, e.g. "openai:text-embedding-3-small" or "local-hash-256". */
  readonly id: string;
  /** The dimensionality of the vectors this embedder produces. */
  readonly dimensions: number;
  /** Embed a batch of texts. Returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Convenience: embed a single string. */
export async function embedOne(embedder: Embedder, text: string): Promise<number[]> {
  const [vec] = await embedder.embed([text]);
  return vec;
}
