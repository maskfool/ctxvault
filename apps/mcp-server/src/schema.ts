import { z } from "zod";
import { FactTypeSchema } from "@ctxvault/engine";

/**
 * schema.ts — the form the calling agent fills in.
 *
 * This file is the v2 architecture made concrete. In v1 these shapes were handed
 * to our own LLM as a structured-output spec; now they are handed to the CALLING
 * agent as an MCP tool input schema. Same fields, same descriptions, one fewer
 * model in the loop — the agent that lived through the session is the one that
 * writes the summary, using tokens the user has already paid for.
 *
 * Two rules kept from the generation schemas:
 *
 *  1. `.describe()` on every field. These strings are the only instructions the
 *     agent gets about what belongs in each slot; they land verbatim in the JSON
 *     schema the client shows its model. Vague descriptions here produce vague
 *     handoffs, and a vague handoff is a failed resume.
 *
 *  2. No `.default()` on required fields. A defaulted field is OPTIONAL in the
 *     generated JSON schema, and clients running strict structured output reject
 *     a schema whose `required` list is incomplete. Ask for empty arrays instead.
 */

const DecisionInput = z.object({
  what: z.string().describe("The decision that was made."),
  why: z.string().describe("The reason it won over the alternatives."),
});

export const HandoffInput = z.object({
  goal: z
    .string()
    .describe("One sentence: what the user is ultimately trying to achieve in this work."),
  decisions: z
    .array(DecisionInput)
    .describe(
      "Concrete decisions made this session and why. These are the things the next tool must not re-litigate. Empty array if none.",
    ),
  currentState: z
    .string()
    .describe("Where things stand right now: what works, what is half-done, what is broken."),
  openTodos: z
    .array(z.string())
    .describe("Remaining tasks, most important first. Empty array if none."),
  filesTouched: z
    .array(z.string())
    .describe("Paths of files created or edited this session. Empty array if none."),
  gotchas: z
    .array(z.string())
    .describe(
      "Traps, non-obvious constraints, and things that already went wrong — what would cost the next tool an hour to rediscover. Empty array if none.",
    ),
  nextStep: z
    .string()
    .describe("The single most useful next action. Specific and actionable, not 'continue the work'."),
});

export const FactInput = z.object({
  slug: z
    .string()
    .describe(
      "Short stable kebab-case id derived from the title, e.g. 'password-hashing-argon2'. " +
        "The same knowledge must always produce the same slug, so re-saving updates the existing file instead of duplicating it.",
    ),
  type: FactTypeSchema.describe(
    "The kind of durable knowledge this is: decision, convention, architecture, gotcha, reference, or requirement.",
  ),
  title: z.string().describe("Short human-readable title."),
  body: z
    .string()
    .describe(
      "The knowledge itself, with the reasoning behind it, so it still makes sense months later. Under 150 words.",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe("Short lowercase tags for grouping, e.g. ['auth', 'security']."),
});
