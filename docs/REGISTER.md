# Registering CtxVault in your AI CLIs

CtxVault is an MCP server. Any MCP-capable tool can launch it. It stores memory in
`~/.ctxvault/` by default, so **all your tools share one vault** — that's what makes
the handoff work.

You can run the whole thing for **free**: either on OpenRouter's free model tier, or
fully offline with Ollama. See [Zero-cost setups](#zero-cost-setups) below.

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
claude mcp add ctxvault -- node <CTXVAULT_PATH>
```

Verify inside Claude Code with `/mcp` — you should see `ctxvault` with five tools:
`save_context`, `resume_context`, `search_memory`, `list_facts`, `list_sessions`.

To pass API keys, either use `claude mcp add -e KEY=value ...` (check
`claude mcp add --help` for your version's exact flag) or edit the generated config
directly, as shown in [section 4](#4-choosing-a-model-and-passing-keys).

### Codex

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.ctxvault]
command = "node"
args = ["<CTXVAULT_PATH>"]

[mcp_servers.ctxvault.env]
CTXVAULT_MODEL = "openrouter:<model-id>"
OPENROUTER_API_KEY = "sk-or-..."
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
      "args": ["<CTXVAULT_PATH>"],
      "env": {
        "CTXVAULT_MODEL": "openrouter:<model-id>",
        "OPENROUTER_API_KEY": "sk-or-..."
      }
    }
  }
}
```

## 4. Choosing a model and passing keys

> ⚠️ **The MCP server does not read `.env` files.** It has no dotenv dependency. It's
> a stdio process spawned by your MCP client, so it only sees the environment that
> client hands it — which means **keys go in the `env` block of your client's config**
> (the examples above). A `.env` in the repo root will be ignored. (The `.env.local`
> file mentioned in [PLAYGROUND.md](PLAYGROUND.md) applies only to the Next.js
> playground, which is a separate app.)

Every model call goes through the [Vercel AI SDK](https://sdk.vercel.ai), so the
provider is configuration, not code. Name a model as `<provider>:<model-id>`:

| Variable | Purpose | Default |
|---|---|---|
| `CTXVAULT_MODEL` | Summarizer + fact extractor | `anthropic:claude-opus-4-8` |
| `CTXVAULT_EMBED_MODEL` | Embeddings for semantic search | `openai:text-embedding-3-small` |
| `CTXVAULT_HOME` | Where the vault lives | `~/.ctxvault` |
| `CTXVAULT_NO_AI=1` | Force raw storage + lexical search | off |

Providers and the key each one reads:

| Provider prefix | Key variable |
|---|---|
| `anthropic:` | `ANTHROPIC_API_KEY` |
| `openai:` | `OPENAI_API_KEY` |
| `openrouter:` | `OPENROUTER_API_KEY` |
| `compatible:` | `CTXVAULT_API_KEY` + `CTXVAULT_BASE_URL` |

`compatible:` covers anything speaking the OpenAI wire format — Ollama, Groq,
Together, vLLM, LM Studio — with no extra dependency. For local servers the key is
usually ignored; what enables the provider is `CTXVAULT_BASE_URL`.

Note that `anthropic:` is never valid for `CTXVAULT_EMBED_MODEL` — Anthropic ships no
embeddings endpoint, which is why the embedding model is configured separately.

## Zero-cost setups

### Option A — OpenRouter free tier (one key, nothing to install)

OpenRouter serves both chat and embeddings, so a single key covers the whole product.

```json
"env": {
  "CTXVAULT_MODEL": "openrouter:<free-model-id>",
  "CTXVAULT_EMBED_MODEL": "openrouter:openai/text-embedding-3-small",
  "OPENROUTER_API_KEY": "sk-or-..."
}
```

Two things to watch:

- **Pick a model that supports structured outputs.** The summarizer and fact
  extractor use the AI SDK's `generateObject`, which hands the provider a schema as a
  native structured-output constraint. A model that can't honour it will fail, and
  CtxVault degrades to raw storage — you'll still have your transcript, but no
  HandoffNote and no OKF facts. Filter for structured-output support on
  [openrouter.ai/models](https://openrouter.ai/models) before choosing.
- **Free tiers rate-limit hard.** Transcripts over 20k chars trigger a map-reduce
  that issues several chunk requests in parallel, which can trip a 429 on a free key.
  Saving more often, in smaller chunks, avoids it.

### Option B — Ollama, fully offline (no key, no network, no limits)

```bash
ollama pull llama3.1
ollama pull nomic-embed-text
ollama serve
```

```json
"env": {
  "CTXVAULT_MODEL": "compatible:llama3.1",
  "CTXVAULT_EMBED_MODEL": "compatible:nomic-embed-text",
  "CTXVAULT_BASE_URL": "http://localhost:11434/v1"
}
```

Nothing leaves your machine — worth knowing if your transcripts are confidential.
Structured-output quality varies by model here too; if you get raw storage instead of
HandoffNotes, try a larger model before assuming something is broken.

### Option C — no keys at all

Run it with nothing configured. `save_context` stores raw transcripts and
`search_memory` uses a local hashing-based lexical embedder. You lose HandoffNotes,
OKF facts, and semantic matching — but the handoff still works, and nothing errors.

## 5. Verifying it works

The server logs one status line to **stderr** at boot (stdout is reserved for the
JSON-RPC protocol). Find it in your client's MCP server logs:

```
[ctxvault] CtxVault MCP server ready. DB: /Users/you/.ctxvault/ctxvault.db. AI: on (openrouter:...). Embeddings: ...
```

`AI: on (<model>)` means summarization is live. Anything else tells you why not:

| Status | Meaning | Fix |
|---|---|---|
| `off (no API key for <ref>)` | Provider key missing from the client's `env` block | Add the key variable from the table in section 4 |
| `off (bad CTXVAULT_MODEL: …)` | Typo in the model ref | Use `<provider>:<model-id>` |
| `off (--no-ai)` | Explicitly disabled | Remove `--no-ai` / `CTXVAULT_NO_AI` |

If saves succeed but report *"Stored as raw text"* with 0 facts while AI shows `on`,
the model reached the API but couldn't satisfy the structured-output schema — see the
structured-outputs note under Option A.

## 6. Proving the handoff (the money demo)

1. In **Claude Code**, do some work, then say: *"save this to ctxvault under project
   `myapp`"*. Claude calls `save_context`.
2. Open **Codex**. Say: *"resume project `myapp` from ctxvault"*. Codex calls
   `resume_context` and continues the task.

Because both tools write to the same `~/.ctxvault/ctxvault.db`, the second tool sees
what the first one saved — even though they never talked to each other.

## 7. Using a clean vault for demos

Set `CTXVAULT_HOME` to an empty dir so a demo starts fresh:

```bash
CTXVAULT_HOME=/tmp/demo-vault node <CTXVAULT_PATH>
```
