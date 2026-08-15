import { type NextRequest } from "next/server";
import { withSession, PROJECT } from "@/lib/session";
import { distill } from "@/lib/distill";
import type { ChatMessage } from "@/lib/chat";

export const runtime = "nodejs";

const MAX_TRANSCRIPT = 40_000; // cap so a pasted wall of text can't blow the budget

/**
 * POST /api/save — the demo's "Save context" button.
 *
 * Note the order: distill FIRST (the agent's job — see lib/distill.ts), then hand
 * the finished handoff to the engine. The engine never sees a model; it validates
 * and stores what it's given. That split is exactly what the MCP server does,
 * where the calling agent does the distilling instead of us.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const transcript = String(body.transcript ?? "").slice(0, MAX_TRANSCRIPT);
  const session = typeof body.session === "string" ? body.session : "main";

  // distill() calls a model to play the agent, so this route spends money too —
  // the engine's own save path does not, but the demo's stand-in agent does.
  return withSession(
    req,
    async ({ engine }) => {
      if (!transcript.trim()) return { error: "nothing to save" };

      // The pane's transcript arrives as "User: …" / "Assistant: …" blocks
      // (see transcriptOf in app/page.tsx); distill wants them back as messages.
      const messages: ChatMessage[] = transcript
        .split(/\n\n(?=(?:User|Assistant):)/i)
        .map((block) => ({
          role: (/^user:/i.test(block) ? "user" : "assistant") as ChatMessage["role"],
          content: block.replace(/^(?:User|Assistant):\s*/i, ""),
        }))
        .filter((m) => m.content.trim());

      const { handoff, facts, source } = await distill(messages);
      const result = await engine.save({ project: PROJECT, session, handoff, facts, transcript });

      return {
        mode: result.mode,
        source, // "agent" = a model wrote the handoff, "template" = keyless fallback
        factsExtracted: result.factsExtracted,
        snapshotId: result.snapshotId,
        warning: result.warning ?? null,
      };
    },
    { costsMoney: true },
  );
}
