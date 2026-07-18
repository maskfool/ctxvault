import { type NextRequest } from "next/server";
import { withSession, PROJECT } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const query = String(body.query ?? "").slice(0, 500);
  const k = Number.isFinite(body.k) ? Math.min(10, Number(body.k)) : 5;

  return withSession(req, async ({ engine }) => {
    if (!query.trim()) return { hits: [] };
    const hits = await engine.search(PROJECT, query, k);
    return {
      hits: hits.map((h) => ({
        kind: h.kind,
        refId: h.refId,
        filePath: h.filePath,
        text: h.text,
        score: h.score,
        similarity: h.similarity,
        createdAt: h.createdAt,
      })),
    };
  });
}
