import { stripVTControlCharacters } from "node:util";

/**
 * What the terminal can show. `rich` is the layout for a person: aligned columns, symbols and
 * local times. Piped output stays plain and compact, because agents and scripts read it and pay
 * for every character. `color` follows https://no-color.org and FORCE_COLOR.
 */
export interface Term {
  rich: boolean;
  color: boolean;
  /** Colour on stderr, which may be a terminal when stdout is piped. */
  errColor: boolean;
  width: number;
  unicode: boolean;
}

type Env = Record<string, string | undefined>;
interface Stream {
  isTTY?: boolean | undefined;
  columns?: number | undefined;
}

const DEFAULT_WIDTH = 80;
const MIN_WIDTH = 40;

export function detect(
  env: Env = process.env,
  stdout: Stream = process.stdout,
  stderr: Stream = process.stderr,
  platform: string = process.platform,
): Term {
  const dumb = env.TERM === "dumb";
  const force = env.FORCE_COLOR;
  const forced = force !== undefined && force !== "" && force !== "0" && force !== "false";
  const banned =
    (env.NO_COLOR !== undefined && env.NO_COLOR !== "") || force === "0" || force === "false";
  // Some agent tools run commands in a pseudo-terminal. An agent still needs every title whole
  // and pays for padding, so it gets the plain lines. Same variables as `detectTool` in core.
  const agent = env.CLAUDECODE === "1" || (env.AI_AGENT ?? "").trim() !== "";
  const rich = forced || (stdout.isTTY === true && !dumb && !agent);
  // The legacy Windows console and the Linux virtual console lack the glyphs.
  const unicode =
    env.TERM !== "linux" &&
    (platform !== "win32" || env.WT_SESSION !== undefined || env.TERM_PROGRAM !== undefined);
  return {
    rich,
    color: rich && !banned,
    errColor: !banned && (forced || (stderr.isTTY === true && !dumb)),
    // COLUMNS covers a forced rich layout into a pipe, where the stream has no size.
    width: Math.max(MIN_WIDTH, stdout.columns || Number(env.COLUMNS) || DEFAULT_WIDTH),
    unicode,
  };
}

let current: Term | undefined;

/** Read on first use, after `main` has applied `--no-color`. */
export const term = (): Term => {
  current ??= detect();
  return current;
};

/** For tests, and for `--no-color`: forget what was detected, or set it. */
export function setTerm(next?: Term): void {
  current = next;
}

const sgr =
  (open: number, close: number, stderr = false) =>
  (text: string): string => {
    const t = term();
    return (stderr ? t.errColor : t.color) && text !== ""
      ? `\x1b[${open}m${text}\x1b[${close}m`
      : text;
  };

export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const underline = sgr(4, 24);
export const red = sgr(31, 39);
export const green = sgr(32, 39);
export const yellow = sgr(33, 39);
export const blue = sgr(34, 39);
export const magenta = sgr(35, 39);
export const cyan = sgr(36, 39);

const errRed = sgr(31, 39, true);
const errYellow = sgr(33, 39, true);
const errCyan = sgr(36, 39, true);
const errBold = sgr(1, 22, true);

export const symbols = () =>
  term().unicode
    ? { ok: "✔", fail: "✖", warn: "!", bullet: "•", arrow: "→", ellipsis: "…" }
    : { ok: "ok", fail: "x", warn: "!", bullet: "*", arrow: "->", ellipsis: "..." };

/**
 * Bidirectional overrides and isolates reorder the text around them, so a title could show a
 * different id or status than the record has.
 */
const BIDI = /[‪-‮⁦-⁩]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

/**
 * Record text comes from teammates' files and from agents. Printed as it is, an escape sequence
 * in a title could move the cursor, rewrite earlier lines, set the window title or write to the
 * clipboard. Newlines and tabs stay; every other control character goes.
 */
export function clean(text: string): string {
  // The common case: nothing to remove, no new string.
  if (text.search(CONTROL) === -1 && text.search(BIDI) === -1) return text;
  return stripVTControlCharacters(text.replace(/\r\n/gu, "\n"))
    .replace(CONTROL, "")
    .replace(BIDI, "");
}

/** `clean` for every string in a value that is about to be rendered as text. */
export function cleanDeep<T>(value: T): T {
  if (typeof value === "string") return clean(value) as T;
  if (Array.isArray(value)) return value.map(cleanDeep) as T;
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cleanDeep(v);
    return out as T;
  }
  return value;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches our own colour codes
const SGR = /\x1b\[[0-9;]*m/gu;
const ASCII = /^[\x20-\x7e]*$/u;
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\p{Emoji_Presentation}]/u;
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;

let graphemes: Intl.Segmenter | undefined;
const split = (text: string): string[] => {
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(graphemes.segment(text), (s) => s.segment);
};
const cell = (g: string): number => (ZERO.test(g) ? 0 : WIDE.test(g) ? 2 : 1);

/** Columns a string takes on screen: colour codes take none, CJK and emoji take two. */
export function width(text: string): number {
  const bare = text.replace(SGR, "");
  if (ASCII.test(bare)) return bare.length;
  let n = 0;
  for (const g of split(bare)) n += cell(g);
  return n;
}

/** Cuts plain text (no colour codes) to `max` columns, ending in an ellipsis. */
export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text;
  const end = symbols().ellipsis;
  const room = Math.max(0, max - end.length);
  let out = "";
  let n = 0;
  for (const g of split(text)) {
    const w = cell(g);
    if (n + w > room) break;
    out += g;
    n += w;
  }
  return `${out.trimEnd()}${end}`;
}

export const pad = (text: string, to: number): string =>
  text + " ".repeat(Math.max(0, to - width(text)));

/**
 * Word-wraps plain text to `max` columns. Lines after the first start with `indent`; `first` is
 * the columns already taken on the first line. A word longer than a line (a path, a URL) is
 * kept whole: a cut path cannot be copied.
 */
export function wrap(text: string, max: number, indent = "", first = 0): string {
  const out: string[] = [];
  text.split("\n").forEach((para, p) => {
    // Leading spaces are the paragraph's own indent, not words.
    const lead = /^ */u.exec(para)?.[0] ?? "";
    let before = `${p === 0 ? "" : indent}${lead}`;
    let used = width(before) + (p === 0 ? first : 0);
    let line = "";
    for (const word of para.slice(lead.length).split(" ")) {
      if (line === "") {
        line = word;
      } else if (used + width(line) + 1 + width(word) <= max) {
        line += ` ${word}`;
      } else {
        out.push(`${before}${line}`);
        before = `${indent}${lead}`;
        used = width(before);
        line = word;
      }
    }
    out.push(`${before}${line}`);
  });
  return out.join("\n");
}

const GAP = "  ";

/**
 * Aligned columns. Cells may carry colour. The `flex` column takes what is left of the terminal
 * width and is cut to fit; give it plain text and a `paint` to colour it after the cut.
 */
export function table(
  input: readonly (readonly string[])[],
  opts: { flex?: number; paint?: (text: string) => string; indent?: string } = {},
): string {
  const indent = opts.indent ?? "";
  // A tab moves the cursor by an amount only the terminal knows, which breaks the columns.
  const rows = input.map((r) => r.map((c) => c.replaceAll("\t", " ")));
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(0, ...rows.map((r) => width(r[c] ?? ""))),
  );
  const flex = opts.flex;
  let room = Number.POSITIVE_INFINITY;
  if (flex !== undefined) {
    const fixed = widths.reduce((a, w, c) => (c === flex ? a : a + w), 0);
    room = Math.max(16, term().width - width(indent) - fixed - GAP.length * (cols - 1));
  }
  return rows
    .map((r) => {
      const cells = widths.map((w, c) => {
        const raw = r[c] ?? "";
        const last = c === cols - 1;
        if (c !== flex) return last ? raw : pad(raw, w);
        const cut = truncate(raw, room);
        const shown = opts.paint ? opts.paint(cut) : cut;
        return last ? shown : pad(shown, Math.min(w, room));
      });
      return `${indent}${cells.join(GAP)}`.trimEnd();
    })
    .join("\n");
}

const two = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A UTC timestamp as a person reads it: local time, with the date only when it is not today.
 * Plain output keeps the stored ISO string, which scripts can parse.
 */
export function when(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  if (!term().rich) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear()
    ? `${date} ${time}`
    : `${date} ${d.getFullYear()} ${time}`;
}

/** The home folder as `~`, for a person; scripts get the full path. */
export function tilde(path: string, home: string | undefined = process.env.HOME): string {
  if (!term().rich || !home || home === "/") return path;
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const CODE = /`([^`\n]+)`/gu;
const HANDLE = /^(\s*(?:-|\d+\.) (?:card )?)([a-z]{2,5}_[0-9a-z]{6})\b/u;

/**
 * The brief, recall and changes are Markdown, written for agents. For a person the same text is
 * wrapped to the terminal and lightly coloured. Nothing is added or removed.
 */
export function markdown(text: string): string {
  const t = term();
  if (!t.rich) return text;
  const max = Math.min(t.width, 120);
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        fenced = !fenced;
        return dim(line);
      }
      if (fenced) return dim(wrap(line, max));
      if (line.startsWith("# ")) return bold(underline(line.slice(2)));
      if (/^#{2,} /u.test(line)) return bold(line.replace(/^#+ /u, ""));
      const item = /^(\s*)(?:-|\d+\.) /u.exec(line);
      const wrapped = wrap(line, max, item ? "  " : "");
      if (item && /^\s*- … /u.test(line)) return dim(wrapped);
      return wrapped
        .replace(HANDLE, (_, lead: string, id: string) => `${lead}${cyan(id)}`)
        .replace(CODE, code);
    })
    .join("\n");
}

/** A command to run stands out in colour; without colour it keeps its backticks. */
const code = (all: string, inner: string): string => (term().color ? cyan(inner) : all);

const DONE =
  /^(Created|Updated|Deleted|Restored|Claimed|Released|Completed|Recorded|Saved|Locked|Commented on|Took over|Imported|Exported|Synced|Initialized|Upgraded|Approved|Undid|Handoff|Read|Cleared|Forgot|Wrote|Sharing is on)\b/u;
const LABEL = /^(\s*)(warning|blocked|hint|Note|Next):/u;
/**
 * A rich list whose first line starts with stored text (an author's name) begins with this, so a
 * name such as "Created by hand" is not taken for a finished action. `polish` removes it.
 */
export const LISTED = "\u2060";

/**
 * The last pass over every command's text for a person: a tick on the line that says what was
 * done, colour on `warning:`, `blocked:` and `hint:` labels, and on commands to run.
 */
export function polish(input: string): string {
  const t = term();
  if (!t.rich || input === "") return input;
  const listed = input.startsWith(LISTED);
  const text = listed ? input.slice(LISTED.length) : input;
  const paint: Record<string, (s: string) => string> = {
    warning: yellow,
    Note: yellow,
    blocked: (s) => bold(red(s)),
    hint: cyan,
    Next: cyan,
  };
  const lines = text
    .split("\n")
    .map((line) =>
      line
        .replace(
          LABEL,
          (_, lead: string, label: string) => `${lead}${(paint[label] ?? bold)(`${label}:`)}`,
        )
        .replace(CODE, code),
    );
  if (!listed && DONE.test(lines[0] ?? "")) lines[0] = `${green(symbols().ok)} ${lines[0]}`;
  return lines.join("\n");
}

/** `error:`, `hint:` and `warning:` lines go to stderr, so a pipe still gets clean stdout. */
export function errorText(message: string, hint?: string | null): string {
  const lines = [`${errBold(errRed("error:"))} ${clean(message)}`];
  if (hint) lines.push(`${errCyan("hint:")} ${clean(hint)}`);
  return `${lines.join("\n")}\n`;
}

export function warn(message: string): void {
  process.stderr.write(`${errYellow("warning:")} ${clean(message)}\n`);
}

/**
 * The pager for output taller than the window, or `null` to print as usual. As git does: `PAGER`
 * names it, `less` is the default, and `PAGER=cat` or an empty `PAGER` turns it off. `less` gets
 * F (leave at once if the text fits), R (keep colour) and X (leave the text on screen).
 */
export function pager(
  lines: number,
  env: Record<string, string | undefined> = process.env,
  stdout: { isTTY?: boolean | undefined; rows?: number | undefined } = process.stdout,
  platform: string = process.platform,
): { command: string; env: Record<string, string> } | null {
  if (!term().rich || stdout.isTTY !== true || !stdout.rows || lines < stdout.rows) return null;
  const command = (env.SATI_PAGER ?? env.PAGER)?.trim() ?? (platform === "win32" ? "" : "less");
  if (command === "" || command === "cat") return null;
  return { command, env: env.LESS === undefined ? { LESS: "FRX" } : {} };
}

/**
 * Sends text through the pager and waits for it to close. False when the pager is not installed
 * (127) or could not start (126), so the caller prints the text as usual.
 */
export async function pipeTo(
  use: { command: string; env: Record<string, string> },
  text: string,
): Promise<boolean> {
  const { spawnSync } = await import("node:child_process");
  // The pager is the user's own setting, run as git runs it: through the shell.
  const r = spawnSync(use.command, {
    shell: true,
    input: `${text}\n`,
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, ...use.env },
  });
  return r.error === undefined && r.status !== 127 && r.status !== 126;
}
