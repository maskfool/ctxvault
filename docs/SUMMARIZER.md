# The Summarizer (Phase 2.1) — what it does & why

The summarizer is the first piece of the **intelligence layer**. It turns a raw
transcript into a **HandoffNote** — the structured "here's everything you need to
keep working" object. This is what makes `resume` feel like the other tool was
there the whole time, instead of dumping a wall of raw chat.

## The files

```
packages/engine/src/
├── llm/
│   ├── types.ts       # the LLM interface (the model seam)
│   ├── prompts.ts     # the summarizer prompt (tune this, not the code)
│   └── vercel.ts      # VercelLLM: any provider via the AI SDK, schema-constrained
├── engine.ts          # save() now summarizes; resume() renders the note
└── types.ts           # HandoffNoteSchema (unchanged — the target shape)
```

### `llm/types.ts` — the model seam ⭐
**What:** the `LLM` interface — right now just `summarize(transcript) → HandoffNote`.
**Why it matters:** the engine depends on this interface, **never** on the Anthropic
SDK. That single indirection buys two things:
1. **`--no-ai` fallback** — hand the engine `null` and save/resume degrade to raw
   text. A judge never sees a dead button because a key was missing or the API was down.
2. **Testability** — we injected a *fake* `LLM` to test the whole save→resume flow
   with zero network calls and no API key. (That's exactly how it was verified.)

### `llm/prompts.ts` — the prompt, isolated
**What:** the system prompt that defines the HandoffNote fields, plus the retry
("repair") prompt and the map-reduce chunk prompts.
**Why separate:** the plan calls the summarizer prompt *"the most human-time-worthy
part of the build."* Keeping it in its own file means you iterate on wording against
fake transcripts without touching logic. The field descriptions in the prompt ARE the
spec the model follows.

### `llm/anthropic.ts` — the real summarizer ⭐
**What:** `AnthropicLLM`, the concrete implementation. Model: **`claude-opus-4-8`**.
**The three-step strategy (straight from SPEC.md):**
1. **Map-reduce for huge transcripts.** If the transcript is >20k chars, each chunk
   is digested to a short plain-text summary, then those digests are summarized into
   the final note. Keeps one call focused and bounds cost.
2. **Strict JSON + zod.** We ask for JSON only, strip stray ```` ```json ```` fences,
   `JSON.parse`, then validate with `HandoffNoteSchema`. **We never trust the model's
   JSON blindly** — a hallucinated field or trailing prose would break the Vault UI.
3. **Retry once.** On a parse/validation failure we send the model its own bad output
   plus the exact error and ask for a fix. Still bad after that → throw, and the
   engine falls back to raw.

**Why prompt-and-validate instead of the SDK's structured-output helper?** The spec
says "strict JSON, zod, retry once" — that's this exact pattern, and it's portable
across SDK versions (the installed SDK doesn't ship the newer `zodOutputFormat`
helper). One well-understood path beats a version-specific magic method.

### `engine.ts` — where it plugs in
- **`save()`**: if an LLM is present, `summarize()` the transcript and store the
  HandoffNote alongside the raw text. Wrapped in try/catch — a model hiccup sets a
  `warning` and stores raw; the save itself **never fails**. `mode` in the result is
  `"intelligent"` or `"raw"` accordingly.
- **`resume()`**: renders the HandoffNote as clean markdown at the **top** of the
  packed context (goal → state → next step → decisions → todos → files → gotchas),
  then fills the remaining token budget with the recent raw transcript tail.

## The data flow

```
save_context(transcript)
      │
      ▼
CtxEngine.save ──► AnthropicLLM.summarize
      │                   │  claude-opus-4-8, strict JSON, zod-validated, retry once
      │                   ▼
      │             HandoffNote  ──(on failure)──►  null + warning
      ▼
StorageAdapter.saveSnapshot(rawTranscript, handoffNote)

resume_context(project)
      │
      ▼
CtxEngine.resume ──► getLatest ──► renderHandoffNote() at top + transcript tail
```

## Running it for real

The summarizer needs a Claude API key (the CLI stays in `--no-ai` mode without one):

```bash
export CTXVAULT_MODEL=anthropic:claude-opus-4-8   # or openai:/openrouter:/compatible:
export ANTHROPIC_API_KEY=sk-ant-...      # your key (mind the ~$5 budget cap)
npm run build
# save with a real transcript in Claude Code / Codex, then resume in the other tool
```

Quick local smoke test with a key set:

```bash
node --input-type=module -e '
import { VercelLLM } from "@ctxvault/engine";
const llm = new VercelLLM();   // model from CTXVAULT_MODEL
const note = await llm.summarize("User: build a rate limiter. Assistant: chose token-bucket over sliding-window (O(1) refills). Implemented limiter.ts. TODO: Redis backend. Next: burst-traffic tests.");
console.log(JSON.stringify(note, null, 2));
'
```

## Quiz yourself

1. **Why does `save()` catch summarizer errors instead of letting them propagate?**
2. **Why validate the model's JSON with zod when we already told it the schema in the
   prompt?**
3. **Why is the prompt in its own file, separate from `anthropic.ts`?**
4. **What does the `LLM` interface let the playground (Phase 3) do that a direct SDK
   dependency wouldn't?**

<details><summary>Answers</summary>

1. So a model outage or rate-limit never costs the user their save — it degrades to
   raw storage with a warning. Durability of the memory beats richness of the summary.
2. The prompt is a *request*, not a *guarantee*. Models can emit malformed JSON, extra
   prose, or a wrong-typed field. zod is the enforcement boundary; the retry is the
   recovery. Belt and suspenders around untrusted output.
3. So the prompt (the highest-leverage, most-iterated artifact) can be tuned without
   risking the parsing/retry logic, and diffs stay readable.
4. Inject the same `VercelLLM` (or a cheaper/mocked one) without importing SQLite or
   changing engine code — "one engine, two front doors," now including the intelligence.

</details>
