/**
 * lib/slug.ts — turn an arbitrary title/slug into a safe, stable file basename.
 *
 * A fact's slug becomes a filename: knowledge/<project>/<slug>.md. That means the
 * slug is UNTRUSTED — it comes from an LLM. Slugifying here is a security boundary:
 * we strip everything that isn't [a-z0-9-] so a slug can never contain "/" or ".."
 * and escape the knowledge directory. It also gives us the stable-id property the
 * OKF writer relies on: same title → same slug → overwrite (no duplicate files).
 */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics → single dash
    .replace(/^-+|-+$/g, "") // trim leading/trailing dashes
    .slice(0, 80); // keep filenames sane
  return s || "untitled";
}

/**
 * Canonicalize a project identifier.
 *
 * WHY THIS EXISTS. `project` is the vault's primary key, and it arrives from
 * three places that disagree: the CLI uses `basename(cwd)`, the auto-capture
 * hook uses `basename(cwd)`, and an AGENT uses whatever the human said out loud.
 * So the same project shows up as "CtxVault", "ctxvault" and "ctx vault".
 *
 * Storage was already split on this: file paths ran through `slugify`, so every
 * spelling shared one directory, while database lookups matched the raw string
 * exactly, so every spelling was a different vault. You could save context and
 * then be told "No saved context found" for the same folder — the worst failure
 * a memory tool can have, because it looks like data loss rather than a typo.
 *
 * This is DELIBERATELY the same function as `slugify`, not merely similar. That
 * equality is the invariant: **the project key is always exactly the directory
 * name that holds its files.** Weaken it and the split-brain comes back.
 */
export const normalizeProject = (project: string): string => slugify(project);
