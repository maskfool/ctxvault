# Registering CtxVault in your AI CLIs

CtxVault is an MCP server. Any MCP-capable tool can launch it. It stores memory in
`~/.ctxvault/` by default, so **all your tools share one vault** — that's what makes
the handoff work.

First build it once:

```bash
cd /Users/shubham/Developer/gen-ai/ctxvault
npm install
npm run build      # produces apps/mcp-server/dist/index.js
```

The server entry point is:

```
/Users/shubham/Developer/gen-ai/ctxvault/apps/mcp-server/dist/index.js
```

---

## Claude Code

**Option A — CLI (recommended):**

```bash
claude mcp add ctxvault -- node /Users/shubham/Developer/gen-ai/ctxvault/apps/mcp-server/dist/index.js
```

**Option B — project file:** the repo already ships a `.mcp.json` at its root. Open
Claude Code inside `ctxvault/` and it will offer to enable the `ctxvault` server.

Verify inside Claude Code:

```
/mcp          # should list "ctxvault" with save_context, resume_context, list_sessions
```

## Codex

Edit `~/.codex/config.toml` and add:

```toml
[mcp_servers.ctxvault]
command = "node"
args = ["/Users/shubham/Developer/gen-ai/ctxvault/apps/mcp-server/dist/index.js"]
```

Restart Codex; the three tools become available.

## Gemini CLI (and other MCP clients)

Same idea — point the client at `node <path>/dist/index.js` as a stdio MCP server.

---

## Proving the handoff (the money demo)

1. In **Claude Code**, do some work, then say: *"save this to ctxvault under project `myapp`"*.
   Claude calls `save_context`.
2. Open **Codex**. Say: *"resume project `myapp` from ctxvault"*. Codex calls
   `resume_context` and continues the task.

Because both tools write to the same `~/.ctxvault/ctxvault.db`, the second tool sees
what the first one saved — even though they never talked to each other.

## Using a clean vault for demos

Set `CTXVAULT_HOME` to an empty dir so a demo starts fresh:

```bash
CTXVAULT_HOME=/tmp/demo-vault node apps/mcp-server/dist/index.js
```
