import { homedir } from "node:os";
import { join } from "node:path";

/**
 * config.ts — where CtxVault keeps its local memory on disk.
 *
 * Defaults to ~/.ctxvault so memory survives across every project and tool.
 * Override with CTXVAULT_HOME (handy for tests / demos with a clean vault).
 */
const home = process.env.CTXVAULT_HOME ?? join(homedir(), ".ctxvault");

/**
 * The two markdown trees are the vault's SOURCE OF TRUTH; the .db beside them is
 * a derived index that `ctx reindex` can rebuild from scratch. That's what makes
 * `ctx sync` a plain folder sync rather than a database-replication problem.
 */
export const config = {
  home,
  dbPath: join(home, "ctxvault.db"),
  knowledgeDir: join(home, "knowledge"), // OKF fact files
  handoffDir: join(home, "handoffs"), // one markdown file per saved session
};
