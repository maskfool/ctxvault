"""
render.py — build docs/assets/handoff.gif

Every line of terminal output in this animation is REAL: captured.json holds the
verbatim responses from a running CtxVault MCP server (see capture.mjs — two
independent server processes, so the "second tool" genuinely has no memory of the
first). Nothing here is mocked up. The only text I author is the narration
caption and anything drawn in ANNOT colour, which is visually distinct so it can
never read as program output.
"""
import json, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
CAP = json.load(open(os.path.join(HERE, "captured.json")))

W, H = 1000, 620
BG = (13, 17, 23)
CHROME = (22, 27, 34)
BORDER = (48, 54, 61)
FG = (201, 209, 217)
DIM = (110, 118, 129)
GREEN = (63, 185, 80)
BLUE = (88, 166, 255)
PURPLE = (163, 113, 247)
YELLOW = (210, 153, 34)
ANNOT = (110, 118, 129)  # my annotations — never program output

MONO = "/System/Library/Fonts/Menlo.ttc"
f_reg = ImageFont.truetype(MONO, 16, index=0)
f_bold = ImageFont.truetype(MONO, 16, index=1)
f_small = ImageFont.truetype(MONO, 13, index=0)
f_lbl = ImageFont.truetype(MONO, 14, index=1)
f_cap = ImageFont.truetype(MONO, 15, index=0)
f_big = ImageFont.truetype(MONO, 30, index=1)
f_mid = ImageFont.truetype(MONO, 17, index=0)

LINE_H = 23
PAD_X = 26
TOP = 92
CAP_Y = H - 44

# (image, duration_ms) pairs. PIL's GIF writer merges identical consecutive
# frames when optimizing, which silently deletes every "hold" — so durations are
# carried explicitly rather than by repeating a frame N times.
frames = []


def chrome(label, label_color=BLUE):
    """The window frame: traffic lights, a pane label, and the caption strip."""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 54], fill=CHROME)
    d.line([(0, 54), (W, 54)], fill=BORDER)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([20 + i * 20, 21, 32 + i * 20, 33], fill=c)
    d.text((92, 19), label, font=f_lbl, fill=label_color)
    d.line([(0, CAP_Y - 16), (W, CAP_Y - 16)], fill=BORDER)
    return img, d


def emit(img, ms=55):
    frames.append((img.copy(), ms))


DOT = "\x00"  # line prefix meaning "draw a filled dot in this line's colour"


def draw_lines(d, lines, y0=TOP, limit=None):
    """lines: (text, font, colour, indent). Returns the y after the last line."""
    y = y0
    for i, (t, fo, co, ind) in enumerate(lines):
        if limit is not None and i >= limit:
            break
        x = PAD_X + ind
        if t.startswith(DOT):
            # Menlo ships no ✅/⏺ glyph, so those arrive as tofu. Draw the mark.
            d.ellipse([x + 1, y + 5, x + 11, y + 15], fill=co)
            t, x = t[1:], x + 20
        d.text((x, y), t, font=fo, fill=co)
        y += LINE_H
    return y


def scene(label, label_color, caption, prompt, typed, out_lines, hold=2600, type_chunk=3, gap=2):
    """Type a command, then reveal real output a line at a time."""
    # typing
    for n in range(0, len(typed) + 1, type_chunk):
        img, d = chrome(label, label_color)
        d.text((PAD_X, CAP_Y), caption, font=f_cap, fill=DIM)
        d.text((PAD_X, TOP), prompt, font=f_bold, fill=GREEN)
        px = PAD_X + d.textlength(prompt, font=f_bold)
        d.text((px, TOP), typed[:n], font=f_reg, fill=FG)
        cx = px + d.textlength(typed[:n], font=f_reg)
        d.rectangle([cx + 1, TOP + 2, cx + 9, TOP + 18], fill=FG)
        emit(img, 45)

    # output, line by line
    for k in range(1, len(out_lines) + 1):
        img, d = chrome(label, label_color)
        d.text((PAD_X, CAP_Y), caption, font=f_cap, fill=DIM)
        d.text((PAD_X, TOP), prompt, font=f_bold, fill=GREEN)
        d.text((PAD_X + d.textlength(prompt, font=f_bold), TOP), typed, font=f_reg, fill=FG)
        draw_lines(d, out_lines, TOP + LINE_H * gap, limit=k)
        emit(img, 150 if k < len(out_lines) else 55)

    img, d = chrome(label, label_color)
    d.text((PAD_X, CAP_Y), caption, font=f_cap, fill=DIM)
    d.text((PAD_X, TOP), prompt, font=f_bold, fill=GREEN)
    d.text((PAD_X + d.textlength(prompt, font=f_bold), TOP), typed, font=f_reg, fill=FG)
    draw_lines(d, out_lines, TOP + LINE_H * gap)
    emit(img, hold)


def wrap(text, width=92):
    out = []
    for raw in text.split("\n"):
        if len(raw) <= width:
            out.append(raw)
            continue
        cur = ""
        for word in raw.split(" "):
            if len(cur) + len(word) + 1 > width:
                out.append(cur)
                cur = word
            else:
                cur = word if not cur else cur + " " + word
        if cur:
            out.append(cur)
    return out


# 88 monospace chars is what fits between the margins at 16px — anything longer
# is drawn past the right edge rather than wrapped, so wrap before drawing.
COLS = 88


def md_lines(raw):
    """One packet line → the (text, font, colour, indent) rows that render it."""
    if raw.strip() == "":
        return [("", f_reg, FG, 0)]
    if raw.startswith("# "):
        return [(raw[2:], f_bold, BLUE, 0)]
    if raw.startswith("## "):
        return [(raw[3:], f_bold, PURPLE, 0)]
    if raw.startswith("**"):
        body = raw.replace("**", "")
        return [(t, f_bold, FG, 0) for t in wrap(body, COLS)]
    if raw.startswith("- "):
        return [(t, f_reg, FG, 14 if i == 0 else 30)
                for i, t in enumerate(wrap(raw.replace("_", ""), COLS - 2))]
    if raw.startswith("_"):
        return [(t, f_reg, DIM, 0) for t in wrap(raw.strip("_"), COLS)]
    return [(t, f_reg, FG, 0) for t in wrap(raw, COLS)]


# ---------------------------------------------------------------- scene 1
save_out = []
for i, t in enumerate(wrap(CAP["save"], 88)):
    if t.startswith("✅"):
        save_out.append((DOT + t[2:], f_reg, GREEN, 0))
    else:
        save_out.append((t, f_reg, DIM, 0))
scene(
    "CLAUDE CODE  ·  calendar-app",
    BLUE,
    "1 · You're mid-task and about to hit a limit. One sentence saves the session.",
    "› ",
    "save this to ctxvault",
    [("", f_reg, FG, 0),
     (DOT + "save_context(project: \"calendar-app\")", f_reg, PURPLE, 0),
     ("    the agent fills in the handoff itself — no API key, no extra model", f_small, ANNOT, 0),
     ("", f_reg, FG, 0)] + save_out,
)

# ---------------------------------------------------------------- scene 2
resume_lines = CAP["resume"].split("\n")
cut = resume_lines.index("## Knowledge index (1)")
PREAMBLE = "You are picking up a session that was in progress in another AI tool."
shown = []
for l in resume_lines[:cut]:
    if l.startswith(PREAMBLE):
        continue
    shown += md_lines(l)
# Collapse runs of blank lines to one — the packet has doubles, the screen doesn't.
compact = []
for row in shown:
    if row[0] == "" and compact and compact[-1][0] == "":
        continue
    compact.append(row)
shown = compact
shown.append(("… knowledge index, related facts and the transcript tail follow",
              f_small, ANNOT, 0))
scene(
    "CODEX  ·  brand new session, knows nothing",
    YELLOW,
    "2 · A different tool. Different vendor. No shared memory. It just reads the vault.",
    "$ ",
    "resume project calendar-app",
    [("", f_reg, FG, 0)] + shown,
    hold=5200,
    gap=1,
)

# ---------------------------------------------------------------- scene 3
sr = CAP["search"].split("\n")
search_lines = [
    ("", f_reg, FG, 0),
    (DOT + "search_memory(\"why did we pick that date library\")", f_reg, PURPLE, 0),
    ("    keyword search, inside SQLite — costs zero context tokens", f_small, ANNOT, 0),
    ("", f_reg, FG, 0),
    ("Result 1 — fact, score 1.000", f_bold, BLUE, 0),
]
search_lines += [(t, f_reg, FG, 0) for t in wrap(sr[1], 88)]
search_lines += [
    ("", f_reg, FG, 0),
    ("~/.ctxvault/knowledge/calendar-app/world-clock-intl-api.md", f_reg, GREEN, 0),
    ("  a real markdown file — open it, grep it, fix it, commit it", f_small, ANNOT, 0),
]
scene(
    "CODEX  ·  brand new session, knows nothing",
    YELLOW,
    "3 · Ask about a decision from any past session. Answers come from files you own.",
    "$ ",
    "what did we decide about the date library?",
    search_lines,
    hold=4200,
)

# ---------------------------------------------------------------- end card
img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)
d.text((PAD_X + 30, 150), "CtxVault", font=ImageFont.truetype(MONO, 46, index=1), fill=FG)
d.text((PAD_X + 30, 214), "The handoff button for your AI tools", font=f_big, fill=BLUE)
for i, t in enumerate([
    "Zero API keys — your agent writes the handoff",
    "Memory is markdown you can read, edit and commit",
    "Works without MCP too: export and paste anywhere",
    "Syncs over your own private git remote",
]):
    d.text((PAD_X + 34, 292 + i * 34), "▸", font=f_mid, fill=GREEN)
    d.text((PAD_X + 62, 292 + i * 34), t, font=f_mid, fill=FG)
d.text((PAD_X + 30, 470), "github.com/maskfool/ctxvault", font=f_mid, fill=DIM)
d.text((PAD_X + 30, 498), "ctxvault.madebyshubham.in", font=f_mid, fill=DIM)
emit(img, 4000)

# ---------------------------------------------------------------- write
os.makedirs(os.path.join(HERE, "out"), exist_ok=True)
gif = os.path.join(HERE, "out", "handoff.gif")
# Collapse consecutive identical frames ourselves, summing their durations, so
# the writer has nothing left to merge behind our back.
merged = []
for img, ms in frames:
    if merged and merged[-1][0].tobytes() == img.tobytes():
        merged[-1][1] += ms
    else:
        merged.append([img, ms])

pal = [im.quantize(colors=128, method=Image.MEDIANCUT) for im, _ in merged]
durs = [ms for _, ms in merged]
pal[0].save(gif, save_all=True, append_images=pal[1:], duration=durs, loop=0, optimize=True)
total = sum(durs) / 1000
print(f"{len(pal)} frames · {os.path.getsize(gif)/1024:.0f} KB · {total:.1f}s")
print(gif)
