/**
 * index.ts — the engine's public surface.
 *
 * Everything the MCP server, the CLI and the playground are allowed to import
 * comes from here. Keeping this file curated means we can refactor internals
 * freely.
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
export {
  handoffToMarkdown,
  handoffPath,
  writeHandoffFile,
  readHandoffFile,
  listHandoffFiles,
  listProjectDirs,
} from "./okf/handoff.js";
export { slugify } from "./lib/slug.js";
export { CtxEngine } from "./engine.js";
export type {
  SaveInput,
  SaveResult,
  ResumeInput,
  ResumeResult,
  ExportInput,
} from "./engine.js";
export type { Embedder } from "./embed/types.js";
export { embedOne } from "./embed/types.js";
export { VercelEmbedder } from "./embed/vercel.js";
export {
  DEFAULT_EMBED_MODEL,
  embeddingModelRef,
  canEmbed,
  parseModelRef,
  resolveEmbeddingModel,
} from "./ai/provider.js";
export type { ProviderId, ModelRef } from "./ai/provider.js";
export {
  START_MARKER,
  END_MARKER,
  upsertSection,
  writeHarnessFile,
} from "./export/harness.js";
export type { HarnessTarget, HarnessWriteResult } from "./export/harness.js";
export { blendHits, rankHits } from "./retriever.js";
export { cosineSimilarity, recencyDecay } from "./lib/vector.js";
export { estimateTokens } from "./lib/tokens.js";
