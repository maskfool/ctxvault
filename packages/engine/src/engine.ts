import type { StorageAdapter } from "./storage/adapter.js";
import type { LLM } from "./llm/types.js";
import type { Embedder } from "./embed/types.js";
import type { Fact, HandoffNote, SearchHit, StoredFact } from "./types.js";
import { estimateTokens, tokensToChars, truncateHead } from "./lib/tokens.js";
import { rankHits } from "./retriever.js";

/**
 * engine.ts — the transport-agnostic brain.
 *
 * CtxEngine wraps a StorageAdapter (where memory lives) and, optionally, an LLM
 * (the intelligence). The MCP server and the web playground both call THESE
 * methods — they differ only in which adapter/LLM they hand in.
 *
 * PHASE 2.1: `save` now summarizes the transcript into a structured HandoffNote
 * when an LLM is present. Pass `llm = null` (the `--no-ai` path) and it degrades
 * to raw storage — never a dead button. `resume` renders the HandoffNote at the
 * top of the packed context so the next tool gets the structured handoff first.
 */
export interface SaveInput {
  project: string;
  session: string;
  transcript: string;
}

export interface SaveResult {
  snapshotId: string;
  project: string;
  session: string;
  savedChars: number;
  mode: "raw" | "intelligent";
  /** How many durable OKF facts were extracted and stored. */
  factsExtracted: number;
  /** Set when an intelligent step (summary/facts/indexing) failed. */
  warning?: string;
}

export interface ResumeInput {
  project: string;
  /** token budget for the packed context we inject into the new tool */
  budget?: number;
  /** resume a specific session/thread; defaults to the newest across all sessions */
  session?: string;
}

export interface ResumeResult {
  project: string;
  found: boolean;
  packed: string;
  estimatedTokens: number;
  nextStep: string | null;
}

export class CtxEngine {
  constructor(
    private readonly store: StorageAdapter,
    private readonly llm: LLM | null = null,
    private readonly embedder: Embedder | null = null,
  ) {}

  /** SAVE — persist the current working context so another tool can pick it up. */
  async save(input: SaveInput): Promise<SaveResult> {
    const warnings: string[] = [];
    let note: HandoffNote | null = null;
    let facts: Fact[] = [];

    // Intelligence steps are all best-effort: a model hiccup degrades gracefully
    // (raw storage, fewer facts) but NEVER fails the save. Durability first.
    if (this.llm) {
      try {
        note = await this.llm.summarize(input.transcript);
      } catch (err) {
        warnings.push(`summarizer failed, stored raw: ${(err as Error).message}`);
      }
      try {
        facts = await this.llm.extractFacts(input.transcript, note);
      } catch (err) {
        warnings.push(`fact extraction failed: ${(err as Error).message}`);
      }
    }

    const snap = await this.store.saveSnapshot({
      project: input.project,
      session: input.session,
      rawTranscript: input.transcript,
      handoffNote: note,
    });

    // Index the handoff (episodic) for search.
    if (this.embedder) {
      try {
        const text = embedTextFor(note, input.transcript);
        const [embedding] = await this.embedder.embed([text]);
        await this.store.saveVector({
          project: input.project,
          kind: "handoff",
          refId: snap.id,
          filePath: null,
          text,
          embedding,
          embedder: this.embedder.id,
        });
      } catch (err) {
        warnings.push(`handoff indexing failed: ${(err as Error).message}`);
      }
    }

    // Persist each durable fact: write it (the adapter creates the OKF file and
    // sets filePath), then index its body for search. The fact vector carries the
    // file path so a search hit can point at the readable file.
    let factsStored = 0;
    for (const fact of facts) {
      try {
        const stored = await this.store.saveFact({
          ...fact,
          project: input.project,
          session: input.session,
          filePath: null,
          updatedAt: new Date().toISOString(),
        });
        factsStored++;
        if (this.embedder) {
          // Embed title + tags + body (the title/tags carry key search terms),
          // but store the body as the display text for search results.
          const embedText = [fact.title, ...fact.tags, fact.body].join("\n");
          const [embedding] = await this.embedder.embed([embedText]);
          await this.store.saveVector({
            project: input.project,
            kind: "fact",
            refId: stored.slug,
            filePath: stored.filePath,
            text: fact.body,
            embedding,
            embedder: this.embedder.id,
          });
        }
      } catch (err) {
        warnings.push(`fact "${fact.slug}" failed: ${(err as Error).message}`);
      }
    }

    return {
      snapshotId: snap.id,
      project: snap.project,
      session: snap.session,
      savedChars: input.transcript.length,
      mode: note ? "intelligent" : "raw",
      factsExtracted: factsStored,
      warning: warnings.length ? warnings.join("; ") : undefined,
    };
  }

  /** List the durable OKF facts stored for a project (for the Vault view). */
  async listFacts(project: string) {
    return this.store.listFacts(project);
  }

  /** The newest snapshot for a project (carries the latest HandoffNote). */
  async getLatest(project: string) {
    return this.store.getLatest(project);
  }

  /** SEARCH — semantic lookup over stored memory, ranked by the retriever. */
  async search(project: string, query: string, k = 5): Promise<SearchHit[]> {
    if (!this.embedder) return [];
    const [queryVec] = await this.embedder.embed([query]);
    // Pull a wider candidate pool by pure similarity, then re-rank with recency
    // (a fresh near-match can beat a stale exact-match) and trim to k.
    // Only compare vectors made by the CURRENT embedder — cosine across models
    // (or dimensions) is noise, not signal.
    const pool = Math.min(50, Math.max(k * 5, k));
    const candidates = await this.store.search(project, queryVec, pool, this.embedder.id);
    return rankHits(candidates).slice(0, k);
  }

  /**
   * RESUME — rebuild a context packet for a fresh tool, within a token budget.
   *
   * The packer assembles a PRIORITY STACK and truncates the lowest priority first
   * (SPEC.md). Order, most-compressed/highest-value first:
   *   1. HandoffNote (force-included — the "what's next")
   *   2. Knowledge index — every fact's title + one-liner (cheap, high signal)
   *   3. Relevant fact bodies — the top few facts related to this handoff
   *   4. Recent verbatim transcript (tail) — fills whatever budget is left
   */
  async resume(input: ResumeInput): Promise<ResumeResult> {
    const budget = input.budget ?? 4000;
    const latest = await this.store.getLatest(input.project, input.session);

    if (!latest) {
      const where = input.session
        ? `project "${input.project}" (session "${input.session}")`
        : `project "${input.project}"`;
      return {
        project: input.project,
        found: false,
        packed: `No saved context found for ${where}.`,
        estimatedTokens: 0,
        nextStep: null,
      };
    }

    const maxChars = tokensToChars(budget);
    const note = latest.handoffNote;
    const header =
      `# Resumed context — project "${input.project}"\n` +
      `_Saved ${latest.createdAt} (session ${latest.session})_\n\n` +
      `You are picking up a session that was in progress in another AI tool. ` +
      `Continue from where it left off.\n`;

    // --- gather the pieces -------------------------------------------------
    const allFacts = await this.store.listFacts(input.project);
    const topFacts = await this.rankFactsForHandoff(input.project, note, allFacts);

    const noteBlock = note ? renderHandoffNote(note) : "";
    const indexBlock = allFacts.length ? renderFactIndex(allFacts) : "";

    // --- budget the stack, truncating lowest priority first ----------------
    // Must-haves (header + note + index) go in fully; they're small and high-value.
    let spent = header.length + noteBlock.length + indexBlock.length;
    const parts: string[] = [header, noteBlock, indexBlock];

    // Relevant fact bodies: add whole facts while they fit.
    const bodyChunks: string[] = [];
    for (const f of topFacts) {
      const chunk = `\n### ${f.title} (${f.type})\n${f.body.trim()}\n`;
      if (spent + chunk.length > maxChars - 200) break;
      bodyChunks.push(chunk);
      spent += chunk.length;
    }
    if (bodyChunks.length) parts.push(`\n## Relevant knowledge${bodyChunks.join("")}`);

    // Recent transcript: whatever budget remains.
    const transcriptBudget = maxChars - spent - 200;
    if (transcriptBudget > 200) {
      parts.push(
        `\n## Recent transcript (tail)\n${truncateHead(latest.rawTranscript, transcriptBudget)}`,
      );
    }

    const packed = parts.join("");
    return {
      project: input.project,
      found: true,
      packed,
      estimatedTokens: estimateTokens(packed),
      nextStep: note?.nextStep ?? null,
    };
  }

  /**
   * Rank facts by relevance to the handoff. With an embedder + note, we search
   * facts using the note's goal/next-step as an implicit query. Otherwise we fall
   * back to the most recently updated facts. Always returns at most 5.
   */
  private async rankFactsForHandoff(
    project: string,
    note: HandoffNote | null,
    allFacts: StoredFact[],
  ): Promise<StoredFact[]> {
    const byRecency = () => allFacts.slice(0, 5);
    if (!this.embedder || !note || allFacts.length === 0) return byRecency();

    try {
      const query = [note.goal, note.nextStep, ...note.openTodos].join(" ");
      const hits = await this.search(project, query, 15);
      const rank = new Map<string, number>();
      hits.filter((h) => h.kind === "fact").forEach((h, i) => rank.set(h.refId, i));
      const ranked = allFacts
        .filter((f) => rank.has(f.slug))
        .sort((a, b) => rank.get(a.slug)! - rank.get(b.slug)!)
        .slice(0, 5);
      return ranked.length ? ranked : byRecency();
    } catch {
      return byRecency(); // search failure must not break resume
    }
  }

  async listSessions(project: string) {
    return this.store.listSessions(project);
  }
}

/**
 * Build the text we embed for search. A HandoffNote is far more searchable than
 * a raw transcript (it's the distilled meaning), so prefer it. Without a note
 * (raw mode) we embed a bounded slice of the transcript so search still works.
 */
function embedTextFor(note: HandoffNote | null, transcript: string): string {
  if (note) {
    return [
      note.goal,
      note.currentState,
      note.nextStep,
      ...note.decisions.map((d) => `${d.what}: ${d.why}`),
      ...note.openTodos,
      ...note.gotchas,
    ].join("\n");
  }
  return transcript.slice(0, 8000);
}

/** Render the knowledge index: every fact as a one-line title + snippet. */
function renderFactIndex(facts: StoredFact[]): string {
  const lines = facts.map((f) => {
    const oneLiner = f.body.replace(/\s+/g, " ").trim().slice(0, 90);
    return `- **${f.title}** [${f.type}] — ${oneLiner}`;
  });
  return `\n## Knowledge index (${facts.length})\n${lines.join("\n")}\n`;
}

/** Render a HandoffNote as compact, human- and model-readable markdown. */
function renderHandoffNote(note: HandoffNote): string {
  const lines: string[] = ["\n## Handoff note"];
  lines.push(`**Goal:** ${note.goal}`);
  lines.push(`**Current state:** ${note.currentState}`);
  lines.push(`**Next step:** ${note.nextStep}`);
  if (note.decisions.length) {
    lines.push("**Decisions:**");
    for (const d of note.decisions) lines.push(`- ${d.what} — _${d.why}_`);
  }
  if (note.openTodos.length) {
    lines.push("**Open todos:**");
    for (const t of note.openTodos) lines.push(`- ${t}`);
  }
  if (note.filesTouched.length) lines.push(`**Files touched:** ${note.filesTouched.join(", ")}`);
  if (note.gotchas.length) {
    lines.push("**Gotchas:**");
    for (const g of note.gotchas) lines.push(`- ${g}`);
  }
  return lines.join("\n") + "\n";
}
