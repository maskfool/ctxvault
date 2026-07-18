import { generateObject, generateText, type LanguageModel } from "ai";
import { z } from "zod";
import type { LLM } from "./types.js";
import {
  HandoffNoteSchema,
  FactsArraySchema,
  FactTypeSchema,
  type HandoffNote,
  type Fact,
} from "../types.js";
import { slugify } from "../lib/slug.js";
import { resolveLanguageModel, languageModelRef } from "../ai/provider.js";
import {
  SUMMARIZER_SYSTEM,
  summarizerUser,
  CHUNK_SYSTEM,
  chunkUser,
  FACTS_SYSTEM,
  factsUser,
} from "./prompts.js";

/**
 * llm/vercel.ts — the real summarizer, backed by the Vercel AI SDK.
 *
 * Provider-agnostic by construction: it holds a LanguageModel, not a vendor
 * client, so the same class runs on Claude, GPT, an OpenRouter model, or a local
 * Ollama server. Which one is a config string (see ai/provider.ts).
 *
 * Strategy (straight from SPEC.md):
 *   1. If the transcript is huge (>20k chars), MAP-REDUCE: summarize each chunk
 *      into a short digest, then summarize the concatenated digests. This keeps
 *      a single call focused and bounds cost.
 *   2. Use `generateObject` for the structured calls. It hands the zod schema to
 *      the provider as a native structured-output/tool spec and validates the
 *      result, so the model is CONSTRAINED to the shape rather than merely asked
 *      for it. That replaces the old ask-for-JSON → strip-fences → parse → retry
 *      loop, and it's what makes weaker non-Claude models usable here.
 *   3. On failure `generateObject` throws after its own retries; the caller
 *      (engine) catches and falls back to raw storage.
 */
const MAP_REDUCE_THRESHOLD = 20_000; // chars
const CHUNK_SIZE = 15_000; // chars per map chunk

/**
 * Generation-time schemas. These mirror the canonical schemas in types.ts but
 * drop `.default([])`: a defaulted field is OPTIONAL in the generated JSON
 * schema, and providers running strict structured output (OpenAI) reject a
 * schema whose `required` list is incomplete. Every field is required here, and
 * `.describe()` text lands in the JSON schema the model actually sees — which is
 * how a small open model gets the same field semantics Claude infers from prose.
 */
const DecisionGenSchema = z.object({
  what: z.string().describe("The decision that was made."),
  why: z.string().describe("The reason it won."),
});

const HandoffNoteGenSchema = z.object({
  goal: z.string().describe("One sentence: what the user is ultimately trying to achieve."),
  decisions: z.array(DecisionGenSchema).describe("Concrete decisions and their reasons. Empty if none."),
  currentState: z.string().describe("Where things stand: what works, what is half-done, what is broken."),
  openTodos: z.array(z.string()).describe("Remaining tasks, most important first. Empty if none."),
  filesTouched: z.array(z.string()).describe("File paths created or edited. Empty if none mentioned."),
  gotchas: z.array(z.string()).describe("Traps and non-obvious constraints. Empty if none."),
  nextStep: z.string().describe("The single most useful next action. Specific and actionable."),
});

const FactGenSchema = z.object({
  slug: z
    .string()
    .describe(
      "Short stable kebab-case id derived from the title, e.g. 'password-hashing-argon2'. " +
        "The same knowledge must always produce the same slug so the file updates instead of duplicating.",
    ),
  type: FactTypeSchema.describe("The kind of durable knowledge this is."),
  title: z.string().describe("Short human-readable title."),
  body: z.string().describe("The fact, explained with its reasoning. Under 150 words."),
  tags: z.array(z.string()).describe("Short lowercase tags for grouping. Empty if none."),
});

export class VercelLLM implements LLM {
  private model: LanguageModel;
  /** Human-readable "provider:model-id", for logs and the status line. */
  readonly id: string;

  constructor(opts: { model?: LanguageModel; ref?: string } = {}) {
    this.id = opts.ref ?? languageModelRef();
    this.model = opts.model ?? resolveLanguageModel(this.id);
  }

  async summarize(transcript: string): Promise<HandoffNote> {
    const source = await this.condense(transcript);
    const { object } = await generateObject({
      model: this.model,
      schema: HandoffNoteGenSchema,
      schemaName: "HandoffNote",
      schemaDescription: "A structured handoff summary of one AI coding session.",
      maxOutputTokens: 2000,
      system: SUMMARIZER_SYSTEM,
      prompt: summarizerUser(source),
    });
    // Re-validate through the canonical schema: the generation schema is a
    // near-copy, and this is the one that the rest of the engine trusts.
    return HandoffNoteSchema.parse(object);
  }

  async extractFacts(transcript: string, note: HandoffNote | null): Promise<Fact[]> {
    const source = await this.condense(transcript);
    const noteJson = note ? JSON.stringify(note) : null;
    const { object } = await generateObject({
      model: this.model,
      output: "array",
      schema: FactGenSchema,
      schemaName: "Fact",
      schemaDescription: "A durable piece of project knowledge worth keeping after the session ends.",
      maxOutputTokens: 3000,
      system: FACTS_SYSTEM,
      prompt: factsUser(source, noteJson),
    });
    // Defensively slugify: the model's slug is untrusted and becomes a filename.
    const facts = FactsArraySchema.parse(object);
    return facts.map((f) => ({ ...f, slug: slugify(f.slug || f.title) }));
  }

  /** If the transcript is huge, map-reduce it to a digest; otherwise pass through. */
  private async condense(transcript: string): Promise<string> {
    return transcript.length > MAP_REDUCE_THRESHOLD
      ? this.mapReduce(transcript)
      : transcript;
  }

  /** MAP: digest each chunk. REDUCE happens back in summarize() over the joined digests. */
  private async mapReduce(transcript: string): Promise<string> {
    const chunks: string[] = [];
    for (let i = 0; i < transcript.length; i += CHUNK_SIZE) {
      chunks.push(transcript.slice(i, i + CHUNK_SIZE));
    }
    const digests = await Promise.all(
      chunks.map(async (c) => {
        const { text } = await generateText({
          model: this.model,
          maxOutputTokens: 400,
          system: CHUNK_SYSTEM,
          prompt: chunkUser(c),
        });
        return text.trim();
      }),
    );
    return digests
      .map((d, i) => `--- Part ${i + 1}/${digests.length} ---\n${d}`)
      .join("\n\n");
  }
}
