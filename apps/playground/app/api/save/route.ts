import { type NextRequest } from "next/server";
import { withSession, PROJECT } from "@/lib/session";

export const runtime = "nodejs";

const MAX_TRANSCRIPT = 40_000; // cap so a pasted wall of text can't blow the budget

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const transcript = String(body.transcript ?? "").slice(0, MAX_TRANSCRIPT);
  const session = typeof body.session === "string" ? body.session : "main";

  return withSession(req, async ({ engine }) => {
    if (!transcript.trim()) return { error: "nothing to save" };
    const result = await engine.save({ project: PROJECT, session, transcript });
    return {
      mode: result.mode,
      factsExtracted: result.factsExtracted,
      snapshotId: result.snapshotId,
      warning: result.warning ?? null,
    };
  });
}
