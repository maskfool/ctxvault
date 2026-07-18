import { type NextRequest } from "next/server";
import { withSession, resetEngine } from "@/lib/session";

export const runtime = "nodejs";

/** Wipe this session's in-memory vault (fresh demo). */
export async function POST(req: NextRequest) {
  return withSession(req, async ({ sid }) => {
    resetEngine(sid);
    return { ok: true };
  });
}
