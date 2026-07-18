import { homedir } from "node:os";
import { join } from "node:path";

/**
 * config.ts — where CtxVault keeps its local memory on disk.
 *
 * Defaults to ~/.ctxvault so memory survives across every project and tool.
 * Override with CTXVAULT_HOME (handy for tests / demos with a clean vault).
 */
const home = process.env.CTXVAULT_HOME ?? join(homedir(), ".ctxvault");

export const config = {
  home,
  dbPath: join(home, "ctxvault.db"),
  knowledgeDir: join(home, "knowledge"), // OKF markdown files (Phase 2)
};
