import matter from "gray-matter";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../lib/slug.js";
import type { StoredFact, FactType } from "../types.js";

/**
 * okf/okf.ts — CtxVault's Open Knowledge Format layer.
 *
 * A fact is persisted as a plain markdown file with YAML frontmatter:
 *
 *   knowledge/<project>/<slug>.md
 *   ---
 *   type: decision
 *   title: Password hashing uses argon2id
 *   updated: 2026-07-18T10:00:00.000Z
 *   session: main
 *   tags: [auth, security]
 *   ---
 *   We chose argon2id over bcrypt because ...
 *
 * Why a file and not just a DB row? The whole pitch: the memory is HUMAN-READABLE
 * and git-versionable. A lawyer can open the file, a teammate can `grep` it, and
 * it stays readable even if CtxVault never runs again. "OKF is a shelf, not a
 * compressor" — the file is durable storage, not a token-saving trick.
 *
 * Update rule (from SPEC): same slug = overwrite the file, bump `updated`. No
 * merge intelligence.
 */

/** Serialize a fact to OKF markdown (frontmatter + body). */
export function factToMarkdown(fact: StoredFact): string {
  return matter.stringify(fact.body.trim() + "\n", {
    type: fact.type,
    title: fact.title,
    // The directory name is slugified, so it can't reproduce the project string
    // a tool actually queries with ("My App" → "my-app"). Record the real one so
    // a vault rebuilt from files answers to the same name.
    project: fact.project,
    updated: fact.updatedAt,
    session: fact.session,
    tags: fact.tags,
  });
}

/** Compute the on-disk path for a fact. slugify guarantees it stays inside the dir. */
export function okfPath(knowledgeDir: string, project: string, slug: string): string {
  return join(knowledgeDir, slugify(project), `${slugify(slug)}.md`);
}

/** Write (create or overwrite) a fact's OKF file. Returns the absolute path. */
export function writeOkfFile(knowledgeDir: string, fact: StoredFact): string {
  const path = okfPath(knowledgeDir, fact.project, fact.slug);
  mkdirSync(join(knowledgeDir, slugify(fact.project)), { recursive: true });
  writeFileSync(path, factToMarkdown(fact), "utf8");
  return path;
}

/** Parse an OKF file back into a StoredFact (used to round-trip / re-import). */
export function readOkfFile(path: string, project: string, slug: string): StoredFact {
  const parsed = matter(readFileSync(path, "utf8"));
  const data = parsed.data as Record<string, unknown>;
  // Hand-edited frontmatter may leave the date unquoted → YAML returns a Date.
  const isoDate = (v: unknown): string =>
    typeof v === "string" ? v : v instanceof Date ? v.toISOString() : new Date().toISOString();
  return {
    project: typeof data.project === "string" ? data.project : project,
    slug,
    type: (data.type as FactType) ?? "reference",
    title: (data.title as string) ?? slug,
    body: parsed.content.trim(),
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
    session: (data.session as string) ?? "main",
    updatedAt: isoDate(data.updated),
    filePath: path,
  };
}

/** List every OKF fact file for a project (returns parsed facts). */
export function listOkfFiles(knowledgeDir: string, project: string): StoredFact[] {
  const dir = join(knowledgeDir, slugify(project));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // project has no knowledge dir yet
  }
  return names
    .filter((n) => n.endsWith(".md"))
    .map((n) => readOkfFile(join(dir, n), project, n.replace(/\.md$/, "")));
}
