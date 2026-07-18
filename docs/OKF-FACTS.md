# Facts & OKF Files (Phase 2.3) — what it does & why

Phase 2.1 gave us **episodic** memory (HandoffNotes: "what's next in this
session"). Phase 2.3 gives us **semantic** memory: durable **facts** that outlive
any session ("this project hashes passwords with argon2id, and here's why"), stored
as human-readable markdown files. This is the part of the pitch nobody else has:
**your AI's memory is a folder of files you can read, grep, edit, and git-commit.**

## Episodic vs semantic — the distinction that drives this phase

| | HandoffNote (2.1) | Fact (2.3) |
|---|---|---|
| Question it answers | "Where was I? What's next?" | "What does this project *know*?" |
| Lifespan | This session | Timeless until it changes |
| Example | "next: write burst-traffic test" | "auth uses argon2id, not bcrypt" |
| Stored as | a snapshot row | an OKF `.md` file (+ row) |

The fact extractor is prompted hard to keep these separate: transient status stays
in the note; only durable knowledge becomes a fact.

## The files

```
packages/engine/src/
├── llm/
│   ├── prompts.ts      # + FACTS_SYSTEM: the fact-extraction prompt
│   └── anthropic.ts    # + extractFacts(): strict JSON array, zod, retry once
├── okf/okf.ts          # write / read / list OKF markdown files ⭐
├── lib/slug.ts         # safe, stable slug → filename (security boundary) ⭐
├── storage/
│   ├── sqlite.ts       # saveFact now ALSO writes the OKF file
│   └── memory.ts       # in-memory adapter — same interface, no files ⭐
└── engine.ts           # save() extracts + persists + indexes facts
```

### `okf/okf.ts` — the Open Knowledge Format layer ⭐
Each fact is a markdown file with YAML frontmatter:

```
knowledge/<project>/<slug>.md
---
type: decision
title: Password hashing uses argon2id
updated: 2026-07-18T10:00:00.000Z
session: main
tags: [auth, security]
---
We chose argon2id over bcrypt because ...
```

`gray-matter` handles the frontmatter both ways (write + parse). **Update rule from
the spec:** same slug ⇒ overwrite the file and bump `updated`. No merge intelligence —
simple and predictable. Why files at all? So the memory is readable and
git-versionable *without CtxVault running*. Remember the framing: **OKF is a shelf,
not a compressor** — it's durable, auditable storage, never a token-saving trick.

### `lib/slug.ts` — a security boundary, not just formatting ⭐
A fact's slug becomes a **filename**, and the slug comes from an **LLM** — untrusted
input. `slugify` strips everything except `[a-z0-9-]`, so a slug can never contain
`/` or `..` and escape the knowledge directory. Verified: `slugify("../../etc/passwd")`
→ `"etc-passwd"`. It also gives the stable-id property the overwrite rule needs.

### `storage/sqlite.ts` — where the file gets written
`saveFact` now, when a `knowledgeDir` is configured, writes the OKF file **and** sets
`filePath` on the fact before storing the row. **The engine never touches the
filesystem** — file I/O is a storage concern, so it lives in the adapter. Omit
`knowledgeDir` and facts are stored SQLite-only: that's contingency-ladder rung 1
("OKF files → SQLite fact rows"), and the Vault UI is unchanged because it reads rows.

### `storage/memory.ts` — the second front door's storage ⭐
The in-memory `StorageAdapter` for the stateless Vercel playground. ~100 lines of
`Map`s and arrays — and the **entire engine** (summarizer, embedder, retriever, OKF
facts) runs on it unchanged. This is the interface work paying off: "same engine,
only the transport differs." Facts here have no files (`filePath` stays `null`); the
Vault renders them from the in-memory rows.

### `engine.ts` — the orchestration
`save()` now does the full pipeline, every step best-effort so a model failure never
costs the save:
1. `summarize` → HandoffNote (episodic)
2. `extractFacts` → Fact[] (semantic)
3. `saveSnapshot`, then index the handoff vector
4. for each fact: `saveFact` (adapter writes the OKF file + sets `filePath`) → embed
   **title + tags + body** → `saveVector(kind: "fact", filePath)` so a search hit can
   point at the readable file.

> Note: we *embed* title+tags+body (the title/tags carry the search terms) but
> *store* the body as the result's display text. Embedded text and displayed text
> are independent — a small choice that made fact search actually find things.

## The data flow

```
save_context(transcript)
   ├─ summarize ─────────► HandoffNote (episodic)  ──► snapshot + handoff vector
   └─ extractFacts ──────► Fact[]
                             │  for each fact:
                             ├─► store.saveFact ──► knowledge/<proj>/<slug>.md  (+ row)
                             └─► embed(title+tags+body) ──► fact vector (carries filePath)

search_memory("how do we hash passwords")
   └─► matches the fact vector ──► returns the body + a pointer to the .md file
```

## Three tiers of memory, now complete

- **working** — the last ~10 verbatim messages (in the raw transcript)
- **episodic** — HandoffNotes (Phase 2.1)
- **semantic** — OKF facts (this phase)

## Running it

With a Claude key, facts are extracted automatically on save; the files land in
`~/.ctxvault/knowledge/<project>/`:

```bash
export CTXVAULT_MODEL=anthropic:claude-opus-4-8   # any provider works
export ANTHROPIC_API_KEY=sk-ant-...
npm run build
# save a real session, then:  ls ~/.ctxvault/knowledge/<project>/
# open a .md file — that's your AI's memory, readable and git-able
```

`list_facts` (new MCP tool) shows what a project "knows." Without a key it's `--no-ai`
mode: no facts (raw storage), and the CLI says so.

## Quiz yourself

1. **Why does OKF file-writing live in the SQLite adapter instead of the engine?**
2. **Why is `slugify` a security concern, not just cosmetic?**
3. **What's the difference between a HandoffNote and a Fact — and why keep them
   separate?**
4. **Why does the same `CtxEngine` code run on both SQLite and the in-memory
   adapter with no changes?**
5. **Why embed title+tags+body but store only the body as the result text?**

<details><summary>Answers</summary>

1. Filesystem I/O is a storage concern, and the in-memory adapter has no disk. Keeping
   it in the adapter means the engine stays transport-agnostic — the whole "one
   engine, two front doors" property depends on it.
2. The slug becomes a filename and comes from an LLM (untrusted). Without stripping
   `/` and `..`, a malicious or hallucinated slug could write outside the knowledge
   directory (path traversal). `slugify` is the boundary that prevents it.
3. A HandoffNote is *this session's* state ("what's next"); a Fact is *timeless*
   project knowledge. Mixing them means transient TODOs pollute long-term memory and
   durable decisions get lost when the session ends. Different lifespans, different homes.
4. Because it depends only on the `StorageAdapter` interface, never on a concrete
   store. Swap the implementation, keep the brain.
5. The title and tags carry the words a user actually searches for; the body is the
   full answer. Embedding the richer text makes facts findable, while displaying the
   body keeps results readable. Embedded text and stored text are separate fields.

</details>
