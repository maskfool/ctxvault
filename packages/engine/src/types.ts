import { z } from "zod";

/**
 * types.ts — the shared data shapes for the whole engine.
 *
 * Two kinds of shape live here:
 *  1. zod schemas  → used to VALIDATE untrusted data (LLM JSON output, tool args).
 *  2. TS interfaces → used to describe rows we store/read.
 *
 * The LLM-facing shapes (HandoffNote, Fact) are zod schemas because in Phase 2 an
 * LLM produces them and we must not trust its JSON blindly — we parse + retry.
 */

// ---------------------------------------------------------------------------
// HandoffNote — the "episodic memory". A structured summary of one work session.
// This is what makes `resume` feel like the other tool "was there".
// ---------------------------------------------------------------------------
export const DecisionSchema = z.object({
  what: z.string(),
  why: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const HandoffNoteSchema = z.object({
  goal: z.string(),
  decisions: z.array(DecisionSchema).default([]),
  currentState: z.string(),
  openTodos: z.array(z.string()).default([]),
  filesTouched: z.array(z.string()).default([]),
  gotchas: z.array(z.string()).default([]),
  nextStep: z.string(),
});
export type HandoffNote = z.infer<typeof HandoffNoteSchema>;

// ---------------------------------------------------------------------------
// Fact — the "semantic memory". A durable, human-editable piece of knowledge,
// stored on disk as an OKF markdown file: knowledge/<project>/<slug>.md
// ---------------------------------------------------------------------------
export const FactTypeSchema = z.enum([
  "decision",
  "convention",
  "architecture",
  "gotcha",
  "reference",
  "requirement",
]);
export type FactType = z.infer<typeof FactTypeSchema>;

export const FactSchema = z.object({
  slug: z.string(), // stable id → filename. Same slug = overwrite (no merge).
  type: FactTypeSchema,
  title: z.string(),
  body: z.string(), // < 150 words
  tags: z.array(z.string()).default([]),
});
export type Fact = z.infer<typeof FactSchema>;

/** The fact extractor returns an array of these — validated in one shot. */
export const FactsArraySchema = z.array(FactSchema);

// A Fact once persisted: carries where it lives + when it was written.
export interface StoredFact extends Fact {
  project: string;
  filePath: string | null; // set when written as an OKF file, null if SQLite-only
  updatedAt: string; // ISO
  session: string;
}

// ---------------------------------------------------------------------------
// Snapshot — one SAVE. In Phase 1 this is just the raw transcript. In Phase 2 it
// also carries the derived HandoffNote.
// ---------------------------------------------------------------------------
export interface Snapshot {
  id: string;
  project: string;
  session: string;
  createdAt: string; // ISO
  rawTranscript: string;
  handoffNote: HandoffNote | null;
}

export interface NewSnapshot {
  project: string;
  session: string;
  rawTranscript: string;
  handoffNote?: HandoffNote | null;
}

// ---------------------------------------------------------------------------
// Session — a distinct working thread inside a project.
// ---------------------------------------------------------------------------
export interface Session {
  project: string;
  session: string;
  createdAt: string;
  updatedAt: string;
  snapshotCount: number;
}

// ---------------------------------------------------------------------------
// Vectors — embeddings for semantic search (Phase 2).
// ---------------------------------------------------------------------------
export type VectorKind = "handoff" | "fact";

export interface NewVector {
  project: string;
  kind: VectorKind;
  refId: string; // snapshot id or fact slug
  filePath: string | null; // OKF path for facts
  text: string; // the text that was embedded (returned in results)
  embedding: number[];
  /**
   * Which embedder produced this vector (e.g. "local-hash-256", "openai:text-embedding-3-small").
   * Search only compares vectors from the SAME embedder: cosine between vectors
   * from different models (or different dimensions) is meaningless, and silently
   * mixing them makes old memory vanish from results the day a user adds an API key.
   */
  embedder: string;
}

export interface SearchHit {
  project: string;
  kind: VectorKind;
  refId: string;
  filePath: string | null;
  text: string;
  createdAt: string; // when the vector was stored — the retriever weights by recency
  score: number; // final ranked score
  similarity: number; // raw cosine, for debugging
}
