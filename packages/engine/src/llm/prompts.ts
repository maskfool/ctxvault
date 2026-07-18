/**
 * llm/prompts.ts — the summarizer prompt, kept separate so it can be iterated
 * on without touching the calling code (the plan calls this the most
 * human-time-worthy part of the build — tune it against fake transcripts).
 *
 * The prompt is written to force a HandoffNote: the structured "what you need
 * to keep working" summary.
 *
 * NOTE ON SHAPE: these prompts describe CONTENT, not FORMAT. The output shape is
 * enforced by the zod schemas handed to `generateObject` (llm/vercel.ts), which
 * the provider applies as a native structured-output constraint. Re-stating the
 * field list here would be a second source of truth that silently drifts, so
 * per-field guidance lives in the schema's `.describe()` calls instead.
 */

export const SUMMARIZER_SYSTEM = `You are CtxVault's session summarizer. You compress an AI coding session into a HANDOFF NOTE so a different AI tool (or the same one tomorrow) can resume the work with zero re-briefing.

You will receive a transcript of a working session. Produce a HandoffNote from it.

Rules:
- Be faithful to the transcript. Do not invent files, decisions, or facts that aren't supported by it.
- Capture reversals: if a choice was made then changed, record the FINAL decision and why it won.
- Prefer specifics ("switched from bcrypt to argon2 for the memory-hardness") over vagueness ("changed the hashing").
- Keep each string tight — a sentence or two. This is a handoff, not a report.
- Use empty arrays for sections the transcript doesn't support. Never pad.`;

/** The user turn: the transcript to summarize, plus a final nudge. */
export function summarizerUser(transcript: string): string {
  return `Here is the session transcript. Produce the HandoffNote.\n\n<transcript>\n${transcript}\n</transcript>`;
}

/**
 * Map step of map-reduce for very long transcripts: summarize one chunk into a
 * compact plain-text digest that the final reduce step can combine.
 */
export const CHUNK_SYSTEM = `You are summarizing ONE chunk of a longer AI coding session. Produce a dense plain-text digest (not JSON) capturing: the goal being pursued, decisions made and why, files touched, gotchas, and what was left unfinished in this chunk. Be faithful and specific. 120 words max.`;

export function chunkUser(chunk: string): string {
  return `Summarize this chunk:\n\n<chunk>\n${chunk}\n</chunk>`;
}

// ---------------------------------------------------------------------------
// Fact extraction (Phase 2.3) — pull DURABLE knowledge out of a session.
// A HandoffNote is about *this* session ("what's next"); a Fact is timeless
// ("this project uses argon2, and here's why"). Facts become OKF files.
// ---------------------------------------------------------------------------
export const FACTS_SYSTEM = `You are CtxVault's knowledge extractor. From a coding session, extract the DURABLE facts worth remembering long after the session ends — the things a teammate joining next month would need to know.

Extract facts, NOT status. A fact is timeless project knowledge:
- decision: a choice that will keep mattering ("auth uses argon2id, not bcrypt")
- convention: a rule the project follows ("all API routes return {data, error}")
- architecture: how a piece fits together ("the engine talks only to StorageAdapter")
- gotcha: a non-obvious trap ("better-sqlite3 is sync; never await its calls")
- requirement: a hard constraint ("must run offline, no cloud calls")
- reference: a pointer to an external resource

Do NOT extract transient status ("currently debugging X", "TODO: add tests") — that belongs in the handoff note, not here.

Rules:
- Only extract what the transcript actually supports. Do not invent facts.
- 0 to ~8 facts. Quality over quantity — skip anything trivial or transient.
- Reuse the same slug for the same piece of knowledge every time, so a re-save updates the existing fact instead of duplicating it.`;

export function factsUser(transcript: string, noteJson: string | null): string {
  const noteBlock = noteJson
    ? `\n\nFor context, here is the session's handoff note (do not just copy it — extract the DURABLE knowledge):\n${noteJson}`
    : "";
  return `Extract the durable facts from this session.${noteBlock}\n\n<transcript>\n${transcript}\n</transcript>`;
}
