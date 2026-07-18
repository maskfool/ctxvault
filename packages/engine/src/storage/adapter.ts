import type {
  NewSnapshot,
  NewVector,
  SearchHit,
  Session,
  Snapshot,
  StoredFact,
} from "../types.js";

/**
 * StorageAdapter — the seam that makes "one engine, two front doors" possible.
 *
 * The engine only ever calls THIS interface. It never imports SQLite or HTTP.
 * Swap the implementation and the same memory logic runs anywhere:
 *   - SqliteAdapter  → local CLIs (Claude Code, Codex), durable on disk.
 *   - MemoryAdapter  → Vercel playground, per-session in-memory (Phase 2).
 *
 * Phase 1 only exercises: saveSnapshot, getLatest, listSessions.
 * The vector/fact methods exist now so the interface is stable; their Phase-2
 * callers just weren't written yet.
 */
export interface StorageAdapter {
  // --- snapshots (episodic) ---
  saveSnapshot(input: NewSnapshot): Promise<Snapshot>;
  /** Newest snapshot for a project; scoped to one session when given. */
  getLatest(project: string, session?: string): Promise<Snapshot | null>;
  listSnapshots(project: string, limit?: number): Promise<Snapshot[]>;

  // --- facts (semantic / OKF) ---
  saveFact(fact: StoredFact): Promise<StoredFact>; // upsert by (project, slug)
  listFacts(project: string): Promise<StoredFact[]>;

  // --- vectors (search) ---
  /** Upsert by (project, kind, refId): re-saving a fact/handoff replaces its vector. */
  saveVector(vec: NewVector): Promise<void>;
  /**
   * Cosine top-k. `embedder` filters to vectors produced by that embedder —
   * comparing across embedders (or dimensions) is meaningless.
   */
  search(
    project: string,
    queryEmbedding: number[],
    k: number,
    embedder?: string,
  ): Promise<SearchHit[]>;

  // --- sessions ---
  listSessions(project: string): Promise<Session[]>;

  // --- lifecycle ---
  close(): Promise<void>;
}
