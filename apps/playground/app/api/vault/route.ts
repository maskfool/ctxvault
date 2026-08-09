import { type NextRequest } from "next/server";
import {
  withSession,
  PROJECT,
  aiEnabled,
  embeddingsEnabled,
  modelRef,
  embedRef,
} from "@/lib/session";

export const runtime = "nodejs";

/** The Vault panel's state: current handoff note, OKF facts, session list. */
export async function GET(req: NextRequest) {
  return withSession(req, async ({ engine }) => {
    const [latest, facts, sessions] = await Promise.all([
      engine.getLatest(PROJECT),
      engine.listFacts(PROJECT),
      engine.listSessions(PROJECT),
    ]);
    return {
      aiEnabled: aiEnabled(),
      model: aiEnabled() ? modelRef() : null,
      // Search is keyword (BM25) out of the box; an embedding model upgrades it
      // to hybrid. Neither is required for the vault to work.
      search: embeddingsEnabled() ? `hybrid (BM25 + ${embedRef()})` : "keyword (BM25)",
      note: latest?.handoffNote ?? null,
      savedAt: latest?.createdAt ?? null,
      facts: facts.map((f) => ({
        slug: f.slug,
        type: f.type,
        title: f.title,
        body: f.body,
        tags: f.tags,
        updatedAt: f.updatedAt,
      })),
      sessions,
    };
  });
}
