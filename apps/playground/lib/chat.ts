import { generateText } from "ai";
import { resolveLanguageModel } from "@ctxvault/engine/web";
import { PERSONAS, type Persona } from "./personas";
import { aiEnabled, modelRef } from "./session";

/**
 * chat.ts — the playground's chat backend for the two panes.
 *
 * This is a playground concern (free-form chat), separate from the engine's
 * structured summarize/extract calls, so it calls the AI SDK directly rather
 * than going through the LLM seam. It uses the SAME model ref as the engine, so
 * switching CTXVAULT_MODEL moves the whole app at once.
 *
 * With no key it returns a clearly-labelled demo reply — the plan's rule: never
 * show a judge a dead button.
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Resolve the model on FIRST USE, not at module scope, so a misconfigured
 * CTXVAULT_MODEL surfaces as a failed request instead of an import-time throw
 * that takes the whole route down — including its ability to serve the demo
 * reply. Memoized, since the model object is reusable across requests.
 */
let cached: ReturnType<typeof resolveLanguageModel> | null = null;

function getModel() {
  if (!aiEnabled()) return null;
  if (!cached) cached = resolveLanguageModel(modelRef());
  return cached;
}

export async function chat(
  persona: Persona,
  messages: ChatMessage[],
  resumedContext?: string,
): Promise<string> {
  const p = PERSONAS[persona];
  const system = resumedContext
    ? `${p.system}\n\nYou have just been handed the following context from another AI tool. Continue from it:\n\n${resumedContext}`
    : p.system;

  const model = getModel();
  if (!model) return demoReply(persona, messages, resumedContext);

  const { text } = await generateText({
    model,
    maxOutputTokens: 700,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return text.trim();
}

/** Deterministic offline reply so the demo flows without an API key. */
function demoReply(persona: Persona, messages: ChatMessage[], resumed?: string): string {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const who = PERSONAS[persona].name;
  const hint = `[demo mode — set an API key for ${modelRef()} to get real replies]\n`;
  if (resumed) {
    const next = /Next step:\s*(.+)/i.exec(resumed)?.[1]?.trim();
    return (
      hint +
      `${who} here, picking up where you left off${next ? `: ${next}` : ""}. ` +
      `I can see the handoff note and the project's facts, so I'm ready to continue.`
    );
  }
  return (
    hint +
    `${who}. You said: "${last.slice(0, 160)}". In a live deployment I'd respond with ` +
    `${persona === "A" ? "a plan and the key decisions" : "an implementation"}. ` +
    `Try 💾 Save context, then 🔁 Resume in the other pane to see the handoff.`
  );
}
