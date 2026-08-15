import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CtxEngine } from "../src/engine.js";
import { SqliteAdapter } from "../src/storage/sqlite.js";
import type { Fact, HandoffNote } from "../src/types.js";

/**
 * THE invariant: markdown files are the truth, ctxvault.db is a derived index.
 * rm ctxvault.db && ctx reindex must bring the vault back. This test does
 * exactly that, against a temp vault, through the same code path the CLI uses
 * (importFromFiles + reindex). If this breaks, `ctx sync` is silently lossy —
 * a synced vault would carry knowledge and drop every "where was I".
 */

const note: HandoffNote = {
  goal: "Migrate the payment service to Stripe",
  decisions: [{ what: "idempotency keys per retry", why: "safe replays on timeout" }],
  currentState: "charges work, webhooks half-wired",
  openTodos: ["finish webhook signature check"],
  filesTouched: ["src/pay/stripe.ts"],
  gotchas: ["Stripe clock can be mocked in test mode only"],
  nextStep: "Verify webhook signature before storing the event",
};

const facts = (): Fact[] => [
  {
    slug: "stripe-idempotency-keys",
    type: "convention",
    title: "Every Stripe charge sends an idempotency key",
    body: "Retry-safe charge creation: derive the key from (orderId, attempt) so a timeout replay never double-charges.",
    tags: ["stripe", "payments"],
  },
  {
    slug: "webhook-signature-check",
    type: "gotcha",
    title: "Stripe webhooks must be signature-verified before storage",
    body: "Construct the event with constructEvent, never parse the raw body — parse-then-store accepts forged events.",
    tags: ["stripe", "security"],
  },
];

function freshVault() {
  const root = mkdtempSync(join(tmpdir(), "ctxvault-sqlite-"));
  return {
    root,
    dbPath: join(root, "ctxvault.db"),
    knowledgeDir: join(root, "knowledge"),
    handoffDir: join(root, "handoffs"),
  };
}

const TRANSCRIPT = "User: wire the webhook\nAssistant: done, signature check next";

describe("SqliteAdapter — the derived-index contract", () => {
  it("writes the markdown trees as the save happens (files, not just rows)", async () => {
    const v = freshVault();
    const store = new SqliteAdapter(v.dbPath, { knowledgeDir: v.knowledgeDir, handoffDir: v.handoffDir });
    const engine = new CtxEngine(store);
    await engine.save({ project: "pay", session: "main", handoff: note, facts: facts(), transcript: TRANSCRIPT });

    expect(readdirSync(join(v.knowledgeDir, "pay"))).toContain("stripe-idempotency-keys.md");
    expect(readdirSync(join(v.handoffDir, "pay", "main"))).toHaveLength(1);
    await store.close();
  });

  it("THE INVARIANT: delete ctxvault.db, rebuild from files — the vault comes back", async () => {
    const v = freshVault();

    // Save into vault #1.
    const store1 = new SqliteAdapter(v.dbPath, { knowledgeDir: v.knowledgeDir, handoffDir: v.handoffDir });
    const engine1 = new CtxEngine(store1);
    await engine1.save({ project: "pay", session: "main", handoff: note, facts: facts(), transcript: TRANSCRIPT });
    const before = {
      facts: (await engine1.listFacts("pay")).map((f) => [f.slug, f.title, f.body]),
      sessions: await engine1.listSessions("pay"),
    };
    const hitBefore = await engine1.search("pay", "idempotency", 5);
    await store1.close();

    // Delete the derived index. All of it, WAL and SHM included.
    rmSync(v.dbPath, { force: true });
    rmSync(`${v.dbPath}-wal`, { force: true });
    rmSync(`${v.dbPath}-shm`, { force: true });
    expect(existsSync(v.dbPath)).toBe(false);

    // Reopen on the same folders and rebuild from markdown — exactly `ctx reindex`.
    const store2 = new SqliteAdapter(v.dbPath, { knowledgeDir: v.knowledgeDir, handoffDir: v.handoffDir });
    const { facts: nFacts, handoffs: nHandoffs } = await store2.importFromFiles();
    store2.reindex();
    expect(nFacts).toBe(2);
    expect(nHandoffs).toBe(1);

    const engine2 = new CtxEngine(store2);
    const after = {
      facts: (await engine2.listFacts("pay")).map((f) => [f.slug, f.title, f.body]),
    };
    expect(after.facts).toEqual(before.facts);

    // The handoff survives with its structured note AND verbatim transcript.
    const latest = await engine2.getLatest("pay");
    expect(latest?.handoffNote).toEqual(note);
    expect(latest?.rawTranscript).toBe(TRANSCRIPT);
    expect((await engine2.listSessions("pay"))).toEqual(before.sessions);

    // Keyword search is fully restored — the half that must be keyless.
    const hitAfter = await engine2.search("pay", "idempotency", 5);
    expect(hitAfter.map((h) => h.refId)).toEqual(hitBefore.map((h) => h.refId));
    expect(hitAfter[0].filePath).toContain("stripe-idempotency-keys.md");
    await store2.close();
  });

  it("re-saving the same fact slug replaces it everywhere — no duplicate rows, files, or FTS hits", async () => {
    const v = freshVault();
    const store = new SqliteAdapter(v.dbPath, { knowledgeDir: v.knowledgeDir, handoffDir: v.handoffDir });
    const engine = new CtxEngine(store);

    await engine.save({ project: "pay", session: "s1", handoff: note, facts: facts(), transcript: "" });
    await engine.save({
      project: "pay",
      session: "s2",
      handoff: note,
      facts: [{ ...facts()[0], body: "UPDATED body: key = orderId only." }],
      transcript: "",
    });

    expect(await engine.listFacts("pay")).toHaveLength(2); // still two facts, not three
    expect((await engine.listFacts("pay")).find((f) => f.slug === "stripe-idempotency-keys")?.body)
      .toContain("UPDATED body");
    expect(readdirSync(join(v.knowledgeDir, "pay")).filter((f) => f.endsWith(".md")))
      .toHaveLength(2); // one file per fact

    // The FTS mirror must not carry a stale duplicate of the old body.
    const hits = await store.searchText("pay", "orderId", 20);
    const forSlug = hits.filter((h) => h.refId === "stripe-idempotency-keys");
    expect(forSlug).toHaveLength(1);
    expect(forSlug[0].text).toContain("UPDATED body");
    await store.close();
  });

  it("searches stay project-scoped — one project's memory never leaks into another's", async () => {
    const v = freshVault();
    const store = new SqliteAdapter(v.dbPath, { knowledgeDir: v.knowledgeDir, handoffDir: v.handoffDir });
    const engine = new CtxEngine(store);
    await engine.save({ project: "pay", session: "main", handoff: note, facts: [facts()[0]], transcript: "" });
    await engine.save({
      project: "shop",
      session: "main",
      handoff: note,
      facts: [{ ...facts()[1], slug: "shop-webhook-signature", title: "Shop webhook check" }],
      transcript: "",
    });

    expect(await engine.listFacts("pay")).toHaveLength(1);
    const hits = await engine.search("shop", "webhook signature", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.project === "shop")).toBe(true);
    await store.close();
  });
});
