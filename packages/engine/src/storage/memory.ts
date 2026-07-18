import { randomUUID } from "node:crypto";
import type { StorageAdapter } from "./adapter.js";
import type {
  NewSnapshot,
  NewVector,
  SearchHit,
  Session,
  Snapshot,
  StoredFact,
} from "../types.js";
import { cosineSimilarity } from "../lib/vector.js";

/**
 * memory.ts — the in-memory implementation of StorageAdapter.
 *
 * This is the SECOND front door's storage: on Vercel the filesystem is
 * ephemeral and each request is stateless, so the hosted playground keeps one
 * MemoryAdapter per judge session (keyed by a cookie) and says so on the page.
 *
 * The payoff of the interface work: this file is ~100 lines of Maps and arrays,
 * yet the *entire* engine — summarizer, embedder, retriever, OKF facts — runs on
 * top of it unchanged. "Same engine, only the transport differs." Facts have no
 * files here (filePath stays null); the Vault UI renders them from these rows.
 */
export class MemoryAdapter implements StorageAdapter {
  private snapshots: Snapshot[] = [];
  private facts = new Map<string, StoredFact>(); // key: `${project}::${slug}`
  private vectors: (NewVector & { createdAt: string })[] = [];

  async saveSnapshot(input: NewSnapshot): Promise<Snapshot> {
    const snap: Snapshot = {
      id: randomUUID(),
      project: input.project,
      session: input.session,
      createdAt: new Date().toISOString(),
      rawTranscript: input.rawTranscript,
      handoffNote: input.handoffNote ?? null,
    };
    this.snapshots.push(snap);
    return snap;
  }

  async getLatest(project: string, session?: string): Promise<Snapshot | null> {
    const forProject = this.snapshots.filter(
      (s) => s.project === project && (!session || s.session === session),
    );
    return forProject.length ? forProject[forProject.length - 1] : null;
  }

  async listSnapshots(project: string, limit = 20): Promise<Snapshot[]> {
    return this.snapshots
      .filter((s) => s.project === project)
      .slice(-limit)
      .reverse();
  }

  async saveFact(fact: StoredFact): Promise<StoredFact> {
    // No file on disk here — filePath stays null. Upsert by (project, slug).
    this.facts.set(`${fact.project}::${fact.slug}`, fact);
    return fact;
  }

  async listFacts(project: string): Promise<StoredFact[]> {
    return [...this.facts.values()]
      .filter((f) => f.project === project)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveVector(vec: NewVector): Promise<void> {
    // Upsert by (project, kind, refId) — mirrors the SQLite unique index.
    const i = this.vectors.findIndex(
      (v) => v.project === vec.project && v.kind === vec.kind && v.refId === vec.refId,
    );
    const stored = { ...vec, createdAt: new Date().toISOString() };
    if (i >= 0) this.vectors[i] = stored;
    else this.vectors.push(stored);
  }

  async search(
    project: string,
    queryEmbedding: number[],
    k: number,
    embedder?: string,
  ): Promise<SearchHit[]> {
    const hits: SearchHit[] = this.vectors
      .filter((v) => v.project === project && (!embedder || v.embedder === embedder))
      .map((v) => {
        const similarity = cosineSimilarity(queryEmbedding, v.embedding);
        return {
          project: v.project,
          kind: v.kind,
          refId: v.refId,
          filePath: v.filePath,
          text: v.text,
          createdAt: v.createdAt,
          similarity,
          score: similarity,
        };
      });
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  async listSessions(project: string): Promise<Session[]> {
    const bySession = new Map<string, Snapshot[]>();
    for (const s of this.snapshots.filter((s) => s.project === project)) {
      const list = bySession.get(s.session) ?? [];
      list.push(s);
      bySession.set(s.session, list);
    }
    return [...bySession.entries()]
      .map(([session, snaps]) => {
        const times = snaps.map((s) => s.createdAt).sort();
        return {
          project,
          session,
          createdAt: times[0],
          updatedAt: times[times.length - 1],
          snapshotCount: snaps.length,
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async close(): Promise<void> {
    // Nothing to close — state lives in memory.
  }
}
