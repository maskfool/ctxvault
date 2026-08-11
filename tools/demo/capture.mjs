import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const VAULT = process.env.DEMO_VAULT;

function client() {
  const p = spawn("node", ["/Users/shubham/Developer/gen-ai/ctxvault/apps/mcp-server/dist/index.js"],
    { env: { ...process.env, CTXVAULT_HOME: VAULT }, stdio: ["pipe","pipe","pipe"] });
  let buf = ""; const pending = new Map();
  p.stdout.on("data", d => { buf += d; let i;
    while ((i = buf.indexOf("\n")) !== -1) { const l = buf.slice(0,i).trim(); buf = buf.slice(i+1);
      if (!l) continue; const m = JSON.parse(l); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  let id = 0;
  const call = (method, params) => new Promise(res => { const my = ++id; pending.set(my, res);
    p.stdin.write(JSON.stringify({ jsonrpc:"2.0", id:my, method, params }) + "\n"); });
  return { p, call };
}

const a = client();
await a.call("initialize", { protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{name:"claude-code",version:"1"} });
a.p.stdin.write(JSON.stringify({ jsonrpc:"2.0", method:"notifications/initialized" }) + "\n");

const save = await a.call("tools/call", { name:"save_context", arguments: {
  project: "calendar-app",
  handoff: {
    goal: "Add a live world-clock widget to the dashboard",
    decisions: [{ what: "Use native Intl.DateTimeFormat", why: "zero dependencies, works cross-browser" }],
    currentState: "Widget renders four cities; timezone formatting works. Not browser-tested yet.",
    openTodos: ["Trim the city list to four", "Test in Safari and Firefox"],
    filesTouched: ["src/widgets/WorldClock.tsx", "src/lib/time.ts"],
    gotchas: ["Safari returns a different offset string for GMT+0"],
    nextStep: "Trim the city list to four and run the browser test pass",
  },
  facts: [{ slug: "world-clock-intl-api", type: "decision",
    title: "Use Intl.DateTimeFormat for timezone display",
    body: "Chose native Intl.DateTimeFormat over date-fns and moment: zero dependencies, cross-browser, no bundle cost.",
    tags: ["timezone","intl-api"] }],
  transcript: "User: add a world clock widget\nAssistant: I'll use Intl.DateTimeFormat — native, zero deps.",
}});
a.p.kill();

// A SECOND, INDEPENDENT process — the "other tool", with no memory of the first.
const b = client();
await b.call("initialize", { protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{name:"codex",version:"1"} });
b.p.stdin.write(JSON.stringify({ jsonrpc:"2.0", method:"notifications/initialized" }) + "\n");
const resume = await b.call("tools/call", { name:"resume_context", arguments:{ project:"calendar-app", budget:1200 }});
const search = await b.call("tools/call", { name:"search_memory", arguments:{ project:"calendar-app", query:"why did we pick that date library" }});
b.p.kill();

writeFileSync(process.env.OUT, JSON.stringify({
  save: save.result.content[0].text,
  resume: resume.result.content[0].text,
  search: search.result.content[0].text,
}, null, 2));
console.log("captured");
