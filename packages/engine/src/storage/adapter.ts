import type {
  NewSnapshot,
  NewTextDoc,
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
 *   - MemoryAdapter  → Vercel playground, per-session in-memory.
 *
 * There are two search methods because there are two indexes over the same
 * documents: `searchText` (keyword, always available) and `search` (cosine, only
 * when the user configured an embedding model). An adapter must implement both;
 * the engine blends whatever comes back.
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

  // --- keyword search (always available: no key, no network) ---
  /** Upsert by (project, kind, refId) into the full-text index. */
  indexText(doc: NewTextDoc): Promise<void>;
  /**
   * BM25 top-k over the text index. `lexical` on each hit is normalized to
   * 0..1 within the result set so it can blend with cosine (see retriever.ts).
   */
  searchText(project: string, query: string, k: number): Promise<SearchHit[]>;

  // --- vector search (optional: only when an embedding model is configured) ---
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
