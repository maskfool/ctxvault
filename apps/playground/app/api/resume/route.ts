import { type NextRequest } from "next/server";
import { withSession, PROJECT } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const budget = Number.isFinite(body.budget) ? Number(body.budget) : 4000;

  return withSession(req, async ({ engine }) => {
    const result = await engine.resume({ project: PROJECT, budget });
    return { found: result.found, packed: result.packed, nextStep: result.nextStep };
  });
}
