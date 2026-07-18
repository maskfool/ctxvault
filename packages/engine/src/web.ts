/**
 * web.ts — the WEB-SAFE public surface of the engine.
 *
 * The main index.ts barrel pulls in SqliteAdapter (→ better-sqlite3, a native
 * module) and the OKF writer (→ gray-matter + node:fs). Neither belongs in a
 * Vercel serverless bundle. The hosted playground imports from HERE instead
 * (`@ctxvault/engine/web`), getting only the pieces that run anywhere:
 *
 *   CtxEngine · MemoryAdapter · VercelLLM · Local/Vercel embedders · types
 *
 * Same engine, no native deps — that's what lets the second front door deploy.
 */
export * from "./types.js";
export type { StorageAdapter } from "./storage/adapter.js";
export { MemoryAdapter } from "./storage/memory.js";
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
