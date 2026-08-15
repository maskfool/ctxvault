import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  CtxEngine,
  MemoryAdapter,
  VercelEmbedder,
  languageModelRef,
  embeddingModelRef,
  hasApiKey,
  canEmbed,
  type Embedder,
} from "@ctxvault/engine/web";

/**
 * session.ts — per-browser-session engine registry for the hosted playground.
 *
 * Vercel is stateless, so we can't share one durable store. Instead each visitor
 * gets their OWN in-memory engine, keyed by a cookie. That's the honest tradeoff
 * we state on the page: memory lives for your session. Crucially, the SAME
 * CtxEngine runs here as in the local MCP server — only the adapter differs
 * (MemoryAdapter instead of SqliteAdapter). One engine, two front doors.
 */
export const SID_COOKIE = "ctx_sid";
export const PROJECT = "playground"; // single demo project

/**
 * Registries live on globalThis, not module scope. Next.js can give each API
 * route its OWN copy of this module, so a plain `const engines = new Map()`
 * would not be shared between /api/save and /api/resume — a save would vanish on
 * resume. globalThis is one-per-process, so all routes in a warm instance share
 * it. (Across cold Vercel instances state can still reset — that's the stated
 * "memory lives for your session" tradeoff.)
 */
const g = globalThis as unknown as {
  __ctxEngines?: Map<string, CtxEngine>;
  __ctxHits?: Map<string, { count: number; windowStart: number }>;
};
const engines = (g.__ctxEngines ??= new Map<string, CtxEngine>());

export function getEngine(sid: string): CtxEngine {
  let engine = engines.get(sid);
  if (!engine) {
    const store = new MemoryAdapter();
    // No LLM: the engine has none since v2. The agent's job (writing the
    // handoff) is played by lib/distill.ts, on the playground's side of the line.
    // No embedder either unless a key is configured — keyword search is built in.
    const embedder: Embedder | null = embeddingsEnabled()
      ? new VercelEmbedder({ ref: embedRef() })
      : null;
    engine = new CtxEngine(store, embedder);
    engines.set(sid, engine);
  }
  return engine;
}

export function resetEngine(sid: string): void {
  engines.delete(sid);
}

/**
 * Which models this deployment runs. Set CTXVAULT_MODEL / CTXVAULT_EMBED_MODEL
 * in the Vercel project settings to swap providers (Anthropic, OpenAI,
 * OpenRouter, …) without changing code.
 *
 * These are FUNCTIONS, not consts, and that is deliberate: a module-scope
 * `const X = process.env...` freezes the answer at import time, which makes the
 * reported status depend on module-evaluation order rather than on the actual
 * configuration. Reading per call keeps the UI badge honest.
 */
export const modelRef = () => languageModelRef();
export const embedRef = () => embeddingModelRef();

/**
 * True when the playground can act as a real agent — chat replies, and writing
 * the handoff in lib/distill.ts. Note what this does NOT gate: saving, resuming,
 * searching and exporting all work without it, because the engine itself has no
 * model. This flag is a property of the *demo*, not of CtxVault.
 */
export const aiEnabled = () => hasApiKey(modelRef());

/** True when embeddings can upgrade search to hybrid; keyword search is always on. */
export const embeddingsEnabled = () => canEmbed(embedRef());

// --- rate limiting ----------------------------------------------------------
/**
 * Two buckets, because one of them is trivially bypassable.
 *
 * The session bucket is keyed by the `sid` COOKIE — which the client controls.
 * A caller that simply never sends a cookie gets a fresh uuid on every request,
 * so its bucket is always empty and the limit never fires. `curl` in a loop with
 * no cookie jar would have made unlimited model calls on the deployer's bill.
 *
 * So the IP bucket is the real backstop: it keys on something the caller cannot
 * choose. The session bucket stays because it gives a well-behaved browser a
 * fair per-tab allowance even when it shares an IP (office, campus, NAT).
 *
 * The AI bucket is separate and much tighter, because /api/chat is the only
 * route that costs money — save, resume, search and export are pure local
 * compute and don't deserve the same suspicion.
 */
const hits = (g.__ctxHits ??= new Map<string, { count: number; windowStart: number }>());
const WINDOW_MS = 60_000;
const MAX_PER_SESSION = 40;
const MAX_PER_IP = 60;
const MAX_AI_PER_IP = 15;

/** The caller's address as the proxy saw it. Unspoofable by the page itself. */
function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Count one hit against `key`. True means "over the limit, reject".
 *
 * Also prunes expired buckets: the cookie-less caller above would otherwise add
 * a new map entry per request and leak memory until the instance recycled.
 */
function hit(key: string, max: number, now = Date.now()): boolean {
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now - v.windowStart > WINDOW_MS) hits.delete(k);
  }
  const rec = hits.get(key);
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    hits.set(key, { count: 1, windowStart: now });
    return false;
  }
  rec.count++;
  return rec.count > max;
}

/** True when this request should be rejected with a 429. */
export function rateLimited(req: NextRequest, sid: string, costsMoney = false): boolean {
  const ip = clientIp(req);
  if (costsMoney && hit(`ai:${ip}`, MAX_AI_PER_IP)) return true;
  if (hit(`ip:${ip}`, MAX_PER_IP)) return true;
  return hit(`sid:${sid}`, MAX_PER_SESSION);
}

/**
 * Wrap a route handler with session resolution: reads (or mints) the sid cookie,
 * hands the caller the sid + its engine, and JSON-encodes the result. Sets the
 * cookie on the way out for new sessions.
 */
export async function withSession(
  req: NextRequest,
  fn: (ctx: { sid: string; engine: CtxEngine }) => Promise<unknown>,
  opts: { costsMoney?: boolean } = {},
): Promise<NextResponse> {
  let sid = req.cookies.get(SID_COOKIE)?.value;
  const isNew = !sid;
  if (!sid) sid = randomUUID();

  if (rateLimited(req, sid, opts.costsMoney)) {
    return NextResponse.json(
      { error: "Rate limited — this is a public demo, please slow down." },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  const data = await fn({ sid, engine: getEngine(sid) });
  const res = NextResponse.json(data);
  if (isNew) {
    res.cookies.set(SID_COOKIE, sid, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24,
    });
  }
  return res;
}
