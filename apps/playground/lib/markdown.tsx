import type { ReactNode } from "react";

/**
 * markdown.tsx — a deliberately small markdown renderer for chat bubbles.
 *
 * Models answer in markdown, and raw "## Heading" / "**bold**" sitting in a chat
 * bubble reads as noise. This covers exactly what LLM chat output actually uses —
 * headings, bold, inline code, fenced code, bullet and numbered lists, rules —
 * and nothing else. No dependency for a demo-sized need.
 *
 * It builds React elements rather than an HTML string, so model output can never
 * inject markup: no `dangerouslySetInnerHTML`, nothing to sanitize.
 */

const UL = /^\s*[-*]\s+/;
const OL = /^\s*\d+[.)]\s+/;
const HEAD = /^(#{1,4})\s+(.*)$/;
const RULE = /^\s*([-*_])\1{2,}\s*$/;
const FENCE = /^\s*```/;

/** Inline pass: `code` and **bold**. Everything else is literal text. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(
      tok.startsWith("`") ? (
        <code key={`${key}-c${n}`}>{tok.slice(1, -1)}</code>
      ) : (
        <strong key={`${key}-b${n}`}>{tok.slice(2, -2)}</strong>
      ),
    );
    last = m.index + tok.length;
    n++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isBlockStart = (l: string) =>
  UL.test(l) || OL.test(l) || HEAD.test(l) || RULE.test(l) || FENCE.test(l);

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];
    const key = `b${k++}`;

    // fenced code block
    if (FENCE.test(line)) {
      i++;
      const body: string[] = [];
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      blocks.push(
        <pre key={key}>
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // horizontal rule
    if (RULE.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }

    // heading — clamped to h3/h4/h5 so a model's "#" can't out-shout the UI
    const h = HEAD.exec(line);
    if (h) {
      const Tag = (["h3", "h4", "h5"] as const)[Math.min(h[1].length, 3) - 1];
      blocks.push(<Tag key={key}>{inline(h[2], key)}</Tag>);
      i++;
      continue;
    }

    // bullet list
    if (UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL.test(lines[i])) items.push(lines[i++].replace(UL, ""));
      blocks.push(
        <ul key={key}>
          {items.map((it, n) => (
            <li key={n}>{inline(it, `${key}-${n}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // numbered list
    if (OL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL.test(lines[i])) items.push(lines[i++].replace(OL, ""));
      blocks.push(
        <ol key={key}>
          {items.map((it, n) => (
            <li key={n}>{inline(it, `${key}-${n}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // blank line
    if (!line.trim()) {
      i++;
      k--; // key wasn't used
      continue;
    }

    // paragraph — soft-wrapped lines join into one flowing block
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key}>{inline(para.join(" "), key)}</p>);
  }

  return <div className="md">{blocks}</div>;
}
