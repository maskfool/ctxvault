/**
 * index.ts — the engine's public surface.
 *
 * Everything the MCP server and the playground are allowed to import comes from
 * here. Keeping this file curated means we can refactor internals freely.
 */
export * from "./types.js";
export type { StorageAdapter } from "./storage/adapter.js";
export { SqliteAdapter } from "./storage/sqlite.js";
export { MemoryAdapter } from "./storage/memory.js";
export {
  factToMarkdown,
  readOkfFile,
  writeOkfFile,
  listOkfFiles,
  okfPath,
} from "./okf/okf.js";
export { slugify } from "./lib/slug.js";
export { CtxEngine } from "./engine.js";
export type {
  SaveInput,
  SaveResult,
  ResumeInput,
  ResumeResult,
} from "./engine.js";
export type { LLM } from "./llm/types.js";
export { VercelLLM } from "./llm/vercel.js";
export type { Embedder } from "./embed/types.js";
export { embedOne } from "./embed/types.js";
export { VercelEmbedder } from "./embed/vercel.js";
export { LocalEmbedder } from "./embed/local.js";
export {
  DEFAULT_MODEL,
  DEFAULT_EMBED_MODEL,
  languageModelRef,
  embeddingModelRef,
  hasApiKey,
  canEmbed,
  parseModelRef,
  resolveLanguageModel,
  resolveEmbeddingModel,
} from "./ai/provider.js";
export type { ProviderId, ModelRef } from "./ai/provider.js";
export { rankHits } from "./retriever.js";
export { cosineSimilarity, recencyDecay } from "./lib/vector.js";
export { estimateTokens } from "./lib/tokens.js";
