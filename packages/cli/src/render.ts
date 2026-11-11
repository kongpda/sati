import { type SearchHit, shortHandle } from "@sati/core";
import {
  bold,
  cyan,
  dim,
  green,
  magenta,
  red,
  symbols,
  table,
  term,
  when,
  wrap,
  yellow,
} from "./term.js";

interface Row {
  id: string;
  title: string;
  status?: string;
  priority?: string;
  effort?: string | null | undefined;
  dueDate?: string | null | undefined;
}

type Paint = (text: string) => string;
const plain: Paint = (text) => text;

const STATUS: Record<string, Paint> = {
  done: green,
  shipped: green,
  in_progress: cyan,
  review: magenta,
  blocked: red,
  backlog: dim,
  cancelled: dim,
  deprecated: dim,
  removed: dim,
};
const PRIORITY: Record<string, Paint> = {
  urgent: (text) => bold(red(text)),
  high: yellow,
  low: dim,
};

export const status = (s: string | undefined): string => (s ? (STATUS[s] ?? plain)(s) : "");
const priority = (p: string | undefined): string => (p ? (PRIORITY[p] ?? plain)(p) : "");
export const handle = (id: string): string => cyan(shortHandle(id));

const due = (r: Row) => (r.dueDate ? `due ${r.dueDate}` : "");
const effort = (r: Row) => (r.effort && r.effort !== "standard" ? r.effort : "");

/** One record on one line. Also the tail of "Created …" and "Claimed …" messages. */
export function row(r: Row): string {
  return [handle(r.id), status(r.status), priority(r.priority), effort(r), due(r), r.title]
    .filter(Boolean)
    .join("  ");
}

/**
 * Empty lists teach the next command instead of printing nothing. A person gets aligned
 * columns with the title cut to the terminal; a pipe gets the compact rows.
 */
export function rows(items: readonly Row[], empty: string): string {
  if (!items.length) return empty;
  if (!term().rich) return items.map(row).join("\n");
  const cells = items.map((r) => [
    handle(r.id),
    status(r.status),
    priority(r.priority),
    effort(r),
    due(r),
    r.title,
  ]);
  // A column no row fills (notes have no status) is left out.
  const used = [0, 1, 2, 3, 4, 5].filter((c) => cells.some((r) => r[c] !== ""));
  return table(
    cells.map((r) => used.map((c) => r[c] ?? "")),
    { flex: used.length - 1 },
  );
}

const SKIP = new Set(["projectId", "deletedAt", "stamps"]);
const HEAD = new Set(["title", "status", "priority", "effort"]);
/** Long text gets its own block under the fields. */
const PROSE = new Set(["body", "context", "decision", "consequences", "summary", "acceptance"]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

const empty = (v: unknown) => v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** A field value for a person: times in local time, lists and nested records without JSON. */
function show(v: unknown): string {
  if (typeof v === "string") return ISO.test(v) ? when(v) : v;
  if (Array.isArray(v)) {
    return v.every((x) => typeof x !== "object" || x === null)
      ? v.map(show).join(", ")
      : v.map((x) => `\n${show(x)}`).join("");
  }
  if (v !== null && typeof v === "object") {
    return Object.entries(v)
      .filter(([, x]) => !empty(x))
      .map(([k, x]) => `${k} ${show(x)}`)
      .join(", ");
  }
  return String(v);
}

/** `key: value` lines for one record, skipping empty values. */
export function record(r: Row & Record<string, unknown>): string {
  const fields = Object.entries(r).filter(([k, v]) => !SKIP.has(k) && !HEAD.has(k) && !empty(v));
  if (!term().rich) {
    const lines = [row(r)];
    for (const [k, v] of fields) {
      lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
    return lines.join("\n");
  }
  const max = Math.min(term().width, 120);
  const nested = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  const short = fields.filter(([k, v]) => !PROSE.has(k) && !nested(v));
  const lines = [
    [handle(r.id), status(r.status), priority(r.priority), effort(r), due(r)]
      .filter(Boolean)
      .join("  "),
    bold(wrap(r.title, max)),
    "",
    ...pairs(short, max),
  ];
  // A nested record (a claim, a completion) is a block of its own fields, not JSON.
  for (const [k, v] of fields.filter(([, x]) => nested(x))) {
    const inner = Object.entries(v as object).filter(([, x]) => !empty(x));
    lines.push("", bold(k), ...pairs(inner, max));
  }
  for (const [k, v] of fields.filter(([k]) => PROSE.has(k))) {
    const text = Array.isArray(v) ? v.map((x) => `- ${show(x)}`).join("\n") : show(v);
    lines.push("", bold(k), wrap(text, max - 2).replace(/^/gmu, "  "));
  }
  return lines.join("\n");
}

/** Aligned `key  value` lines, indented two spaces, values wrapped beside their key. */
export function pairs(fields: readonly (readonly [string, unknown])[], max: number): string[] {
  const keyWidth = Math.max(0, ...fields.map(([k]) => k.length));
  const indent = " ".repeat(keyWidth + 4);
  return fields.map(
    ([k, v]) => `  ${dim(k.padEnd(keyWidth))}  ${wrap(show(v), max, indent, indent.length)}`,
  );
}

export function hits(items: readonly SearchHit[]): string {
  if (!items.length) return "No matches.";
  if (!term().rich) {
    return items
      .map((h) => `${shortHandle(h.id)}  ${h.title}${h.snippet ? `\n  ${h.snippet}` : ""}`)
      .join("\n");
  }
  const max = Math.min(term().width, 120);
  return items
    .map((h) => {
      // The store marks each matched word as [word].
      const snippet = h.snippet
        ? `\n${wrap(`  ${h.snippet}`, max).replace(/\[([^\]\n]+)\]/gu, (all: string, w: string) => (term().color ? bold(yellow(w)) : all))}`
        : "";
      return `${handle(h.id)}  ${bold(h.title)}${snippet}`;
    })
    .join("\n");
}

/** A check line: a symbol, an aligned name and the detail wrapped beside it. */
export function checks(items: readonly { name: string; ok: boolean; detail: string }[]): string {
  if (!term().rich) {
    return items.map((c) => `${c.ok ? "ok" : "fail"} ${c.name}: ${c.detail}`).join("\n");
  }
  const sym = symbols();
  const name = Math.max(0, ...items.map((c) => c.name.length));
  const indent = " ".repeat(sym.ok.length + name + 3);
  const max = Math.min(term().width, 120);
  const lines = items.map((c) => {
    const mark = c.ok ? green(sym.ok) : red(sym.fail.padEnd(sym.ok.length));
    const label = c.ok ? c.name.padEnd(name) : bold(red(c.name.padEnd(name)));
    return `${mark} ${label}  ${wrap(c.detail, max, indent, indent.length)}`;
  });
  const failed = items.filter((c) => !c.ok).length;
  const passed = items.length - failed;
  lines.push(
    "",
    failed === 0
      ? green(`${passed} checks passed.`)
      : `${bold(red(`${failed} failed`))}, ${passed} passed.`,
  );
  return lines.join("\n");
}
