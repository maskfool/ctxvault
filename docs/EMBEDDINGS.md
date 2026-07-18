# Embeddings & Search (Phase 2.2) — what it does & why

Phase 2.1 gave memory *structure* (HandoffNotes). Phase 2.2 makes memory
*findable*: `search_memory("what did we decide about auth")` returns the right
note even when the words don't match exactly. This is the difference between a
`LIKE '%auth%'` query and actually understanding meaning.

## The idea in one paragraph

An **embedder** turns text into a vector (a list of floats). Texts that mean
similar things get vectors that point in similar directions. To search, we embed
the query the same way and find the stored vectors with the highest **cosine
similarity** (the angle between them). A **retriever** then re-ranks those matches
so a fresh, slightly-worse match can beat a stale, perfect one.

## The files

```
packages/engine/src/
├── embed/
│   ├── types.ts     # the Embedder interface (the model seam)
│   ├── vercel.ts    # VercelEmbedder — real semantics, any AI SDK provider
│   └── local.ts     # LocalEmbedder — hashing fallback, no key, no network
├── retriever.ts     # blends similarity + recency into a final rank
├── lib/vector.ts    # cosineSimilarity + recencyDecay (from Phase 1)
├── storage/sqlite.ts# vectors table (+ created_at), brute-force cosine search
└── engine.ts        # save() indexes a vector; search() embeds + ranks
```

### `embed/types.ts` — the embedder seam ⭐
Same pattern as `LLM` and `StorageAdapter`: the engine depends on the `Embedder`
interface, never on a provider. `embed(texts) → vectors`, plus an `id` and
`dimensions`. **The one invariant to remember:** the vectors you *store* and the
query you *search with* must come from the **same** embedder — different embedders
have different geometry, so mixing them is meaningless. `cosineSimilarity` guards a
dimension mismatch (returns 0) so it degrades safely instead of crashing.

### `embed/openai.ts` — the hosted embedder
Calls OpenAI's `text-embedding-3-small` (1536 dims) via plain `fetch` — no SDK for
one endpoint. **Why OpenAI and not Claude?** Anthropic doesn't offer an embeddings
endpoint; embeddings are the single place CtxVault reaches for another provider.
Needs `OPENAI_API_KEY`; the key stays server-side.

### `embed/local.ts` — the fallback embedder ⭐
A **hashing vectorizer**: tokenize into words, hash each word into one of 256
buckets, accumulate, L2-normalize. Texts that share words point the same way.
**Be honest about it:** it captures WORD overlap, not MEANING — it won't match
"auth flow" ↔ "login handling" the way the real model does. Its job is to keep
search alive with no key and no network. That's the plan's "+fallback" — a judge
never hits a dead search box.

### `retriever.ts` — the ranking blend
Pure similarity isn't enough. The blend (weights from SPEC.md):

```
score = 0.6·similarity + 0.3·recencyDecay(age, half-life 3d) + 0.1·sameProjectBoost
```

Recency has a 3-day half-life, so newer memories rank higher without old ones ever
disappearing. We search within one project, so `sameProjectBoost` is a constant
`0.1` here (it's in the formula for future cross-project search).

### `storage/sqlite.ts` — where vectors live
Vectors are stored as JSON text with a `created_at` timestamp. `search()` loads a
project's vectors and computes cosine **in JS, brute-force**. At hundreds of
vectors that's instant — no vector-DB dependency to justify. (`ensureColumn`
back-fills `created_at` on databases created before this phase.)

### `engine.ts` — the wiring
- **`save()`** now also indexes: it embeds the HandoffNote (or the raw transcript
  if there's no note — a note is far more searchable than a wall of chat) and
  stores the vector. Best-effort: an embedding failure becomes a `warning`, never a
  failed save.
- **`search(project, query, k)`**: embed the query → pull a wider candidate pool by
  raw similarity → `rankHits()` → trim to `k`. Pulling extra candidates first is
  what lets the recency weight actually change the order.

## The data flow

```
save_context(transcript)
   └─► summarize → HandoffNote ──► embedTextFor() ──► Embedder.embed()
                                                          │ vector
                                                          ▼
                                          StorageAdapter.saveVector(created_at=now)

search_memory(query)
   └─► Embedder.embed([query]) ──► store.search (brute-force cosine, top-N)
                                        │ candidates (+ created_at)
                                        ▼
                                   rankHits()  0.6·sim + 0.3·recency + 0.1
                                        │
                                        ▼  top-k, most useful first
```

## Why vector search beats `LIKE`

`LIKE '%auth%'` matches literal characters. Embeddings place *meanings* near each
other, and cosine measures closeness by direction — so "session auth tokens"
surfaces a note about "JWT stored in cookies" even with few shared words (with the
hosted embedder; the local fallback still needs shared words). That's the whole
reason the memory feels smart instead of like grep.

## Running it with real semantics

```bash
export OPENAI_API_KEY=sk-...     # enables openai:text-embedding-3-small
# or: CTXVAULT_EMBED_MODEL=openrouter:openai/text-embedding-3-small + OPENROUTER_API_KEY
# or: CTXVAULT_EMBED_MODEL=compatible:nomic-embed-text + CTXVAULT_BASE_URL
npm run build
# save some contexts, then search — matches now work on meaning, not just words
```

Without the key, the CLI logs `Embeddings: local-hash-256` and search still works
lexically. The boot line tells you which mode you're in.

## Quiz yourself

1. **Why must the stored vectors and the query use the same embedder?**
2. **Why does `search()` pull more candidates than `k` before ranking?**
3. **Why embed the HandoffNote instead of the raw transcript?**
4. **Why is brute-force cosine in JS an acceptable choice here — and when would it
   stop being acceptable?**
5. **Why can vector search match meaning when `LIKE` can only match characters?**

<details><summary>Answers</summary>

1. Different embedders produce different dimensions and geometry; their cosine is
   meaningless. (The code guards a dimension mismatch by scoring 0, so it degrades
   safely rather than crashing.)
2. Because the retriever re-ranks by recency + project boost, a fresh item that
   was #7 by pure similarity can become #1. If we only fetched the top-k by
   similarity, we'd never see it. Fetch a pool, then re-rank, then trim.
3. The note is the distilled meaning — goal, decisions, next step — so it embeds to
   a much more searchable point than a long, noisy transcript. Raw is the fallback
   when there's no note.
4. At hundreds of vectors, comparing against all of them is instant and needs zero
   dependencies. It stops scaling around tens of thousands of vectors, where you'd
   move to sqlite-vec or a real ANN index.
5. Embeddings map similar meanings to nearby points in vector space; cosine
   measures that nearness by direction. `LIKE` only compares literal characters, so
   different words for the same idea never match.

</details>
