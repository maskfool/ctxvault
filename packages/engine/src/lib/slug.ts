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
