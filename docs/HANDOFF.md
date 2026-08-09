# The Handoff — who writes it, and why that's the whole design

> Replaces the old `SUMMARIZER.md`. CtxVault used to summarize your session with
> its own model. It doesn't anymore, and this file is about why that turned out to
> be the more interesting design.

The **HandoffNote** is the structured "here's everything you need to keep working"
object — goal, decisions, current state, open todos, files touched, gotchas, next
step. It's what makes `resume` feel like the other tool was there the whole time,
instead of dumping a wall of raw chat.

The question this doc answers is: **who writes it?**

## v1: we did. That was the bug.

The old `save_context(project, transcript)` took a raw transcript and called our
own LLM to summarize it and extract facts. It worked, and it was wrong for three
reasons:

1. **It made an API key mandatory.** Installing a memory tool meant signing up for
   a model provider and funding a second budget — on top of the coding agent the
   user was already paying for. Most people never get past that step.
2. **It paid twice for one understanding.** The coding agent had just lived
   through the session and understood it completely. We then paid a second model
   to re-derive that understanding from a transcript.
3. **The second model knew less.** It saw a serialized transcript. The agent saw
   the actual session: the files it opened, what it tried, what failed.

## v2: the agent does — because the tool schema *is* the form

`save_context` no longer accepts a transcript to be understood. It accepts a
**filled-in handoff**:

```ts
save_context({
  project: "myapp",
  handoff: { goal, decisions[], currentState, openTodos[], filesTouched[], gotchas[], nextStep },
  facts: [{ slug, type, title, body, tags[] }],
  transcript?: "optional verbatim tail"
})
```

The calling agent fills that in from the session it is holding in context, using
tokens the user has already paid for. CtxVault validates, stores, indexes, ranks,
packs and exports. **It ships no model and makes no network call on this path.**

## The files

```
apps/mcp-server/src/
├── schema.ts        # the form the agent fills in — THE prompt (see below)
└── index.ts         # tool registration; slugifies fact slugs before storing
packages/engine/src/
├── types.ts         # HandoffNoteSchema / FactSchema — the validation boundary
└── engine.ts        # save(): validate → store → OKF files → index
```

### `schema.ts` — treat this file as prompt engineering ⭐

This is the file that replaced `llm/prompts.ts`, and it plays the same role. Every
field carries a `.describe()`, and **that text is the only instruction the agent
gets** about what belongs in the slot. It lands verbatim in the JSON schema the
client shows its model.

```ts
nextStep: z.string().describe(
  "The single most useful next action. Specific and actionable, not 'continue the work'."
)
```

That trailing clause is doing real work. Without it models write "continue
implementing the feature," which is worth nothing on resume. Vague descriptions
here produce vague handoffs, and a vague handoff is a failed resume — so iterate
on this file the way you'd iterate on a prompt.

Two rules carried over from the old generation schemas:

- **No `.default()` on required fields.** A defaulted field is *optional* in the
  generated JSON schema, and clients running strict structured output reject a
  schema whose `required` list is incomplete. Ask for an empty array instead.
- **Slugs are untrusted.** A fact's `slug` becomes a filename and it came from a
  model, so `index.ts` runs `slugify()` on it regardless of what arrived.

### The constraint didn't disappear — it moved

The old summarizer used `generateObject` to *force* the model into the HandoffNote
shape rather than politely asking for JSON. That mattered: it's what made small,
cheap models usable.

The same mechanism is still there, one layer out. An MCP tool's `inputSchema` is
handed to the calling model as a tool definition, and tool arguments are
schema-constrained in exactly the same way. We kept the constraint and dropped the
model.

### `engine.ts` — where it plugs in

- **`save()`**: persist the snapshot, write each fact as an OKF markdown file,
  index everything for search. Indexing is best-effort — a failure costs
  discoverability, never the saved context. No handoff supplied → raw storage,
  `mode: "raw"`.
- **`resume()`**: renders the HandoffNote as clean markdown at the **top** of the
  packed context (goal → state → next step → decisions → todos → files → gotchas),
  then fills the remaining budget with the knowledge index, relevant facts, and
  the transcript tail.

## The data flow

```
your agent (already understands the session)
      │  fills the tool schema
      ▼
save_context(handoff, facts)
      │
      ▼
CtxEngine.save ──► validate (zod) ──► saveSnapshot
      │                              └─► saveFact → knowledge/<project>/<slug>.md
      ▼
   indexText (BM25)  [+ embed, only if configured]

resume_context(project)
      │
      ▼
CtxEngine.resume ──► getLatest ──► renderHandoffNote() + ranked facts + tail
```

Nothing in that diagram is a model call.

## Running it for real

```bash
npm run build
# register the server (no env block needed), then in your agent:
#   "save this to ctxvault under project myapp"
#   …switch tools…
#   "resume project myapp from ctxvault"
```

Inspect what the agent actually wrote, without an agent:

```bash
ctx list                  # the facts it chose to keep
ctx export                # the packet the next tool will receive
```

## Quiz yourself

1. **Why is the agent a better summarizer of the session than a model we call?**
2. **We removed `generateObject`. Why is the output still schema-constrained?**
3. **Why does `save()` still work when `handoff` is omitted?**
4. **Why does `index.ts` slugify a slug the agent already formatted as kebab-case?**
5. **Where does the "prompt" for the handoff live now, and how do you improve it?**

<details><summary>Answers</summary>

1. It has the live session, not a serialization of it — the files it opened, the
   things it tried that failed, the reasoning behind each choice. A second model
   only sees what made it into the transcript. It's also free: that understanding
   already exists inside tokens the user paid for.
2. An MCP tool's `inputSchema` is given to the calling model as a tool definition,
   and tool arguments are constrained to it the same way structured output is. The
   constraint moved from our process to the client's; it didn't go away.
3. Durability beats richness. A save that fails because a field was missing is
   worse than a save that keeps the raw transcript and reports `mode: "raw"`.
4. Because it becomes a filename and it came from a model — untrusted input. It's
   a no-op on well-formed slugs and a safeguard on `"Keyless By Default!!"`.
5. In `apps/mcp-server/src/schema.ts`, as the `.describe()` text on each field.
   Improve it by tightening those descriptions — especially with negative
   examples ("not 'continue the work'"), which is what stops generic filler.

</details>
