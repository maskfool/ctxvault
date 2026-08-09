# Search — keyword by default, hybrid if you want it

> Replaces the old `EMBEDDINGS.md`, which described a vector-only search where an
> API key was the price of entry.

`search_memory("what did we decide about auth")` has to find the right note across
every session you ever saved, without costing you money and without eating your
context window. Two ideas do that work: **the search runs inside the vault** (so
history length costs zero tokens), and **relevance is hybrid** (so the free half
carries the default).

## The two indexes

Every document — a handoff, a fact — is written to both indexes under the same
identity `(project, kind, refId)`, so results can be merged.

| | Keyword (BM25) | Vector (cosine) |
|---|---|---|
| Runs | **always** | only with `CTXVAULT_EMBED_MODEL` + key |
| Cost | zero — SQLite FTS5 | one embedding call per save/query |
| Good at | exact technical terms, identifiers, names | paraphrase, synonyms |
| Bad at | "date formatting library" → `Intl.DateTimeFormat` | nothing distinctive to latch onto |

**We do not claim BM25 beats embeddings.** Hybrid ranks best; vectors catch what
keywords miss. The claim is that keyword is the right *default* — because a
default that costs money is a default most people never turn on, and because this
corpus (a few hundred short, titled, tagged notes full of distinctive technical
terms) is close to BM25's best case.

## The files

```
packages/engine/src/
├── lib/text.ts       # FTS query building, stopwords, a JS BM25 fallback
├── embed/
│   ├── types.ts      # the Embedder seam — now OPTIONAL
│   └── vercel.ts     # any AI SDK provider (OpenAI, OpenRouter, Ollama…)
├── retriever.ts      # blendHits(): merges the two indexes + recency
├── lib/vector.ts     # cosineSimilarity + recencyDecay
├── storage/sqlite.ts # text_docs + mem_fts (FTS5) + vectors
└── engine.ts         # save() indexes; search() queries both and blends
```

### `lib/text.ts` — never hand user text to FTS5 ⭐

Agents write natural language: *"what did we decide about auth middleware?"* That
is not a valid FTS5 expression — bare `?`, `AND`, `NEAR`, quotes and hyphens are
all operators or syntax errors there. So we tokenize ourselves, drop stopwords,
quote each term (making it a literal), add a prefix `*`, and OR them:

```
"auth"* OR "middleware"* OR "decide"*
```

OR, not AND: recall first, then let the ranker sort it out. The retriever
re-scores everything anyway, so a wide net costs nothing and a narrow one loses
documents permanently.

The same file also holds a ~40-line **BM25 implementation in JavaScript**. It
serves the in-memory adapter (the hosted playground has no SQLite) and the rare
better-sqlite3 build compiled without FTS5. The principle: keyword search is the
default, so it must never be the thing that's unavailable.

### `storage/sqlite.ts` — two tables, one truth

- `text_docs` — the durable copy of every searchable document.
- `mem_fts` — an FTS5 virtual table indexing it.

`text_docs` is the source of truth so the index can always be rebuilt
(`ctx reindex`), and so a vault created by v1 gets backfilled automatically on
first open. Column weights favour where the meaning is:

```sql
bm25(mem_fts, 0,0,0, 10.0, 5.0, 1.0)   -- title ×10, tags ×5, body ×1
```

A title is what the agent chose to call the knowledge; a body match is much weaker
evidence. Note **FTS5 has no upsert** — replacing a document is delete-then-insert
inside one transaction.

### `retriever.ts` — the blend

```
hybrid:        score = 0.45·lexical + 0.30·similarity + 0.25·recency
keyword-only:  score = 0.70·lexical + 0.30·recency
```

`lexical` is BM25 normalized to 0..1 within the result set (SQLite's `bm25()`
returns negative numbers on a corpus-dependent scale, meaningful only *relative*
to the other hits for the same query — which is exactly what a blend needs).
`recency` is a 3-day half-life decay, so a fresh near-match can beat a stale
perfect one without old memory ever disappearing.

The keyword-only weights are the hybrid ones with the vector share folded back
into lexical — so turning embeddings on doesn't change what "a good score" means
by an order of magnitude.

**A document found by both indexes keeps both scores** and wins on the blend. That
agreement is the strongest signal available, and it's why hybrid outranks either
half alone.

### The relevance floor

```ts
.filter(h => h.lexical > 0 || h.similarity >= 0.3)
```

Top-k with no floor returns *something* for any query, and a weak hit presented as
a result reads as an answer. **"No match" has to be said, not implied by a low
number.** A BM25 hit shares at least one meaningful term, so it clears the bar; a
vector-only hit must clear the level below which real embedding models put
unrelated text.

### `engine.ts` — the wiring

- **`save()`** indexes the handoff and every fact for keyword search, then — only
  if an embedder exists — embeds all facts in **one batched call**. Per-fact calls
  defeat the batching the embedder exists to do.
- **`search()`** queries both indexes for a wider pool than `k`, blends, floors,
  trims. Both halves are best-effort: if embeddings fail (network, quota, bad
  key), keyword results still answer. "Search is only lexical today" is a much
  better failure than "search is down."

## The data flow

```
save_context(handoff, facts)
   ├─► indexText()  ──► text_docs + mem_fts          [always, free]
   └─► embed()      ──► vectors                      [only if configured]

search_memory(query)
   ├─► searchText() ──► BM25 top-N  (normalized 0..1)
   ├─► embed(query) ──► cosine top-N                 [only if configured]
   ▼
blendHits()  →  relevance floor  →  top-k
```

## Why searching a long history is free

The scan happens **in SQLite, not in the model's context window**. Ten sessions or
a thousand, the token cost of `search_memory` is the tool call plus the handful of
results that come back — a few hundred tokens, flat. Growing history costs disk
space, not context.

That is the structural difference from putting memory in an always-loaded file,
where every added line is re-read by every future session forever.

## Turning on hybrid

```bash
CTXVAULT_EMBED_MODEL=openai:text-embedding-3-small      # + OPENAI_API_KEY
CTXVAULT_EMBED_MODEL=openrouter:openai/text-embedding-3-small   # + OPENROUTER_API_KEY
CTXVAULT_EMBED_MODEL=compatible:nomic-embed-text        # + CTXVAULT_BASE_URL, no key
```

The boot line tells you which mode you're in:

```
Search: keyword (BM25) — set CTXVAULT_EMBED_MODEL + key for hybrid
Search: hybrid (BM25 + openai:text-embedding-3-small)
```

Anthropic has no embeddings endpoint, so `anthropic:*` is never embeddable — that
is why the embedding model is configured separately in the first place.

## Quiz yourself

1. **Why OR the query terms instead of AND?**
2. **Why is BM25 normalized within the result set rather than on an absolute scale?**
3. **Why must stored vectors and the query vector come from the same embedder?**
4. **Why does a fresh session's search cost the same tokens as a two-year-old vault's?**
5. **Why keep `text_docs` when `mem_fts` already stores the text?**

<details><summary>Answers</summary>

1. Recall first. The retriever re-ranks everything anyway, so a wide candidate set
   costs nothing — while an AND that excludes a document removes it permanently,
   no matter how relevant the rest of the query was.
2. `bm25()` returns negative numbers whose scale depends on the corpus; the value
   is only meaningful relative to the other hits for the same query. Normalizing to
   0..1 within the result set is what makes it blendable with cosine.
3. Different embedders produce different dimensions and geometry, so their cosine
   is noise. `search()` filters vectors by embedder id; `cosineSimilarity` also
   guards a dimension mismatch by scoring 0, so it degrades instead of crashing.
4. The search runs in SQLite. Only the top-k results enter the context window, and
   `k` doesn't grow with history — so token cost is flat and disk cost is what grows.
5. So the index can be rebuilt (`ctx reindex`), so v1 vaults can be backfilled, and
   so a SQLite build without FTS5 still has something to rank in JS. Markdown and
   `text_docs` are the truth; `mem_fts` is derived.

</details>
