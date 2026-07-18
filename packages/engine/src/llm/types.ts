import type { Fact, HandoffNote } from "../types.js";

/**
 * llm/types.ts — the model seam.
 *
 * The engine depends on this interface, never on a model SDK directly. (The one
 * implementation, VercelLLM, is itself provider-agnostic via the Vercel AI SDK —
 * so this seam is about *whether* there's a model, not *which*.)
 * That gives us two things:
 *   1. `--no-ai` fallback — pass `null` for the LLM and save/resume degrade to
 *      raw text instead of showing a judge a dead button.
 *   2. Testability — a fake LLM can be injected without a network call or key.
 *
 * `summarize` produces episodic memory (Phase 2.1); `extractFacts` produces
 * semantic memory — the durable, human-readable OKF facts (Phase 2.3).
 */
export interface LLM {
  /** Turn a raw transcript into a structured HandoffNote (episodic memory). */
  summarize(transcript: string): Promise<HandoffNote>;

  /**
   * Pull durable, reusable knowledge out of a session — the facts worth keeping
   * long after this session ends (decisions, conventions, gotchas). Each becomes
   * an OKF markdown file. The HandoffNote (if any) is passed in as extra context.
   */
  extractFacts(transcript: string, note: HandoffNote | null): Promise<Fact[]>;
}
