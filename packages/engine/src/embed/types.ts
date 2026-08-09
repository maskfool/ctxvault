/**
 * embed/types.ts — the embedder seam.
 *
 * An embedder turns text into a fixed-length vector of floats. Texts that "mean
 * the same thing" land near each other, which is what powers semantic search
 * (cosine similarity in lib/vector.ts).
 *
 * Same seam pattern as StorageAdapter: the engine depends on THIS interface,
 * never on a concrete provider. One implementation ships — VercelEmbedder, which
 * reaches any provider the AI SDK does (OpenAI, OpenRouter, Ollama; see
 * ai/provider.ts).
 *
 * Since v2 an embedder is OPTIONAL. Keyword search (BM25, in the storage
 * adapter) is the default and needs no key, no network and no download; passing
 * an embedder adds vector similarity on top and the retriever blends the two.
 * So the question this seam answers is "is search hybrid today?", and the answer
 * being "no" costs recall on paraphrases — never the feature itself.
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
