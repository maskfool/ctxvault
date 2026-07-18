"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SEED_TOOL_A } from "@/lib/seed";

type Pane = "A" | "B";
type Msg = { role: "user" | "assistant"; content: string; resumed?: boolean };

type Decision = { what: string; why: string };
type Note = {
  goal: string;
  decisions: Decision[];
  currentState: string;
  openTodos: string[];
  filesTouched: string[];
  gotchas: string[];
  nextStep: string;
};
type Fact = { slug: string; type: string; title: string; body: string; tags: string[] };
type Vault = {
  aiEnabled: boolean;
  /** "<provider>:<model-id>" when AI is on, null in demo mode. */
  model: string | null;
  embedder: string;
  note: Note | null;
  savedAt: string | null;
  facts: Fact[];
  sessions: { session: string; snapshotCount: number; updatedAt: string }[];
};
type Hit = { kind: string; refId: string; filePath: string | null; text: string; score: number; similarity: number };

const PANE_META: Record<Pane, { name: string; role: string; cls: string }> = {
  A: { name: "Tool A", role: "Claude-style · planning", cls: "a" },
  B: { name: "Tool B", role: "Codex-style · implementation", cls: "b" },
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export default function Page() {
  const [msgs, setMsgs] = useState<Record<Pane, Msg[]>>({ A: SEED_TOOL_A as Msg[], B: [] });
  const [resumed, setResumed] = useState<Record<Pane, string | null>>({ A: null, B: null });
  const [active, setActive] = useState<Pane>("A");
  const [draft, setDraft] = useState<Record<Pane, string>>({ A: "", B: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; warn?: boolean } | null>(null);
  const [vault, setVault] = useState<Vault | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);

  const loadVault = useCallback(async () => {
    const res = await fetch("/api/vault");
    setVault(await res.json());
  }, []);

  useEffect(() => {
    loadVault();
  }, [loadVault]);

  const transcriptOf = (pane: Pane) =>
    msgs[pane].map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");

  async function send(pane: Pane) {
    const text = draft[pane].trim();
    if (!text || busy) return;
    setActive(pane);
    const next = [...msgs[pane], { role: "user" as const, content: text }];
    setMsgs((m) => ({ ...m, [pane]: next }));
    setDraft((d) => ({ ...d, [pane]: "" }));
    setBusy("chat");
    try {
      const { reply } = await post<{ reply: string }>("/api/chat", {
        persona: pane,
        messages: next,
        resumedContext: resumed[pane] ?? undefined,
      });
      setMsgs((m) => ({ ...m, [pane]: [...m[pane], { role: "assistant", content: reply }] }));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (busy) return;
    setBusy("save");
    setStatus({ text: "Summarizing & extracting facts…" });
    try {
      const r = await post<{ mode: string; factsExtracted: number; warning: string | null; error?: string }>(
        "/api/save",
        { transcript: transcriptOf(active), session: "main" },
      );
      if (r.error) {
        setStatus({ text: r.error, warn: true });
      } else {
        setStatus({
          text:
            r.mode === "intelligent"
              ? `Saved Tool ${active}'s context → HandoffNote + ${r.factsExtracted} fact(s).`
              : `Saved Tool ${active}'s context (raw — no AI key set).`,
          warn: Boolean(r.warning),
        });
      }
      await loadVault();
    } finally {
      setBusy(null);
    }
  }

  async function resume(target?: Pane) {
    if (busy) return;
    const other: Pane = target ?? (active === "A" ? "B" : "A");
    setBusy("resume");
    setStatus({ text: `Packing context for Tool ${other}…` });
    try {
      const r = await post<{ found: boolean; packed: string; nextStep: string | null }>("/api/resume", {
        budget: 4000,
      });
      if (!r.found) {
        setStatus({ text: "Nothing saved yet — hit 💾 Save context first.", warn: true });
        return;
      }
      setResumed((s) => ({ ...s, [other]: r.packed }));
      const greeting = r.nextStep
        ? `Picking up where you left off: ${r.nextStep}`
        : "Picking up where you left off — I've loaded the handoff note and the project's facts.";
      setMsgs((m) => ({ ...m, [other]: [...m[other], { role: "assistant", content: greeting, resumed: true }] }));
      setActive(other);
      setStatus({ text: `Resumed into Tool ${other}. It now has your full working context.` });
    } finally {
      setBusy(null);
    }
  }

  async function search() {
    if (!query.trim() || busy) return;
    setBusy("search");
    try {
      const r = await post<{ hits: Hit[] }>("/api/search", { query });
      setHits(r.hits);
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    await post("/api/reset", {});
    setMsgs({ A: SEED_TOOL_A as Msg[], B: [] });
    setResumed({ A: null, B: null });
    setHits(null);
    setActive("A");
    setStatus({ text: "Vault cleared." });
    await loadVault();
  }

  const hasMemory = Boolean(vault?.note || (vault?.facts.length ?? 0) > 0);

  return (
      <div className="app">
      <header className="topbar">
        <div className="brand">ctx<span>Vault</span></div>
        <nav className="nav" aria-label="Primary navigation">
          <button className="nav-link vault-link" type="button">The Vault</button>
          <button className="nav-link" type="button" onClick={() => setActive("A")}>Tool A</button>
          <button className="nav-link" type="button" onClick={() => setActive("B")}>Tool B</button>
        </nav>
        <div className="spacer" />
        <div className={`badge ${vault?.aiEnabled ? "on" : "off"}`}>
          {vault?.aiEnabled ? `AI: ON (${vault.model})` : "AI: DEMO MODE (NO KEY)"}
        </div>
        <div className="badge">embeddings: {vault?.embedder ?? "…"}</div>
        <button className="primary save-button" onClick={save} disabled={!!busy}>
          ▣ SAVE CONTEXT
        </button>
        <button className="icon-button" type="button" aria-label="History">↶</button>
        <button className="icon-button" type="button" aria-label="Settings">⚙</button>
      </header>
      <div className="blue-rule" />

      <div className="actionbar">
        <button onClick={() => resume()} disabled={!!busy}>↻ RESUME IN TOOL {active === "A" ? "B" : "A"}</button>
        <button onClick={reset} disabled={!!busy}>↺ RESET</button>
        {busy && <span className="spin">· {busy}…</span>}
        <span className={`status ${status?.warn ? "warn" : ""}`} aria-live="polite">
          {status?.text ?? ""}
        </span>
      </div>

      <div className="columns">
        <ChatPane
          pane="A"
          msgs={msgs.A}
          active={active === "A"}
          resumed={!!resumed.A}
          draft={draft.A}
          onFocus={() => setActive("A")}
          onDraft={(v) => setDraft((d) => ({ ...d, A: v }))}
          onSend={() => send("A")}
          onResume={() => resume("A")}
          busy={!!busy}
        />

        <VaultPanel
          vault={vault}
          hasMemory={hasMemory}
          query={query}
          setQuery={setQuery}
          onSearch={search}
          hits={hits}
          busy={!!busy}
        />

        <ChatPane
          pane="B"
          msgs={msgs.B}
          active={active === "B"}
          resumed={!!resumed.B}
          draft={draft.B}
          onFocus={() => setActive("B")}
          onDraft={(v) => setDraft((d) => ({ ...d, B: v }))}
          onSend={() => send("B")}
          onResume={() => resume("B")}
          busy={!!busy}
        />
      </div>

      <footer className="trust">
        <div className="footer-left"><span className="brand footer-brand">ctx<span>Vault</span></span><span>© 2024 — THE HANDOFF BUTTON FOR AI TOOLS</span></div>
        <div className="footer-links"><span>Documentation</span><span>Vault API</span><span>Privacy</span><span>Support</span></div>
        <div className="session-trust">🔒 Same engine runs locally as an MCP server inside Claude Code &amp; Codex. Here it runs over HTTP with an in-memory store keyed to <code>your session</code>.</div>
      </footer>
    </div>
  );
}

function ChatPane(props: {
  pane: Pane;
  msgs: Msg[];
  active: boolean;
  resumed: boolean;
  draft: string;
  onFocus: () => void;
  onDraft: (v: string) => void;
  onSend: () => void;
  onResume: () => void;
  busy: boolean;
}) {
  const meta = PANE_META[props.pane];
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [props.msgs]);

  return (
    <div className={`col pane ${meta.cls} ${props.active ? "active" : ""}`} onClick={props.onFocus}>
      <div className="pane-head">
        <span className="pane-dot" />
        <span className="pane-name">{props.pane === "A" ? "TOOL A: PLANNING" : "TOOL B: IMPLEMENTATION"}</span>
        <span className="pane-role">{props.pane === "A" ? "CLAUDE-STYLE · V3.5" : "CODEX · PRO-V2"}</span>
      </div>
      <div className="pane-box">
      {props.resumed && (
        <div className="resumed-banner">✓ Resumed context injected — this tool knows your prior session.</div>
      )}
      <div className="messages" ref={scrollRef}>
        {props.msgs.length === 0 && (
          <div className="empty-panel">
            <div className="empty-diamond"><span>›_</span></div>
            <strong>EMPTY PANEL</strong>
            <p>Resume here from Tool {props.pane === "A" ? "B" : "A"}<br />or start typing below.</p>
            <button className="primary" onClick={props.onResume} disabled={props.busy}>
              RESUME IN TOOL {props.pane}
            </button>
          </div>
        )}
        {props.msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.resumed ? "resumed" : ""}`}>
            <div className="who">{m.role === "user" ? "you" : meta.name}</div>
            <div className="bubble">{m.content}</div>
          </div>
        ))}
      </div>
      <div className="composer">
        <input
          value={props.draft}
          placeholder={`Message ${meta.name}…`}
          onChange={(e) => props.onDraft(e.target.value)}
          onFocus={props.onFocus}
          onKeyDown={(e) => {
            if (e.key === "Enter") props.onSend();
          }}
        />
        <button className="send" onClick={props.onSend} disabled={props.busy || !props.draft.trim()}>
          SEND
        </button>
      </div>
      </div>
    </div>
  );
}

function VaultPanel(props: {
  vault: Vault | null;
  hasMemory: boolean;
  query: string;
  setQuery: (v: string) => void;
  onSearch: () => void;
  hits: Hit[] | null;
  busy: boolean;
}) {
  const { vault } = props;
  const note = vault?.note ?? null;
  const load = Math.min(100, (vault?.facts.length ?? 0) * 16 + (note ? 20 : 0));
  const filledBlocks = Math.ceil(load / 20);

  return (
    <div className="col vault">
      <div className="vault-head">
        <div className="vault-title">▤ THE VAULT</div>
      </div>
      <div className="vault-body">
        {!props.hasMemory && <div className="hint"><div>☼ &nbsp;TRY THIS:</div><p>Tool A already has a planning session. Hit <b>SAVE CONTEXT</b> to sync. Then switch to Tool B and <b>RESUME</b>.</p></div>}

        {note && (
          <div>
            <div className="section-label">Handoff note (episodic memory)</div>
            <div className="note-card">
              <div className="note-row">
                <div className="k">Goal</div>
                <div className="v">{note.goal}</div>
              </div>
              <div className="note-row">
                <div className="k">Current state</div>
                <div className="v">{note.currentState}</div>
              </div>
              <div className="note-row">
                <div className="k">Next step</div>
                <div className="v">{note.nextStep}</div>
              </div>
              {note.decisions.length > 0 && (
                <div className="note-row">
                  <div className="k">Decisions</div>
                  <ul className="note-list">
                    {note.decisions.map((d, i) => (
                      <li key={i}>
                        {d.what} — <em>{d.why}</em>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {note.openTodos.length > 0 && (
                <div className="note-row">
                  <div className="k">Open todos</div>
                  <ul className="note-list">
                    {note.openTodos.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}
              {note.gotchas.length > 0 && (
                <div className="note-row">
                  <div className="k">Gotchas</div>
                  <ul className="note-list">
                    {note.gotchas.map((g, i) => (
                      <li key={i}>{g}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {vault && vault.facts.length > 0 && (
          <div>
            <div className="section-label">OKF facts (semantic memory · {vault.facts.length})</div>
            {vault.facts.map((f) => (
              <div key={f.slug} className="fact-card">
                <div className="fact-file">knowledge/playground/{f.slug}.md</div>
                <div className="fact-title">{f.title}</div>
                <div className="fact-body">{f.body}</div>
                <div className="chips">
                  <span className="chip type">{f.type}</span>
                  {f.tags.map((t) => (
                    <span key={t} className="chip">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div>
          <div className="section-label">🔍 Search memory (semantic)</div>
          <div className="search-box">
            <input
              value={props.query}
              placeholder="e.g. why token bucket? what hashing?"
              onChange={(e) => props.setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") props.onSearch();
              }}
            />
            <button onClick={props.onSearch} disabled={props.busy || !props.query.trim()}>
              Search
            </button>
          </div>
          {props.hits && props.hits.length === 0 && (
            <div className="vault-empty" style={{ padding: "16px" }}>
              No matches — save some context first.
            </div>
          )}
          {props.hits?.map((h, i) => (
            <div key={i} className="hit">
              <div className="meta">
                <span className="kind">{h.kind}</span>
                <span>{h.refId}</span>
                <span>score {h.score.toFixed(3)}</span>
              </div>
              <div className="body">{h.text}</div>
            </div>
          ))}
        </div>
        <div className="vault-meter"><div className="meter-blocks" aria-label={`Vault load: ${load}%`}>{Array.from({ length: 5 }, (_, i) => <span key={i} className={i < filledBlocks ? "filled" : ""} />)}</div><span>VAULT LOAD: {load}%</span></div>
      </div>
    </div>
  );
}
