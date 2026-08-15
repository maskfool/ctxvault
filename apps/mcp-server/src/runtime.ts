import {
  CtxEngine,
  SqliteAdapter,
  VercelEmbedder,
  canEmbed,
  embeddingModelRef,
  type Embedder,
} from "@ctxvault/engine";
import { config } from "./config.js";

/**
 * runtime.ts — one way to open the vault.
 *
 * Four front doors now reach the same memory: stdio MCP (index.ts), HTTP MCP
 * (serve.ts), the human CLI (cli.ts) and the auto-capture hook (hook.ts). They
 * must open the vault identically — same SQLite file, same markdown trees, same
 * embedder decision — or "the same vault everywhere" quietly stops being true.
 * So the decision lives here once and the front doors just call it.
 */

export interface Runtime {
  store: SqliteAdapter;
  engine: CtxEngine;
  /** Human-readable search capability, for logs and `ctx doctor`-style output. */
  searchStatus: string;
}

/**
 * Build the embedder, or don't. Never throws: keyword search (BM25/FTS5) needs
 * no key, no network and no model download, so a missing or broken embedder is
 * a downgrade to lexical search — never a failure to start. (AGENTS.md rule 8.)
 */
function buildEmbedder(log: (msg: string) => void): { embedder: Embedder | null; status: string } {
  const ref = embeddingModelRef();
  if (!canEmbed(ref)) {
    return {
      embedder: null,
      status: "keyword (BM25) — set CTXVAULT_EMBED_MODEL + key for hybrid",
    };
  }
  try {
    const embedder = new VercelEmbedder({ ref });
    return { embedder, status: `hybrid (BM25 + ${embedder.id})` };
  } catch (err) {
    log(`embedder ${ref} unavailable (${(err as Error).message}); keyword search only`);
    return { embedder: null, status: "keyword (BM25) — embedder unavailable" };
  }
}

/**
 * Open the vault. `log` goes to stderr in every caller — stdout belongs to the
 * MCP protocol in one of them, and to pipeable output in another.
 */
export function createRuntime(log: (msg: string) => void = () => {}): Runtime {
  // knowledgeDir/handoffDir on → facts and handoffs are written as readable
  // markdown, which is what makes the .db a rebuildable index rather than the
  // source of truth (see sync.ts).
  const store = new SqliteAdapter(config.dbPath, {
    knowledgeDir: config.knowledgeDir,
    handoffDir: config.handoffDir,
  });
  const { embedder, status } = buildEmbedder(log);
  return { store, engine: new CtxEngine(store, embedder), searchStatus: status };
}
