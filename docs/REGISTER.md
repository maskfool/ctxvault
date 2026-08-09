# Registering CtxVault in your AI CLIs

CtxVault is an MCP server. Any MCP-capable tool can launch it. It stores memory in
`~/.ctxvault/` by default, so **all your tools share one vault** — that's what makes
the handoff work.

**There is nothing to configure.** No API key, no model, no env block. CtxVault ships
no LLM: your agent writes the handoff itself, and search is keyword-based out of the
box. The only optional setting on this page upgrades search to hybrid.

---

## 1. Prerequisites

- **Node 18+** (`node -v`)
- A C toolchain, because `better-sqlite3` compiles natively. macOS: Xcode command
  line tools. Debian/Ubuntu: `sudo apt install build-essential python3`.

## 2. Install and build

```bash
git clone <repo-url> && cd ctxvault
npm install
npm run build      # builds the engine, then apps/mcp-server/dist/index.js
```

The server entry point is `apps/mcp-server/dist/index.js`. Every command below needs
its **absolute** path — from the repo root, print it once and keep it handy:

```bash
echo "$(pwd)/apps/mcp-server/dist/index.js"
```

That path is written as `<CTXVAULT_PATH>` throughout this doc. Substitute your own.

> **Rebuild after pulling.** The MCP client runs `dist/`, not `src/`. Any code change
> needs `npm run build` before the server sees it.

## 3. Register with your client

### Claude Code

```bash
claude mcp add ctxvault -s user -- node <CTXVAULT_PATH>
```

Verify inside Claude Code with `/mcp` — you should see `ctxvault` with six tools:
`save_context`, `resume_context`, `export_context`, `search_memory`, `list_facts`,
`list_sessions`.

### Codex

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.ctxvault]
command = "node"
args = ["<CTXVAULT_PATH>"]
```

Restart Codex; the tools become available.

### Any other MCP client

Point it at `node <CTXVAULT_PATH>` as a **stdio** MCP server. Most clients use a JSON
config of this shape:

```json
{
  "mcpServers": {
    "ctxvault": {
      "command": "node",
      "args": ["<CTXVAULT_PATH>"]
    }
  }
}
```

### The `ctx` CLI (optional, but useful)

The same build ships a `ctx` binary for driving the vault by hand — including for
tools that will never support MCP:

```bash
npm link --workspace=@ctxvault/mcp-server   # or call node <repo>/apps/mcp-server/dist/cli.js

ctx export | pbcopy      # paste into claude.ai / ChatGPT / Gemini
ctx export --to claude   # write a bounded block into CLAUDE.md
ctx search "argon2"
ctx list
```

## 4. Optional: upgrade search to hybrid

Keyword search (SQLite FTS5/BM25) is always on and needs nothing. Setting an
**embedding** model adds vector similarity on top, which mainly helps when your query
paraphrases the stored note instead of sharing its terms.

> ⚠️ **The MCP server does not read `.env` files.** It has no dotenv dependency. It's
> a stdio process spawned by your MCP client, so it only sees the environment that
> client hands it — which means any key goes in the `env` block of your client's
> config. A `.env` in the repo root will be ignored. (The `.env.local` file mentioned
> in [PLAYGROUND.md](PLAYGROUND.md) applies only to the Next.js playground, which is a
> separate app.)

| Variable | Purpose | Default |
|---|---|---|
| `CTXVAULT_EMBED_MODEL` | Embeddings → hybrid search | *(unset — keyword only)* |
| `CTXVAULT_HOME` | Where the vault lives | `~/.ctxvault` |

Name a model as `<provider>:<model-id>`. Providers and the key each one reads:

| Provider prefix | Key variable |
|---|---|
| `openai:` | `OPENAI_API_KEY` |
| `openrouter:` | `OPENROUTER_API_KEY` |
| `compatible:` | `CTXVAULT_API_KEY` + `CTXVAULT_BASE_URL` |

```json
"env": {
  "CTXVAULT_EMBED_MODEL": "openai:text-embedding-3-small",
  "OPENAI_API_KEY": "sk-..."
}
```

`compatible:` covers anything speaking the OpenAI wire format — Ollama, Groq,
Together, vLLM, LM Studio — with no extra dependency. For local servers the key is
usually ignored; what enables the provider is `CTXVAULT_BASE_URL`:

```bash
ollama pull nomic-embed-text && ollama serve
```
```json
"env": {
  "CTXVAULT_EMBED_MODEL": "compatible:nomic-embed-text",
  "CTXVAULT_BASE_URL": "http://localhost:11434/v1"
}
```

`anthropic:` is never valid here — Anthropic ships no embeddings endpoint.

**Worth knowing before you bother:** on a vault of short, titled, tagged notes full of
distinctive technical terms, keyword search is already strong, and your agent can
re-query with different words when the first try misses. Hybrid is a real improvement
on paraphrased queries, not a fix for something broken. See [SEARCH.md](SEARCH.md).

## 5. Verifying it works

The server logs one status line to **stderr** at boot (stdout is reserved for the
JSON-RPC protocol). Find it in your client's MCP server logs:

```
[ctxvault] CtxVault MCP server ready. DB: /Users/you/.ctxvault/ctxvault.db. Search: keyword (BM25) — set CTXVAULT_EMBED_MODEL + key for hybrid.
```

| Status | Meaning |
|---|---|
| `Search: keyword (BM25) — set …` | Default. Everything works; vector search is off |
| `Search: hybrid (BM25 + <model>)` | Embeddings live |
| `Search: keyword (BM25) — embedder unavailable` | Bad ref or missing key; search still works |

There is no "AI on/off" line any more, because there is no AI in the server. If a save
reports `mode: "raw"` with 0 facts, the calling agent didn't fill in the `handoff`
argument — ask it to save again and be explicit that it should write the summary.

## 6. Proving the handoff (the money demo)

1. In **Claude Code**, do some work, then say: *"save this to ctxvault under project
   `myapp`"*. Claude calls `save_context` and writes the handoff itself.
2. Open **Codex**. Say: *"resume project `myapp` from ctxvault"*. Codex calls
   `resume_context` and continues the task.

Because both tools write to the same `~/.ctxvault/ctxvault.db`, the second tool sees
what the first one saved — even though they never talked to each other.

For a tool without MCP, step 2 becomes `ctx export | pbcopy` and a paste.

## 7. Using a clean vault for demos

Set `CTXVAULT_HOME` to an empty dir so a demo starts fresh:

```bash
CTXVAULT_HOME=/tmp/demo-vault node <CTXVAULT_PATH>
```
