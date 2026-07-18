# Codex prompt — CtxVault playground UI redesign

> Paste everything below into Codex. **Attach the design screenshot to the same message.**

---

## Task

Restyle the CtxVault playground (a Next.js 14 App Router app) to match the attached
design screenshot. This is a **pure presentation change**: the app already works
end-to-end. Do not change any behavior, API contract, or state logic.

## Repo layout

Monorepo, npm workspaces. Only touch `apps/playground`:

```
apps/playground/
  app/layout.tsx        # root layout, imports globals.css
  app/globals.css       # ALL styling — plain CSS, no Tailwind, no CSS modules
  app/page.tsx          # single client component: Page + ChatPane + VaultPanel
  app/api/{chat,save,resume,search,reset,vault}/route.ts   # DO NOT TOUCH
  lib/{seed,chat,session,personas}.ts                      # DO NOT TOUCH
```

Run it with `npm run dev -w @ctxvault/playground` (port 3111).

## Hard constraints

1. **Plain CSS only.** Do not add Tailwind, styled-components, shadcn, or any UI
   library. Do not add dependencies at all. All styling lives in `globals.css`
   driven by CSS custom properties on `:root`.
2. **Do not change any `fetch` call, route path, request body, or response type**
   in `page.tsx`. The functions `send`, `save`, `resume`, `search`, `reset`,
   `loadVault` and the `Vault` / `Note` / `Fact` / `Hit` / `Msg` types must keep
   their exact current shape.
3. **Do not delete rendered data.** Every field currently shown must still be
   shown: handoff-note rows (Goal, Current state, Next step, Decisions, Open
   todos, Gotchas), OKF fact cards (file path, title, body, type chip, tag
   chips), search hits (kind, refId, score, body), the AI-mode badge, the
   embeddings badge, the busy spinner, and the status line.
4. **Keep it a single-file component.** `page.tsx` may be reorganized internally
   (extra local subcomponents are fine) but stays one file. No new files except
   optional additions to `globals.css`.
5. TypeScript must compile clean (`npx tsc --noEmit -p apps/playground`).

## Visual direction (from the screenshot)

Neo-brutalist dark terminal. Boxy, high-contrast, monospace-forward.

**Palette** — replace the current soft-blue tokens in `:root`:
- page background: near-black `#08090c`
- panel background: `#101114`, elevated surfaces `#16171b`
- primary accent (brand, active pane, primary button): electric blue `#2563ff`
- secondary accent (vault, highlights, Tool A): warm yellow `#f5d565`
- Tool B accent: muted gold/tan
- text `#e8e9ed`, dim `#8b8f9c`, faint `#5a5e6b`
- borders: `1px solid #2a2c33`, never rounded — **`--radius: 0`** everywhere

**Type**: monospace (`--mono`) for essentially all UI text — headers, buttons,
labels, chat bubbles, inputs. The wordmark `ctxVault` is the one exception:
heavy italic sans, blue, with "Vault" in the same blue but non-italic weight
contrast as shown.

**Signature details to reproduce:**
- **Hard offset shadows** instead of blur: `box-shadow: 4px 4px 0 #000` on
  cards, buttons, and the hint callout. No soft/blurred shadows anywhere.
- **Dotted texture** inside chat panes and the vault body:
  `background-image: radial-gradient(#1c1e24 1px, transparent 1px);
   background-size: 16px 16px;`
- **Thick blue rule** (3–4px, `--accent`) directly under the top bar, spanning
  full width.
- **Column headers outside the panels**: `● TOOL A: PLANNING` on the left with a
  small filled dot, model tag `CLAUDE-STYLE · v3.5` right-aligned in faint text.
  Same pattern for Tool B (`CODEX · PRO-V2`). Center column header is
  `▤ THE VAULT` in yellow.
- **Uppercase, letter-spaced** section labels and headers.
- **"TRY THIS" hint**: yellow 2px border, black fill, hard black offset shadow,
  bulb glyph, with `Save Context` / `Resume` emphasized in yellow.
- **Buttons**: sharp rectangles, no radius. Primary = solid blue, white text.
  Send buttons = solid yellow (Tool A) / tan (Tool B) with black text.
  Secondary = dark fill, thin border.
- **Chat bubbles**: rectangular, thin-bordered, dark fill. The current-user
  bubble gets a small CSS triangle tail at bottom-left (`::after`, borders
  trick). Role label above each bubble in small uppercase (`YOU`, `TOOL A`).
- **Empty Tool B panel**: centered placeholder — a large outlined diamond
  (rotated square) containing a terminal glyph, then `EMPTY PANEL` in caps, a
  two-line dim hint, then the primary blue `RESUME IN TOOL B` button.
- **Vault footer strip**: a small row of 4–5 square blocks (a crude load meter,
  filled blocks in yellow) on the left, `VAULT LOAD: NN%` on the right in faint
  caps. Derive the percentage from real state — e.g. clamp based on
  `vault.facts.length` and whether `vault.note` exists — do not hardcode a
  fake number, and label it honestly.
- **Bottom footer bar**: wordmark, copyright line, and text links
  (Documentation, Vault API, Privacy, Support) plus a lock glyph and the
  existing trust/session sentence on the right. Footer links that have no real
  destination should be plain non-navigating text or `href="#"` — do not
  fabricate URLs.
- **Code blocks inside chat messages**: if a message body contains a fenced code
  block, render it as a bordered dark box with a faint `// filename` caption
  line at top. Keep this simple — a regex split on triple backticks is fine.
  If that adds meaningful complexity, skip it and leave bubbles as plain text.

## Layout

Three columns, `grid-template-columns: 1fr 1fr 1fr` with a fixed full-height
page: top bar → blue rule → column headers → three panels → footer. Each chat
pane is a flex column with a scrolling message list and a pinned composer at the
bottom. The vault column scrolls independently.

Below `1100px`, stack to a single column in order: Tool A, Vault, Tool B.

## Top bar

Left: `ctxVault` wordmark, then nav-style text links `The Vault` (active,
yellow) / `Tool A` / `Tool B` — clicking `Tool A` / `Tool B` should set the
active pane via the existing `setActive` state so the labels stay functional
rather than decorative. Right: the existing AI-mode pill
(`AI: DEMO MODE (NO KEY)` vs `AI: ON (<model>)`), the primary blue
`Save Context` button (wired to the existing `save()`), and two icon buttons —
history and settings. Wire history/settings to existing behavior or make them
inert; do not invent new features behind them. The `embeddings: …` badge must
remain visible somewhere in the bar (a small pill next to the AI pill is fine).

## Acceptance

- `npm run dev -w @ctxvault/playground` boots with no console errors.
- The seeded Tool A conversation renders in the left pane on load.
- Clicking `Save Context` still populates the vault; `Resume in Tool B` still
  injects context and switches the active pane; semantic search still returns
  and renders hits; `Reset` still clears.
- No visual regression in the data shown — same fields, new skin.
- Report anything in the design you deliberately did not implement.
