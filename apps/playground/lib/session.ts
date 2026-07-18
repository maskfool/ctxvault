import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import {
  CtxEngine,
  MemoryAdapter,
  LocalEmbedder,
  VercelEmbedder,
  VercelLLM,
  languageModelRef,
  embeddingModelRef,
  hasApiKey,
  canEmbed,
  type Embedder,
  type LLM,
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
    const llm: LLM | null = aiEnabled() ? new VercelLLM({ ref: modelRef() }) : null;
    const embedder: Embedder = embeddingsEnabled()
      ? new VercelEmbedder({ ref: embedRef() })
      : new LocalEmbedder();
    engine = new CtxEngine(store, llm, embedder);
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

/** True when a real summarizer/fact-extractor is available (key present). */
export const aiEnabled = () => hasApiKey(modelRef());

/** True when real embeddings are available; otherwise search uses LocalEmbedder. */
export const embeddingsEnabled = () => canEmbed(embedRef());

// --- tiny per-session rate limiter -----------------------------------------
const hits = (g.__ctxHits ??= new Map<string, { count: number; windowStart: number }>());
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 40;

export function rateLimited(sid: string): boolean {
  const now = Date.now();
  const rec = hits.get(sid);
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    hits.set(sid, { count: 1, windowStart: now });
    return false;
  }
  rec.count++;
  return rec.count > MAX_PER_WINDOW;
}

/**
 * Wrap a route handler with session resolution: reads (or mints) the sid cookie,
 * hands the caller the sid + its engine, and JSON-encodes the result. Sets the
 * cookie on the way out for new sessions.
 */
export async function withSession(
  req: NextRequest,
  fn: (ctx: { sid: string; engine: CtxEngine }) => Promise<unknown>,
): Promise<NextResponse> {
  let sid = req.cookies.get(SID_COOKIE)?.value;
  const isNew = !sid;
  if (!sid) sid = randomUUID();

  if (rateLimited(sid)) {
    return NextResponse.json({ error: "rate limited, slow down" }, { status: 429 });
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
