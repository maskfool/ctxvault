import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { EmbeddingModel, LanguageModel } from "ai";

/**
 * ai/provider.ts — the PROVIDER seam.
 *
 * Everything model-shaped in CtxVault goes through the Vercel AI SDK, so the
 * engine never depends on one vendor's SDK. A model is named by a single string:
 *
 *     "<provider>:<model-id>"
 *
 *     anthropic:claude-opus-4-8
 *     openai:gpt-5.1
 *     openrouter:anthropic/claude-opus-4.1     ← one key, hundreds of models
 *     compatible:llama3.1                      ← anything OpenAI-shaped
 *
 * That string is all a user sets (CTXVAULT_MODEL / CTXVAULT_EMBED_MODEL), which
 * is why switching from Claude to GPT to an OpenRouter model to a local Ollama
 * server is an env var and not a code change.
 *
 * "compatible" is the escape hatch: point CTXVAULT_BASE_URL at any OpenAI-shaped
 * endpoint (Ollama, Groq, Together, vLLM, LM Studio) and it works with no new
 * dependency, because virtually every inference server speaks that dialect.
 */

export const DEFAULT_MODEL = "anthropic:claude-opus-4-8";
export const DEFAULT_EMBED_MODEL = "openai:text-embedding-3-small";

export type ProviderId = "anthropic" | "openai" | "openrouter" | "compatible";

/** Which env var holds the key for each provider. */
const KEY_ENV: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  compatible: "CTXVAULT_API_KEY",
};

export interface ModelRef {
  provider: ProviderId;
  modelId: string;
}

/**
 * Split "provider:model-id" into its parts.
 *
 * Only the FIRST colon separates — OpenRouter ids contain slashes but the model
 * id itself may contain colons too (e.g. "ollama" tags like "llama3.1:8b"), so
 * we must not split on every colon.
 */
export function parseModelRef(ref: string): ModelRef {
  const idx = ref.indexOf(":");
  if (idx === -1) {
    throw new Error(
      `Invalid model ref "${ref}". Expected "<provider>:<model-id>", e.g. "anthropic:claude-opus-4-8".`,
    );
  }
  const provider = ref.slice(0, idx).trim() as ProviderId;
  const modelId = ref.slice(idx + 1).trim();
  if (!(provider in KEY_ENV)) {
    throw new Error(
      `Unknown provider "${provider}". Supported: ${Object.keys(KEY_ENV).join(", ")}.`,
    );
  }
  if (!modelId) throw new Error(`Model ref "${ref}" is missing a model id.`);
  return { provider, modelId };
}

/** The configured chat/summarizer model ref (env-overridable). */
export function languageModelRef(): string {
  return process.env.CTXVAULT_MODEL || DEFAULT_MODEL;
}

/** The configured embedding model ref (env-overridable). */
export function embeddingModelRef(): string {
  return process.env.CTXVAULT_EMBED_MODEL || DEFAULT_EMBED_MODEL;
}

/**
 * True when the provider behind `ref` has a key available. Callers use this to
 * decide between the real path and the honest degraded path — CtxVault's rule is
 * that a missing key never shows the user a dead button.
 */
export function hasApiKey(ref: string): boolean {
  try {
    const { provider } = parseModelRef(ref);
    // Local/self-hosted servers usually ignore the key, so what makes a
    // "compatible" model usable is the base URL, not a secret.
    if (provider === "compatible") return Boolean(process.env.CTXVAULT_BASE_URL);
    return Boolean(process.env[KEY_ENV[provider]]);
  } catch {
    return false; // an unparseable ref is as good as no key
  }
}

/**
 * True when `ref` can actually produce embeddings. Stricter than `hasApiKey`,
 * because a key is necessary but not sufficient: Anthropic ships no embeddings
 * endpoint, so `anthropic:*` is never embeddable no matter how many keys are set.
 * Callers use this to choose between the real embedder and LocalEmbedder.
 */
export function canEmbed(ref = embeddingModelRef()): boolean {
  try {
    const { provider } = parseModelRef(ref);
    if (provider === "anthropic") return false;
    if (provider === "compatible") return Boolean(process.env.CTXVAULT_BASE_URL);
    return Boolean(process.env[KEY_ENV[provider]]);
  } catch {
    return false;
  }
}

/**
 * Read a provider's key ourselves rather than relying on the SDK's own env
 * fallback. Each provider looks up a different variable internally; doing it
 * here keeps the key→provider mapping single-sourced in KEY_ENV and makes the
 * behaviour identical across bundlers (Next inlines static `process.env.X`
 * reads, so a provider's internal dynamic lookup is not always equivalent).
 */
function apiKeyFor(provider: ProviderId): string | undefined {
  return process.env[KEY_ENV[provider]] || undefined;
}

export function resolveLanguageModel(ref = languageModelRef()): LanguageModel {
  const { provider, modelId } = parseModelRef(ref);
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: apiKeyFor("anthropic") })(modelId);
    case "openai":
      return createOpenAI({ apiKey: apiKeyFor("openai") })(modelId);
    case "openrouter":
      return createOpenRouter({
        apiKey: apiKeyFor("openrouter"),
        compatibility: "strict",
      }).chat(modelId);
    case "compatible":
      // `.chat`, NOT the provider's default: `createOpenAI()(id)` returns a
      // Responses-API model, and third-party servers (Ollama, Groq, vLLM, LM
      // Studio) implement /chat/completions only. Responses would 404 on all
      // of them, which is exactly the case this provider exists to serve.
      return compatibleProvider().chat(modelId);
  }
}

export function resolveEmbeddingModel(ref = embeddingModelRef()): EmbeddingModel {
  const { provider, modelId } = parseModelRef(ref);
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey: apiKeyFor("openai") }).embeddingModel(modelId);
    case "openrouter":
      return createOpenRouter({ apiKey: apiKeyFor("openrouter") }).textEmbeddingModel(modelId);
    case "compatible":
      return compatibleProvider().embeddingModel(modelId);
    case "anthropic":
      // Anthropic ships no embeddings endpoint. This is exactly why the embed
      // model is configured separately from the chat model.
      throw new Error(
        "Anthropic has no embeddings API. Set CTXVAULT_EMBED_MODEL to an " +
          "openai:, openrouter:, or compatible: model (or leave it unset to use " +
          "the local fallback embedder).",
      );
  }
}

/**
 * Any OpenAI-shaped endpoint. `createOpenAI` with a custom baseURL is the whole
 * trick — the API key is optional because local servers usually ignore it.
 */
function compatibleProvider() {
  const baseURL = process.env.CTXVAULT_BASE_URL;
  if (!baseURL) {
    throw new Error(
      'The "compatible" provider needs CTXVAULT_BASE_URL, e.g. http://localhost:11434/v1 for Ollama.',
    );
  }
  return createOpenAI({
    baseURL,
    apiKey: apiKeyFor("compatible") ?? "not-needed",
    name: "compatible",
  });
}
