import matter from "gray-matter";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../lib/slug.js";
import { HandoffNoteSchema, type HandoffNote, type Snapshot } from "../types.js";

/**
 * okf/handoff.ts — handoffs as files, for the same reason facts are files.
 *
 * SPEC says "markdown is the truth, SQLite is a derived index." Until this file
 * existed that was only half true: facts were on disk, but HandoffNotes lived
 * exclusively in `snapshots.handoff_json`. Syncing a vault as a plain folder
 * would have carried the project's knowledge and silently dropped every "where
 * was I" — the thing CtxVault is actually for.
 *
 * So a snapshot is also a markdown file:
 *
 *   handoffs/<project>/<session>/<timestamp>--<id8>.md
 *   ---
 *   id: 8097f474-a85b-43f9-9340-3c8615293293
 *   session: main
 *   created: 2026-08-09T09:08:00.116Z
 *   goal: Migrate CtxVault to the keyless v2 architecture
 *   currentState: Engine flipped, FTS5 search in, export shipped.
 *   nextStep: Rewrite the README around the zero-key pitch
 *   decisions:
 *     - what: Agent authors the handoff
 *       why: removes the API-key requirement and the double cost
 *   openTodos: [Rewrite README, Git sync]
 *   ---
 *   User: ...
 *   Assistant: ...
 *
 * The structured note goes in the frontmatter (lossless round-trip, and YAML
 * reads fine for this shape) and the verbatim transcript is the body — which is
 * where prose belongs and where a git diff is actually legible.
 *
 * One file per snapshot, never rewritten: handoffs are an append-only history,
 * unlike facts, where the same slug deliberately overwrites.
 */

/** Filesystem-safe stamp from an ISO date: 2026-08-09T09:08:00.116Z → 20260809-090800. */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** Where a snapshot lives. slugify on every segment keeps it inside the dir. */
export function handoffPath(handoffDir: string, snap: Snapshot): string {
  return join(
    handoffDir,
    slugify(snap.project),
    slugify(snap.session),
    `${stamp(snap.createdAt)}--${snap.id.slice(0, 8)}.md`,
  );
}

export function handoffToMarkdown(snap: Snapshot): string {
  const note = snap.handoffNote;
  return matter.stringify(snap.rawTranscript.trim() + "\n", {
    id: snap.id,
    // The directory name is slugified, so it can't be trusted to reproduce the
    // project string a tool actually uses ("My App" → "my-app"). Record the real
    // one, or a rebuilt vault answers to a name nobody queries.
    project: snap.project,
    session: snap.session,
    created: snap.createdAt,
    ...(note
      ? {
          goal: note.goal,
          currentState: note.currentState,
          nextStep: note.nextStep,
          decisions: note.decisions,
          openTodos: note.openTodos,
          filesTouched: note.filesTouched,
          gotchas: note.gotchas,
        }
      : {}),
  });
}

/** Write a snapshot's markdown file. Returns the absolute path. */
export function writeHandoffFile(handoffDir: string, snap: Snapshot): string {
  const path = handoffPath(handoffDir, snap);
  mkdirSync(join(handoffDir, slugify(snap.project), slugify(snap.session)), {
    recursive: true,
  });
  writeFileSync(path, handoffToMarkdown(snap), "utf8");
  return path;
}

/**
 * Parse a handoff file back into a Snapshot.
 *
 * The note is rebuilt only when the frontmatter has the fields that make one —
 * a file with no `goal` was saved in raw mode and must round-trip as raw, not as
 * a note full of empty strings. Parsing goes through HandoffNoteSchema because
 * these files are hand-editable: a human who breaks the shape should produce a
 * skipped note, not a corrupted row.
 */
export function readHandoffFile(path: string, project: string): Snapshot | null {
  let parsed;
  try {
    parsed = matter(readFileSync(path, "utf8"));
  } catch {
    return null; // unreadable or malformed frontmatter — skip, don't crash a rebuild
  }
  const d = parsed.data as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.created !== "string") return null;

  let note: HandoffNote | null = null;
  if (typeof d.goal === "string") {
    const candidate = {
      goal: d.goal,
      currentState: d.currentState ?? "",
      nextStep: d.nextStep ?? "",
      decisions: d.decisions ?? [],
      openTodos: d.openTodos ?? [],
      filesTouched: d.filesTouched ?? [],
      gotchas: d.gotchas ?? [],
    };
    const result = HandoffNoteSchema.safeParse(candidate);
    note = result.success ? result.data : null;
  }

  return {
    id: d.id,
    project: typeof d.project === "string" ? d.project : project,
    session: typeof d.session === "string" ? d.session : "main",
    createdAt: d.created,
    rawTranscript: parsed.content.trim(),
    handoffNote: note,
  };
}

/** Every snapshot file for one project, oldest first. */
export function listHandoffFiles(handoffDir: string, project: string): Snapshot[] {
  const projectDir = join(handoffDir, slugify(project));
  const out: Snapshot[] = [];
  for (const session of safeReaddir(projectDir)) {
    for (const name of safeReaddir(join(projectDir, session))) {
      if (!name.endsWith(".md")) continue;
      const snap = readHandoffFile(join(projectDir, session, name), project);
      if (snap) out.push(snap);
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Project names that have any files under `dir` — used to rebuild a whole vault. */
export function listProjectDirs(dir: string): string[] {
  return safeReaddir(dir);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.name.endsWith(".md"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}
