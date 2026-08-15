import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { createRuntime } from "./runtime.js";
import { registerTools, SERVER_INFO } from "./tools.js";

/**
 * serve.ts — the SECOND front door: Streamable HTTP MCP on localhost.
 *
 * stdio only works for clients that can spawn a process. That rules out exactly
 * the surfaces people actually use next to their terminal: Claude in the
 * browser, a desktop app's remote-connector field, anything sandboxed. Those
 * speak HTTP MCP instead.
 *
 * So the same six tools get a URL. `ctx serve` starts one long-lived process
 * that owns the SQLite handle, and every HTTP client shares it — one vault, one
 * writer, many front doors.
 *
 * SAFETY, because this is memory on a port:
 *  - Binds 127.0.0.1 by default. The vault holds transcripts; it does not go on
 *    a LAN because a flag was easy to add.
 *  - Optional bearer token, compared in constant time.
 *  - DNS-rebinding protection is ON: a page you visit cannot POST to your vault
 *    just because it resolves a hostname to 127.0.0.1.
 *
 * STATELESS by choice. Each request gets its own McpServer + transport over the
 * SHARED engine. No session state means no session leak between clients and
 * nothing to reap on disconnect; the engine holds all the state worth holding,
 * and it holds it on disk.
 */

export interface ServeOptions {
  port: number;
  host: string;
  /** When set, every /mcp request must present `Authorization: Bearer <token>`. */
  token?: string;
  log: (msg: string) => void;
}

export const DEFAULT_PORT = 7077;
export const DEFAULT_HOST = "127.0.0.1";

/** Constant-time string compare — a plain `===` on a secret leaks its prefix. */
function tokenMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  // timingSafeEqual throws on length mismatch, which would itself be a signal;
  // compare lengths separately and always run the digest on equal-length input.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the bearer token out of the header, or the `token` query param. */
export function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Read and parse a JSON body, with a size cap so a bad client can't OOM us. */
async function readJsonBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function serve(opts: ServeOptions): Promise<void> {
  const { port, host, token, log } = opts;
  const { store, engine, searchStatus } = createRuntime(log);

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log(`request failed: ${(err as Error).message}`);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);

    // /health is deliberately unauthenticated and says nothing secret: it exists
    // so `ctx install` and a confused human can both answer "is it up?".
    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        server: SERVER_INFO,
        vault: config.home,
        search: searchStatus,
        authRequired: Boolean(token),
      });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found", hint: "MCP endpoint is POST /mcp" });
      return;
    }

    if (token) {
      const presented = extractToken(req);
      if (!presented || !tokenMatches(token, presented)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="ctxvault"');
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    // Stateless mode has no server→client stream to resume, so GET/DELETE (the
    // SSE and session-teardown verbs) have nothing to do.
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { error: "method not allowed", hint: "this server is stateless; use POST" });
      return;
    }

    const body = await readJsonBody(req);

    // Fresh server + transport per request. They're cheap objects; the engine
    // and its SQLite handle — the expensive part — are shared and long-lived.
    const server = new McpServer(SERVER_INFO);
    registerTools({
      server,
      engine,
      log: (...args: unknown[]) => log(args.map(String).join(" ")),
      // No cwd worth guessing over HTTP — see ToolDeps.defaultDir.
      defaultDir: null,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON replies; no SSE to hold open
      enableDnsRebindingProtection: true,
      allowedHosts: [`${host}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`],
    });

    // Tear both down when the response finishes, or every request leaks one.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });

  log(`CtxVault HTTP MCP on http://${host}:${port}/mcp`);
  log(`vault ${config.home} · search: ${searchStatus} · auth: ${token ? "bearer token" : "none (localhost only)"}`);

  const shutdown = () => {
    httpServer.close();
    void store.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Hold the process open until the server closes.
  await new Promise<void>((resolve) => httpServer.once("close", resolve));
}
