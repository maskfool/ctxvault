import type { StorageAdapter } from "./storage/adapter.js";
import type { Embedder } from "./embed/types.js";
import type { Fact, HandoffNote, SearchHit, StoredFact } from "./types.js";
import { estimateTokens, tokensToChars, truncateHead } from "./lib/tokens.js";
import { handoffSearchBody } from "./lib/text.js";
import { blendHits } from "./retriever.js";

/**
 * engine.ts — the transport-agnostic brain.
 *
 * CtxEngine wraps a StorageAdapter (where memory lives) and, optionally, an
 * Embedder (better search). The MCP server, the CLI and the web playground all
 * call THESE methods — they differ only in which adapter they hand in.
 *
 * V2 — WHO DOES THE THINKING CHANGED.
 * v1 took a raw transcript and called its OWN LLM to summarize it and extract
 * facts. That made an API key a hard requirement and billed the user twice for
 * understanding one session: once in the coding agent that lived through it, and
 * again here. But the agent calling `save` already has the whole session in its
 * context window and already understands it.
 *
 * So v2 inverts the contract: the agent authors the HandoffNote and the facts
 * (the MCP tool's input schema IS that form) and hands them in. The engine
 * validates, stores, indexes, ranks and packs. No model, no key, no per-call
 * cost. `save` with no handoff still works — it stores the raw transcript, which
 * is the honest degraded path rather than a dead button.
 */
export interface SaveInput {
  project: string;
  session: string;
  /** The agent-authored handoff. Omit it and the save degrades to raw storage. */
  handoff?: HandoffNote | null;
  /** Durable knowledge worth keeping after the session ends. Each becomes an OKF file. */
  facts?: Fact[];
  /** Optional verbatim tail, kept as backup context behind the structured note. */
  transcript?: string;
}

export interface SaveResult {
  snapshotId: string;
  project: string;
  session: string;
  savedChars: number;
  /** "agent" = a structured handoff came in; "raw" = transcript only. */
  mode: "agent" | "raw";
  /** How many durable OKF facts were stored. */
  factsExtracted: number;
  /** Set when a non-fatal step (a fact write, an index update) failed. */
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

export interface ExportInput extends ResumeInput {
  /**
   * Drop the verbatim transcript tail. Used for the CLAUDE.md/AGENTS.md block,
   * which must stay small enough to sit in every future session's context.
   */
  compact?: boolean;
}

export class CtxEngine {
  constructor(
    private readonly store: StorageAdapter,
    private readonly embedder: Embedder | null = null,
  ) {}

  /** True when vector search is available on top of the always-on keyword search. */
  get hybrid(): boolean {
    return this.embedder !== null;
  }

  /** SAVE — persist the agent's handoff so another tool can pick it up. */
  async save(input: SaveInput): Promise<SaveResult> {
    const warnings: string[] = [];
    const note = input.handoff ?? null;
    const facts = input.facts ?? [];
    const transcript = input.transcript ?? "";

    const snap = await this.store.saveSnapshot({
      project: input.project,
      session: input.session,
      rawTranscript: transcript,
      handoffNote: note,
    });

    // Index the handoff (episodic memory) for search. Indexing is best-effort:
    // a failure here costs discoverability, never the saved context itself.
    const handoffText = note ? handoffSearchBody(note) : transcript.slice(0, 8000);
    if (handoffText.trim()) {
      try {
        await this.store.indexText({
          project: input.project,
          kind: "handoff",
          refId: snap.id,
          filePath: null,
          title: note?.goal ?? `Session ${input.session}`,
          tags: [input.session],
          body: handoffText,
        });
      } catch (err) {
        warnings.push(`handoff indexing failed: ${(err as Error).message}`);
      }
      if (this.embedder) {
        try {
          const [embedding] = await this.embedder.embed([handoffText]);
          await this.store.saveVector({
            project: input.project,
            kind: "handoff",
            refId: snap.id,
            filePath: null,
            text: handoffText,
            embedding,
            embedder: this.embedder.id,
          });
        } catch (err) {
          warnings.push(`handoff embedding failed: ${(err as Error).message}`);
        }
      }
    }

    // Persist each durable fact: write it (the adapter creates the OKF file and
    // sets filePath), then index it. The fact's index entry carries the file path
    // so a search hit can point the user at the readable markdown.
    let factsStored = 0;
    const storedFacts: StoredFact[] = [];
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
        storedFacts.push(stored);
        await this.store.indexText({
          project: input.project,
          kind: "fact",
          refId: stored.slug,
          filePath: stored.filePath,
          title: fact.title,
          tags: fact.tags,
          body: fact.body,
        });
      } catch (err) {
        warnings.push(`fact "${fact.slug}" failed: ${(err as Error).message}`);
      }
    }

    // Embeddings in ONE batched call for all facts. Per-fact calls defeat the
    // batching the embedder exists to do — N round-trips for one API's worth of work.
    if (this.embedder && storedFacts.length) {
      try {
        const texts = storedFacts.map((f) => [f.title, ...f.tags, f.body].join("\n"));
        const embeddings = await this.embedder.embed(texts);
        await Promise.all(
          storedFacts.map((f, i) =>
            this.store.saveVector({
              project: input.project,
              kind: "fact",
              refId: f.slug,
              filePath: f.filePath,
              text: f.body,
              embedding: embeddings[i],
              embedder: this.embedder!.id,
            }),
          ),
        );
      } catch (err) {
        warnings.push(`fact embedding failed: ${(err as Error).message}`);
      }
    }

    return {
      snapshotId: snap.id,
      project: snap.project,
      session: snap.session,
      savedChars: transcript.length,
      mode: note ? "agent" : "raw",
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

  /**
   * SEARCH — hybrid lookup over stored memory.
   *
   * Keyword (BM25) always runs; vector search joins in when an embedding model
   * is configured. Both halves are best-effort: whichever one works still
   * answers, because "search is down" is a much worse failure than "search is
   * only lexical today".
   */
  async search(project: string, query: string, k = 5): Promise<SearchHit[]> {
    // Pull a wider candidate pool from each index, then re-rank and trim — a
    // doc that is 3rd by keywords and 2nd by vectors should be able to win.
    const pool = Math.min(50, Math.max(k * 5, k));

    const lexical = await this.store
      .searchText(project, query, pool)
      .catch(() => [] as SearchHit[]);

    let semantic: SearchHit[] = [];
    if (this.embedder) {
      try {
        const [queryVec] = await this.embedder.embed([query]);
        // Only compare vectors made by the CURRENT embedder — cosine across
        // models (or dimensions) is noise, not signal.
        semantic = await this.store.search(project, queryVec, pool, this.embedder.id);
      } catch {
        // Embeddings unavailable (network, quota, bad key): keyword results stand.
      }
    }

    // Relevance floor. Top-k with no floor returns SOMETHING for any query, and a
    // weak hit presented as a result reads as an answer — "no match" has to be
    // said, not implied by a low number. A BM25 hit shares at least one
    // meaningful term, so it clears the bar; a vector-only hit must clear the
    // cosine level below which real embedding models put unrelated text.
    const VECTOR_FLOOR = 0.3;
    return blendHits(lexical, semantic)
      .filter((h) => h.lexical > 0 || h.similarity >= VECTOR_FLOOR)
      .slice(0, k);
  }

  /**
   * RESUME — rebuild a context packet for a fresh tool, within a token budget.
   *
   * This is the answer to the "don't stuff everything into CLAUDE.md" critique:
   * the vault holds everything forever, but what enters a context window is a
   * ranked, budgeted slice. Priority stack, truncating the lowest first:
   *   1. HandoffNote (force-included — the "what's next")
   *   2. Knowledge index — every fact's title + one-liner (cheap, high signal)
   *   3. Relevant fact bodies — the top few facts related to this handoff
   *   4. Recent verbatim transcript (tail) — fills whatever budget is left
   */
  async resume(input: ResumeInput): Promise<ResumeResult> {
    return this.pack(input, (latest) =>
      `# Resumed context — project "${input.project}"\n` +
      `_Saved ${latest.createdAt} (session ${latest.session})_\n\n` +
      `You are picking up a session that was in progress in another AI tool. ` +
      `Continue from where it left off.\n`,
    );
  }

  /**
   * EXPORT — the same packet, addressed to a human or to a tool that has never
   * heard of CtxVault. Paste it into claude.ai, ChatGPT, Gemini, a fresh Cursor
   * chat; or write it into CLAUDE.md / AGENTS.md (see export/harness.ts).
   *
   * Deliberately the same packer as `resume`: one place decides what "enough
   * context to continue" means, so the MCP path and the paste path can't drift.
   */
  async exportPacket(input: ExportInput): Promise<ResumeResult> {
    return this.pack(
      input,
      (latest) =>
        `# Context handoff — project "${input.project}"\n` +
        `_Exported from CtxVault · saved ${latest.createdAt} (session ${latest.session})_\n\n` +
        `This is the state of an AI coding session that was in progress elsewhere. ` +
        `Read it and continue from where it left off.\n`,
      { includeTranscript: !input.compact },
    );
  }

  /** The shared packer behind `resume` and `exportPacket`. */
  private async pack(
    input: ResumeInput,
    header: (latest: { createdAt: string; session: string }) => string,
    opts: { includeTranscript?: boolean } = {},
  ): Promise<ResumeResult> {
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
    const headerText = header(latest);

    // --- gather the pieces -------------------------------------------------
    const allFacts = await this.store.listFacts(input.project);
    const topFacts = await this.rankFactsForHandoff(input.project, note, allFacts);

    const noteBlock = note ? renderHandoffNote(note) : "";
    const indexBlock = allFacts.length ? renderFactIndex(allFacts) : "";

    // --- budget the stack, truncating lowest priority first ----------------
    // Must-haves (header + note + index) go in fully; they're small and high-value.
    let spent = headerText.length + noteBlock.length + indexBlock.length;
    const parts: string[] = [headerText, noteBlock, indexBlock];

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
    if (opts.includeTranscript !== false && transcriptBudget > 200 && latest.rawTranscript.trim()) {
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
   * Rank facts by relevance to the handoff, using the note's goal/next-step as
   * an implicit query. Works with or without an embedder — keyword search is
   * always there — and falls back to most-recently-updated if search finds
   * nothing, so a resume is never empty when facts exist.
   */
  private async rankFactsForHandoff(
    project: string,
    note: HandoffNote | null,
    allFacts: StoredFact[],
  ): Promise<StoredFact[]> {
    const byRecency = () => allFacts.slice(0, 5);
    if (!note || allFacts.length === 0) return byRecency();

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
