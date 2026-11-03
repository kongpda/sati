import { type SearchHit, shortHandle } from "@sati/core";

interface Row {
  id: string;
  title: string;
  status?: string;
  priority?: string;
}

export function row(r: Row): string {
  return [shortHandle(r.id), r.status, r.priority, r.title].filter(Boolean).join("  ");
}

/** Empty lists teach the next command instead of printing nothing. */
export function rows(items: readonly Row[], empty: string): string {
  return items.length ? items.map(row).join("\n") : empty;
}

const SKIP = new Set(["projectId", "deletedAt"]);

/** `key: value` lines for one record, skipping empty values. */
export function record(r: Row & Record<string, unknown>): string {
  const lines = [row(r)];
  for (const [k, v] of Object.entries(r)) {
    if (SKIP.has(k) || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    if (k === "title" || k === "status" || k === "priority") continue;
    lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return lines.join("\n");
}

export function hits(items: readonly SearchHit[]): string {
  if (!items.length) return "No matches.";
  return items
    .map((h) => `${shortHandle(h.id)}  ${h.title}${h.snippet ? `\n  ${h.snippet}` : ""}`)
    .join("\n");
}
