import { z } from "zod";

/**
 * types.ts — the shared data shapes for the whole engine.
 *
 * Two kinds of shape live here:
 *  1. zod schemas  → used to VALIDATE untrusted data (tool args from an agent).
 *  2. TS interfaces → used to describe rows we store/read.
 *
 * HandoffNote and Fact are zod schemas because they arrive from OUTSIDE: since
 * v2 the calling agent authors them and passes them into `save_context`, so they
 * are untrusted input that must be parsed, not assumed. These same schemas are
 * what the MCP server advertises as its tool input schema — the agent fills the
 * form, we validate and store it. That is the whole v2 architecture in one line.
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

/** A batch of facts from one save — validated in one shot. */
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
// Search index. TWO indexes cover the same documents:
//
//   1. TEXT (FTS5/BM25)  — always on, no key, no network. The default.
//   2. VECTORS (cosine)  — only when the user has configured an embedding model.
//
// A document is identified by (project, kind, refId) in both, so results can be
// merged into one hybrid ranking (see retriever.ts).
// ---------------------------------------------------------------------------
export type VectorKind = "handoff" | "fact";

/** One document offered to the keyword index. Mirrors NewVector, minus the maths. */
export interface NewTextDoc {
  project: string;
  kind: VectorKind;
  refId: string; // snapshot id or fact slug
  filePath: string | null; // OKF path for facts
  /** Weighted highest at query time — the fact title or the handoff goal. */
  title: string;
  tags: string[];
  /** The searchable prose, and what search results display. */
  body: string;
}

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
  createdAt: string; // when the doc was indexed — the retriever weights by recency
  score: number; // final ranked score (hybrid blend)
  /** Raw cosine. 0 when the doc came from the keyword index only. */
  similarity: number;
  /** Normalized BM25 (1 = best keyword match in this result set). 0 when vector-only. */
  lexical: number;
}
