import { embedMany, type EmbeddingModel } from "ai";
import type { Embedder } from "./types.js";
import { resolveEmbeddingModel, embeddingModelRef } from "../ai/provider.js";

/**
 * embed/vercel.ts — the hosted, real-semantics embedder.
 *
 * Provider-agnostic like the LLM: it holds an AI SDK EmbeddingModel, so the same
 * class covers OpenAI's text-embedding-3-small, an OpenRouter embedding model, or
 * a local Ollama model, selected by CTXVAULT_EMBED_MODEL.
 *
 * `embedMany` batches for us and respects the model's per-call limit, so callers
 * can hand it an arbitrarily long list.
 *
 * Keys never touch the client: they're read from the environment server-side. If
 * the call fails we throw; the engine catches and either skips indexing (on save)
 * or reports search unavailable (on search).
 */

/**
 * Known output sizes, so `dimensions` is honest before the first call. An unknown
 * model reports 0 until we've seen a real vector — nothing sizes storage off this
 * field, it's informational (shown in the MCP status line).
 */
const KNOWN_DIMS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
};

export class VercelEmbedder implements Embedder {
  readonly id: string;
  /** Mutable behind a readonly interface: learned from the first real response. */
  dimensions: number;
  private model: EmbeddingModel;

  constructor(opts: { model?: EmbeddingModel; ref?: string; dimensions?: number } = {}) {
    this.id = opts.ref ?? embeddingModelRef();
    this.model = opts.model ?? resolveEmbeddingModel(this.id);
    const modelId = this.id.slice(this.id.indexOf(":") + 1);
    this.dimensions = opts.dimensions ?? KNOWN_DIMS[modelId] ?? 0;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const { embeddings } = await embedMany({ model: this.model, values: texts });
    if (embeddings[0]) this.dimensions = embeddings[0].length;
    return embeddings;
  }
}
