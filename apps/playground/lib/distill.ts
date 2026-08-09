import { generateObject } from "ai";
import { z } from "zod";
import { resolveLanguageModel, slugify, type Fact, type HandoffNote } from "@ctxvault/engine/web";
import { aiEnabled, modelRef } from "./session";
import type { ChatMessage } from "./chat";

/**
 * distill.ts — the playground PLAYING THE PART of a coding agent.
 *
 * In the real product nothing like this file runs on our side: Claude Code (or
 * Codex, or Cursor) fills in the `save_context` tool's schema itself, because it
 * already has the session in its context window. That is the whole v2 point —
 * CtxVault ships no summarizer and needs no key.
 *
 * The playground has no such agent. The panes are a simulation, so SOMETHING has
 * to do the agent's job of turning a conversation into a handoff. That job lives
 * here, in the playground, deliberately outside `@ctxvault/engine` — so nobody
 * reading the engine mistakes it for a dependency the product has.
 *
 * With no API key it falls back to a mechanical handoff built from the messages.
 * Not as good, but honest and never a dead button: the demo's subject is the
 * HANDOFF (save here, resume there), not the quality of the summary.
 */

const DecisionSchema = z.object({
  what: z.string().describe("The decision that was made."),
  why: z.string().describe("The reason it won."),
});

// Mirrors the MCP server's schema.ts. No `.default()`: a defaulted field is
// optional in the generated JSON schema, and strict structured-output providers
// reject a schema whose `required` list is incomplete.
const HandoffGenSchema = z.object({
  goal: z.string().describe("One sentence: what the user is ultimately trying to achieve."),
  decisions: z.array(DecisionSchema).describe("Concrete decisions and their reasons. Empty if none."),
  currentState: z.string().describe("Where things stand: what works, what is half-done, what is broken."),
  openTodos: z.array(z.string()).describe("Remaining tasks, most important first. Empty if none."),
  filesTouched: z.array(z.string()).describe("File paths created or edited. Empty if none mentioned."),
  gotchas: z.array(z.string()).describe("Traps and non-obvious constraints. Empty if none."),
  nextStep: z.string().describe("The single most useful next action. Specific and actionable."),
});

const FactGenSchema = z.object({
  slug: z.string().describe("Short stable kebab-case id derived from the title, e.g. 'password-hashing-argon2'."),
  type: z.enum(["decision", "convention", "architecture", "gotcha", "reference", "requirement"]),
  title: z.string().describe("Short human-readable title."),
  body: z.string().describe("The fact, explained with its reasoning. Under 150 words."),
  tags: z.array(z.string()).describe("Short lowercase tags for grouping. Empty if none."),
});

const SYSTEM =
  "You are an AI coding assistant handing your session to a different AI tool. " +
  "Write the handoff from what actually happened in the conversation — never invent " +
  "decisions, files or todos that were not discussed. Also extract 0-5 durable facts: " +
  "knowledge worth keeping long after this session (decisions and why they won, " +
  "conventions, gotchas), not a summary of the chat.";

export interface Distilled {
  handoff: HandoffNote;
  facts: Fact[];
  /** "agent" when a model wrote it, "template" in the keyless demo path. */
  source: "agent" | "template";
}

export async function distill(messages: ChatMessage[]): Promise<Distilled> {
  const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

  if (!aiEnabled()) return { ...templateHandoff(messages), source: "template" };

  try {
    const model = resolveLanguageModel(modelRef());
    // One call, both halves: the handoff and the facts come from the same read of
    // the session, which is also what a real agent does — it summarizes once.
    const { object } = await generateObject({
      model,
      schema: z.object({ handoff: HandoffGenSchema, facts: z.array(FactGenSchema) }),
      schemaName: "SessionHandoff",
      schemaDescription: "A structured handoff of one AI coding session, plus durable facts.",
      maxOutputTokens: 2500,
      system: SYSTEM,
      prompt: `Here is the session to hand off:\n\n${transcript.slice(0, 20_000)}`,
    });
    return {
      handoff: object.handoff,
      // The slug becomes a filename and came from a model — slugify it ourselves.
      facts: object.facts.map((f) => ({ ...f, slug: slugify(f.slug || f.title) })),
      source: "agent",
    };
  } catch {
    // A model hiccup must not cost the user their save.
    return { ...templateHandoff(messages), source: "template" };
  }
}

/** Keyless fallback: a real, if blunt, handoff assembled from the messages. */
function templateHandoff(messages: ChatMessage[]): { handoff: HandoffNote; facts: Fact[] } {
  const userMsgs = messages.filter((m) => m.role === "user");
  const first = userMsgs[0]?.content.trim() ?? "(no messages yet)";
  const last = userMsgs[userMsgs.length - 1]?.content.trim() ?? first;

  return {
    handoff: {
      goal: first.slice(0, 300),
      decisions: [],
      currentState:
        `${messages.length} message(s) exchanged in this pane. ` +
        `No API key is configured, so this handoff was assembled mechanically ` +
        `rather than written by a model.`,
      openTodos: [],
      filesTouched: [],
      gotchas: [],
      nextStep: last.slice(0, 300),
    },
    facts: [],
  };
}
