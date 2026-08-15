import { type NextRequest } from "next/server";
import { withSession } from "@/lib/session";
import { chat, type ChatMessage } from "@/lib/chat";
import type { Persona } from "@/lib/personas";

export const runtime = "nodejs";

const MAX_MESSAGES = 40;
const MAX_LEN = 8000;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const persona: Persona = body.persona === "B" ? "B" : "A";
  const messages: ChatMessage[] = Array.isArray(body.messages)
    ? body.messages.slice(-MAX_MESSAGES).map((m: { role?: string; content?: unknown }) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content ?? "").slice(0, MAX_LEN),
      }))
    : [];
  const resumedContext =
    typeof body.resumedContext === "string" ? body.resumedContext.slice(0, 20_000) : undefined;

  // The only route that spends money — it gets the tight per-IP AI budget.
  return withSession(
    req,
    async () => {
      const reply = await chat(persona, messages, resumedContext);
      return { reply };
    },
    { costsMoney: true },
  );
}
