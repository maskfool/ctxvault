/**
 * web.ts — the WEB-SAFE public surface of the engine.
 *
 * The main index.ts barrel pulls in SqliteAdapter (→ better-sqlite3, a native
 * module), the OKF writer and the harness-file writer (→ node:fs). None of that
 * belongs in a Vercel serverless bundle. The hosted playground imports from HERE
 * instead (`@ctxvault/engine/web`), getting only the pieces that run anywhere:
 *
 *   CtxEngine · MemoryAdapter · VercelEmbedder · provider helpers · types
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
  ExportInput,
} from "./engine.js";
export type { Embedder } from "./embed/types.js";
export { VercelEmbedder } from "./embed/vercel.js";
export { slugify, normalizeProject } from "./lib/slug.js";
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
export { blendHits, rankHits } from "./retriever.js";
