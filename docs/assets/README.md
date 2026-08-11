# README assets

- **`handoff.gif`** — the money shot, shown at the top of the root `README.md`.
  Three scenes: save in Claude Code → resume in a brand-new Codex session →
  search a past decision. **Every line of terminal output in it is real**, captured
  from a running MCP server by `tools/demo/capture.mjs`; `tools/demo/render.py`
  draws the frames. Regenerate with:

  ```bash
  DEMO_VAULT=/tmp/demo-vault OUT=tools/demo/captured.json node tools/demo/capture.mjs
  python3 tools/demo/render.py    # writes tools/demo/out/handoff.gif
  ```

  The only authored text is the narration caption and the dim grey annotations —
  kept visually distinct so they can never be mistaken for program output.

## Still worth capturing

- **A real screen recording** of the two-CLI handoff — actual Claude Code and Codex
  windows. The GIF is honest about its output but it is a rendering, and a real
  recording of two vendors' tools sharing memory is a stronger proof than any
  animation.
- **`vault.png`** — a still of the playground's middle Vault panel full of fact
  cards. Good for the pitch deck too.
