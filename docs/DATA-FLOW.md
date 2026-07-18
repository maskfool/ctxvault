# Data flow — how a request moves through CtxVault

Every box below names the **file, function, and library** that actually does the
work. Read this alongside [CODE-TOUR.md](CODE-TOUR.md), which walks the tree;
this doc walks the *data*.

---

## 1. The whole picture

```mermaid
flowchart TD
    CLI["Claude Code · Codex · any MCP client"]

    subgraph FRONT["🚪 FRONT DOOR — apps/mcp-server"]
        T["StdioServerTransport<br/><i>@modelcontextprotocol/sdk</i>"]
        SRV["McpServer · 5 registered tools<br/><i>src/index.ts</i> · args validated by <b>zod</b>"]
        CFG["config.ts<br/>CTXVAULT_HOME → ~/.ctxvault"]
        T --> SRV
        SRV -.reads.-> CFG
    end

    CLI <-->|"JSON-RPC over stdin/stdout"| T
    SRV -->|"save / resume / search / listFacts / listSessions"| ENG

    subgraph BRAIN["🧠 ENGINE — packages/engine/src/engine.ts"]
        ENG["CtxEngine<br/>transport-agnostic, imports no SDK"]
    end

    ENG --> SEAM1
    ENG --> SEAM2
    ENG --> SEAM3

    subgraph SEAM1["seam: LLM"]
        L1["VercelLLM<br/><i>llm/vercel.ts</i>"]
        L2["ai/provider.ts<br/>CTXVAULT_MODEL"]
        L3["Vercel AI SDK<br/>generateObject · generateText"]
        L1 --> L2 --> L3
        L3 --> LP["Anthropic · OpenAI · OpenRouter · compatible"]
    end

    subgraph SEAM2["seam: Embedder"]
        E1["VercelEmbedder · embedMany<br/><i>embed/vercel.ts</i>"]
        E2["LocalEmbedder · FNV-1a, 256 dims<br/><i>embed/local.ts</i> — no key, no network"]
    end

    subgraph SEAM3["seam: StorageAdapter"]
        S1["SqliteAdapter<br/><i>better-sqlite3</i>, synchronous"]
        S2["MemoryAdapter<br/>Map — Vercel playground"]
        S1 --> DB[("~/.ctxvault/ctxvault.db<br/>snapshots · facts · vectors")]
        S1 --> OKF[("knowledge/PROJECT/SLUG.md<br/>OKF via <i>gray-matter</i>")]
    end
```

**The seams are the design.** `CtxEngine` depends on three interfaces —
`LLM`, `Embedder`, `StorageAdapter` — and never on a concrete provider. That's
what lets the same engine run over stdio locally and HTTP on Vercel, and what
makes `--no-ai` a graceful degrade instead of a dead button.

---

## 2. SAVE — transcript in, memory out

```mermaid
flowchart TD
    IN["save_context<br/>{project, transcript, session}"] --> ENG["CtxEngine.save<br/><i>engine.ts:60</i>"]

    ENG --> HASLLM{"this.llm ?"}
    HASLLM -->|"null · no key or noAi"| RAW["mode = 'raw'<br/>store transcript verbatim"]

    subgraph INTEL["intelligence — best-effort, never fails the save"]
        COND["condense<br/>over 20k chars → map-reduce<br/>15k chunks → 120-word digests"]
        COND --> SUM["summarize → generateObject<br/>HandoffNoteGenSchema<br/><i>llm/vercel.ts</i>"]
        COND --> FACT["extractFacts → generateObject<br/>output:'array', FactGenSchema"]
        SUM --> V1["HandoffNoteSchema.parse<br/><i>zod re-validation</i>"]
        FACT --> V2["slugify each slug<br/><i>lib/slug.ts</i> — untrusted → filename"]
    end

    HASLLM -->|"yes"| COND
    SNAP["store.saveSnapshot<br/>→ snapshots table"]
    V1 --> SNAP
    RAW --> SNAP

    SNAP --> IDX["embedTextFor note, transcript<br/><i>engine.ts:277</i>"]
    IDX --> EMB["embedder.embed → saveVector<br/>kind='handoff', refId=snapshot.id"]

    V2 --> FLOOP["for each fact"]
    FLOOP --> SF["store.saveFact — upsert by project+slug<br/>SqliteAdapter also writes the OKF file"]
    SF --> FV["embed fact body → saveVector<br/>kind='fact', carries filePath"]

    EMB --> OUT["SaveResult<br/>{snapshotId, mode, factsExtracted, warning?}"]
    FV --> OUT
```

**Pointers per box**

| Box | Where | Notes |
|---|---|---|
| map-reduce | `llm/vercel.ts` | threshold 20k chars, `CHUNK_SIZE` 15k, digests capped at 400 output tokens |
| structured output | `ai` v7 `generateObject` | the zod schema is a **native provider constraint**, not a prompt request |
| schema re-validation | `types.ts` | `HandoffNoteSchema` / `FactsArraySchema` — the model's output is never trusted raw |
| snapshot row | `storage/sqlite.ts` | `snapshots(id, project, session, created_at, raw_transcript, handoff_json)` |
| fact upsert | `storage/sqlite.ts` | PK `(project, slug)` — same slug **overwrites**, no merge |
| OKF file | `okf/okf.ts` | `matter.stringify` → frontmatter + body |
| vector row | `storage/sqlite.ts` | embedding stored as **JSON text**, not a blob |

> Every intelligence step is wrapped in `try/catch` and pushes to `warnings[]`.
> A model outage degrades to `mode: "raw"` — the save itself always succeeds.

---

## 3. RESUME — the priority stack

```mermaid
flowchart TD
    IN["resume_context<br/>{project, budget = 4000}"] --> B["tokensToChars = budget × 4<br/><i>lib/tokens.ts</i>"]
    B --> GL["store.getLatest project"]
    GL --> NONE{"found ?"}
    NONE -->|no| MSG["'No saved context' message"]

    subgraph GATHER["gather"]
        LF["store.listFacts"]
        RANK["rankFactsForHandoff<br/>query = goal + nextStep + openTodos<br/>→ search k=15 → top 5"]
        LF --> RANK
    end

    subgraph STACK["priority stack — truncate lowest first"]
        P1["1 · header + HandoffNote<br/>renderHandoffNote — forced in"]
        P2["2 · knowledge index<br/>renderFactIndex — title + 90-char snippet"]
        P3["3 · relevant fact bodies<br/>added while they fit"]
        P4["4 · recent transcript tail<br/>truncateHead — fills remaining budget"]
        P1 --> P2 --> P3 --> P4
    end

    NONE -->|yes| GATHER
    RANK --> STACK
    STACK --> OUT["ResumeResult<br/>{packed, estimatedTokens, nextStep}"]
```

Priorities 1 and 2 are small and high-signal, so they go in whole. 3 and 4
compete for whatever budget is left — which is why the token estimate
(`chars / 4`) matters, and why it runs optimistic on code-heavy text.

---

## 4. SEARCH — retrieval and ranking

```mermaid
flowchart LR
    Q["search_memory<br/>{project, query, k=5}"] --> QE["embedder.embed [query]"]
    QE --> POOL["pool = min 50, max k×5<br/><i>engine.ts:165</i>"]
    POOL --> SC["store.search"]

    subgraph SCAN["SqliteAdapter.search — brute force"]
        R1["SELECT * FROM vectors WHERE project = ?"]
        R2["JSON.parse each embedding_json"]
        R3["cosineSimilarity<br/><i>lib/vector.ts</i>"]
        R1 --> R2 --> R3
    end

    SC --> SCAN
    SCAN --> RR["rankHits<br/><i>retriever.ts</i>"]
    RR --> F["0.6·similarity<br/>+ 0.3·recencyDecay 3-day half-life<br/>+ 0.1·sameProject"]
    F --> TOP["slice k → SearchHit[]"]
```

Two things worth knowing about this path:

- **No ANN index.** Every query loads and scans every vector in the project.
  Fine at hundreds of vectors, and honest about it — but it's a linear scan.
- **Recency is a first-class ranking signal.** A fresh near-match beats a stale
  exact match by design; the 3-day half-life never zeroes an old memory out.

---

## 5. The five MCP tools

| Tool | Engine call | Returns |
|---|---|---|
| `save_context` | `engine.save` | snapshot id, mode, fact count, any warning |
| `resume_context` | `engine.resume` | the packed context block |
| `search_memory` | `engine.search` | ranked hits with score + file path |
| `list_facts` | `engine.listFacts` | every OKF fact for a project |
| `list_sessions` | `engine.listSessions` | sessions + snapshot counts |

Tool *descriptions* are written as prompts — they tell the calling model **when**
to reach for the tool, in its own decision-making language. That text is part of
the product, not documentation.

> ⚠️ **Golden rule** (`apps/mcp-server/src/index.ts`): the transport owns stdout.
> Every log goes to **stderr** via `console.error`. One stray `console.log`
> corrupts the JSON-RPC stream and the client silently drops the server.

---

## 6. Configuration — what changes behaviour

| Variable | Default | Effect |
|---|---|---|
| `CTXVAULT_MODEL` | `anthropic:claude-opus-4-8` | `<provider>:<model-id>` — anthropic, openai, openrouter, compatible |
| `CTXVAULT_EMBED_MODEL` | `openai:text-embedding-3-small` | separate, because Anthropic has no embeddings endpoint |
| `CTXVAULT_BASE_URL` | — | required by `compatible:` — Ollama, Groq, vLLM, LM Studio |
| `CTXVAULT_HOME` | `~/.ctxvault` | DB + knowledge dir location |
| `CTXVAULT_NO_AI` / `--no-ai` | off | forces raw storage + LocalEmbedder |

Resolution lives in `ai/provider.ts`; `hasApiKey` decides on-vs-off, and
`canEmbed` is stricter — it also rejects providers with no embeddings API.

---

## 7. Known lossy edges

Being explicit about where fidelity is spent, since this is memory software:

1. **The raw transcript is stored but not indexed** when a HandoffNote exists —
   `embedTextFor` prefers the note. Anything the summarizer dropped is
   unreachable by search.
2. **Fact-body packing stops at the first fact that doesn't fit**
   (`break`, not `continue`) — one large fact can block smaller ones behind it.
3. **`condense` runs twice** for >20k transcripts — once in `summarize`, once in
   `extractFacts` — so the note and the facts derive from independent digests.
4. **Resume reads only `getLatest`** — earlier snapshots in the same session
   contribute nothing unless their content became a durable fact.
5. **Facts overwrite on slug collision** with no merge, so an evolving fact loses
   its prior nuance.
