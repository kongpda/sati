import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { maxHlc, parseHlc } from "../domain/hlc.js";
import { shortHandle } from "../domain/ids.js";
import { ActorId, type Feature, type Milestone, type Note, type Task } from "../domain/schemas.js";
import type { FeatureStatus } from "../domain/status.js";
import type { StorageReader } from "../ports/storage.js";
import { COMMENT_TAG } from "./comment.js";
import { listAll, nowIso, parseInput, type ServiceContext } from "./context.js";
import { HANDOFF_TAG } from "./handoff.js";
import { resolveId } from "./query.js";
import { clip, plural } from "./text.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 7;
/** Writes sati makes on its own; they do not mark the end of anyone's session. */
const AUTOMATIC_VERBS = new Set(["import", "release", "init"]);
/** Labels that put a task under Fixed, Added or Removed in a changelog; the rest is Changed. */
const FIXED = new Set(["fix", "fixed", "bug", "bugfix", "hotfix"]);
const ADDED = new Set(["feature", "feat", "added", "new", "enhancement"]);
const REMOVED = new Set(["removed", "remove", "removal"]);
/** Tasks with this label never reach a changelog or digest. */
export const INTERNAL_LABEL = "internal";

export const CHANGE_FORMATS = ["plain", "changelog", "digest"] as const;
export type ChangeFormat = (typeof CHANGE_FORMATS)[number];

export const ChangesInput = z.strictObject({
  since: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "A day (YYYY-MM-DD), a UTC time, 24h / 7d / 2w, last-session, or a milestone id or handle (what changed after it was done). Default 7d.",
    ),
  milestoneId: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe("Only what belongs to this milestone (id or handle)"),
  actorId: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .optional()
    .describe("Only what this person or agent did (id or handle)"),
});
export type ChangesInput = z.input<typeof ChangesInput>;

interface ItemBase {
  id: string;
  title: string;
  /** When it happened (UTC). */
  at: string;
  /** Who did it, when the record says; `null` for records written before stamps. */
  by: string | null;
  milestoneId: string | null;
  featureId: string | null;
}
export type ChangeItem =
  | (ItemBase & {
      kind: "done";
      labels: string[];
      summary: string;
      releaseNote: string | null;
      filesTouched: string[];
    })
  | (ItemBase & { kind: "feature"; status: FeatureStatus })
  | (ItemBase & { kind: "decision" })
  | (ItemBase & { kind: "note"; edited: boolean });

export interface Changes {
  project: string;
  /** Start of the window (UTC, inclusive). */
  since: string;
  /** How `since` was chosen, in words: "the last 7 days", "your last session". */
  basis: string;
  /** The milestone filter, if any. */
  milestone: { id: string; title: string } | null;
  /** Newest first. */
  items: ChangeItem[];
  /** Open tasks that are blocked now. */
  blocked: { id: string; title: string; labels: string[] }[];
  /** Open tasks past their due day. */
  overdue: { id: string; title: string; labels: string[]; dueDate: string }[];
  /** Every milestone, in roadmap order, to group items by. */
  milestones: { id: string; title: string }[];
}

const isoDay = (iso: string) => iso.slice(0, 10);

/** When the field was last set, from its clock stamp. */
function stampAt(rec: { stamps?: Record<string, string> | undefined }, key: string) {
  const stamp = rec.stamps?.[key];
  const parsed = stamp ? parseHlc(stamp) : undefined;
  return parsed ? new Date(parsed.ms).toISOString() : undefined;
}

/** Who wrote a stamp: its node is the writer's actor id. */
function stampBy(stamp: string | undefined): string | null {
  const node = stamp ? parseHlc(stamp)?.node : undefined;
  return node && ActorId.safeParse(node).success ? node : null;
}

/**
 * The actors that are "you": every session of the same identity. Agents get a new actor per
 * session (`claude-code@repo#a1b2`), so the previous session is a sibling actor.
 */
async function selves(r: StorageReader, ctx: ServiceContext) {
  const actors = await listAll(r, ctx, "actor");
  const me = actors.find((a) => a.id === ctx.actorId);
  const base = me?.name.split("#")[0];
  const ids = new Set([ctx.actorId]);
  for (const a of actors) {
    if (base !== undefined && (a.name === base || a.name.startsWith(`${base}#`))) ids.add(a.id);
  }
  return { ids, perSession: me?.name.includes("#") === true };
}

/**
 * The end of your last session: your last write, not counting what sati does on its own
 * (imports, released claims). A session-scoped agent skips its own current session.
 */
export async function lastSession(
  r: StorageReader,
  ctx: ServiceContext,
): Promise<{ at: string | null; selves: Set<string> }> {
  const me = await selves(r, ctx);
  // One query for every session: an agent gets a new actor per session, so a loop with one
  // query each grew with every session the project had seen.
  const actorIds = [...me.ids].filter((id) => !(me.perSession && id === ctx.actorId));
  const rows = await r.listActivity(ctx.projectId, { actorIds, limit: 200 });
  const at = rows.find((row) => !AUTOMATIC_VERBS.has(row.verb))?.at ?? null;
  return { at, selves: me.ids };
}

/** Everything that changed at or after `since`, read inside one snapshot. */
export async function readChanges(
  r: StorageReader,
  ctx: ServiceContext,
  opts: { since: string; milestoneId?: string | undefined; actorId?: string | undefined },
): Promise<Omit<Changes, "basis" | "project">> {
  const { since } = opts;
  const now = nowIso(ctx);
  const today = isoDay(now);
  const changed = { updatedSince: since, limit: 500 } as const;
  const pages = async <E extends "task" | "feature" | "decision" | "note">(entity: E) => {
    const out = [];
    for (let offset = 0; ; offset += 500) {
      const page = await r.list(entity, ctx.projectId, { ...changed, offset });
      out.push(...page);
      if (page.length < 500) return out;
    }
  };
  const features = await listAll(r, ctx, "feature");
  const milestones = (await listAll(r, ctx, "milestone")).sort(
    (a: Milestone, b: Milestone) => a.order - b.order || a.id.localeCompare(b.id),
  );
  const featureById = new Map(features.map((f) => [f.id, f]));
  const milestoneOf = (t: Pick<Task, "milestoneId" | "featureId">) =>
    t.milestoneId ?? (t.featureId ? (featureById.get(t.featureId)?.milestoneId ?? null) : null);

  const items: ChangeItem[] = [];
  for (const t of await pages("task")) {
    const c = t.completion;
    if (t.status !== "done" || !c || c.completedAt < since) continue;
    items.push({
      kind: "done",
      id: t.id,
      title: t.title,
      at: c.completedAt,
      by: c.completedBy,
      milestoneId: milestoneOf(t),
      featureId: t.featureId,
      labels: t.labels,
      summary: c.summary,
      releaseNote: c.releaseNote ?? null,
      filesTouched: c.filesTouched,
    });
  }
  for (const f of features) {
    if (f.updatedAt < since) continue;
    // Records from before stamps had their status set when they were created.
    const at = stampAt(f, "status") ?? f.createdAt;
    // A feature added as planned has not moved yet.
    if (at < since || (f.createdAt >= since && f.status === "planned")) continue;
    items.push({
      kind: "feature",
      id: f.id,
      title: f.title,
      at,
      by: f.stamps?.status ? stampBy(f.stamps.status) : f.createdBy,
      milestoneId: f.milestoneId,
      featureId: f.id,
      status: f.status,
    });
  }
  for (const d of await pages("decision")) {
    if (d.createdAt < since) continue;
    const featureId = d.featureIds[0] ?? null;
    items.push({
      kind: "decision",
      id: d.id,
      title: d.title,
      at: d.createdAt,
      by: d.createdBy,
      milestoneId: featureId ? (featureById.get(featureId)?.milestoneId ?? null) : null,
      featureId,
    });
  }
  const notes: Note[] = (await pages("note")).filter(
    (n) => !n.tags.includes(COMMENT_TAG) && !n.tags.includes(HANDOFF_TAG),
  );
  for (const n of notes) {
    const edited = n.createdAt < since;
    items.push({
      kind: "note",
      id: n.id,
      title: n.title,
      at: edited ? n.updatedAt : n.createdAt,
      by: edited ? stampBy(maxHlc(Object.values(n.stamps ?? {}))) : n.createdBy,
      milestoneId: null,
      featureId: null,
      edited,
    });
  }

  const open = ["backlog", "todo", "in_progress", "review", "blocked"];
  const blockedTasks = await r.list("task", ctx.projectId, { status: ["blocked"], limit: 500 });
  const dueTasks = (
    await r.list("task", ctx.projectId, { status: open, dueBy: today, limit: 500 })
  ).filter((t) => typeof t.dueDate === "string" && t.dueDate < today);

  const scope = opts.milestoneId;
  const inScope = (milestoneId: string | null) => scope === undefined || milestoneId === scope;
  // A note belongs to the milestone when it links to the milestone or to something in it.
  const scopedIds = new Set(
    items.filter((i) => i.kind !== "note" && inScope(i.milestoneId)).map((i) => i.id),
  );
  if (scope) scopedIds.add(scope);
  const linksOf = new Map(notes.map((n) => [n.id, n.links]));
  const kept = items
    .filter((i) =>
      i.kind === "note"
        ? scope === undefined || (linksOf.get(i.id) ?? []).some((l) => scopedIds.has(l))
        : inScope(i.milestoneId),
    )
    .filter((i) => opts.actorId === undefined || i.by === opts.actorId)
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));

  const milestone = scope ? milestones.find((m) => m.id === scope) : undefined;
  return {
    since,
    milestone: milestone ? { id: milestone.id, title: milestone.title } : null,
    items: kept,
    blocked: blockedTasks
      .filter((t) => inScope(milestoneOf(t)))
      .map((t) => ({ id: t.id, title: t.title, labels: t.labels })),
    overdue: dueTasks
      .filter((t) => inScope(milestoneOf(t)))
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
      .map((t) => ({ id: t.id, title: t.title, labels: t.labels, dueDate: String(t.dueDate) })),
    milestones: milestones.map((m) => ({ id: m.id, title: m.title })),
  };
}

/** Turns `since` into a UTC time and says in words what it means. */
async function resolveSince(
  ctx: ServiceContext,
  raw: string | undefined,
): Promise<{ since: string; basis: string }> {
  const now = ctx.clock.now().getTime();
  const daysAgo = (days: number) => new Date(now - days * DAY_MS).toISOString();
  const input = raw ?? `${DEFAULT_DAYS}d`;
  const rel = /^(\d{1,4})([hdw])$/u.exec(input);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2] === "h" ? 1 / 24 : rel[2] === "w" ? 7 : 1;
    const word = rel[2] === "h" ? "hour" : rel[2] === "w" ? "week" : "day";
    return { since: daysAgo(n * unit), basis: `the last ${n} ${word}${n === 1 ? "" : "s"}` };
  }
  if (input === "last-session") {
    const { at } = await ctx.store.read((r) => lastSession(r, ctx));
    return at
      ? { since: at, basis: `your last session (${at.slice(0, 16).replace("T", " ")} UTC)` }
      : { since: daysAgo(DEFAULT_DAYS), basis: "the last 7 days (no earlier session found)" };
  }
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/u.test(input)) {
    const ms = Date.parse(input.length === 10 ? `${input}T00:00:00.000Z` : input);
    // Date.parse rolls a day that does not exist (2026-02-31) into the next month.
    if (!Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === input.slice(0, 10)) {
      const since = new Date(ms).toISOString();
      return { since, basis: input.length === 10 ? input : since };
    }
  }
  if (!/^mil_/iu.test(input)) {
    throw new SatiError("VALIDATION", `"${input}" is not a time sati understands.`, {
      hint: "Use a day (2026-11-01), 24h, 7d, 2w, last-session or a milestone id.",
    });
  }
  const id = await resolveId(ctx, "milestone", input);
  const m = await ctx.store.read((r) => r.get("milestone", id));
  if (m?.status !== "done") {
    throw new SatiError("VALIDATION", `Milestone ${shortHandle(id)} is not done yet.`, {
      hint: "To list what is in it, pass it as the milestone filter instead.",
    });
  }
  const since = stampAt(m, "status") ?? m.updatedAt;
  return { since, basis: `${m.title} was done (${isoDay(since)})` };
}

/**
 * What changed: done tasks with their summary, release note and files, features that moved
 * status, decisions, new and edited notes (not comments), and what is blocked or overdue now.
 * Built from the records, so changes pulled in from teammates through git count too.
 */
export async function listChanges(ctx: ServiceContext, input: unknown = {}): Promise<Changes> {
  const data = parseInput(ChangesInput, input);
  const { since, basis } = await resolveSince(ctx, data.since);
  const milestoneId = data.milestoneId
    ? await resolveId(ctx, "milestone", data.milestoneId)
    : undefined;
  const actorId = data.actorId ? await resolveId(ctx, "actor", data.actorId) : undefined;
  return ctx.store.read(async (r) => {
    const project = await r.getProject();
    const changes = await readChanges(r, ctx, { since, milestoneId, actorId });
    return { project: project?.name ?? "this project", basis, ...changes };
  });
}

/** Ends the text with a full stop unless it already ends a sentence. */
const sentence = (s: string) => (/[.!?…]$/u.test(s) ? s : `${s}.`);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const FEATURE_WORDS: Record<FeatureStatus, string> = {
  planned: "planned",
  building: "being built",
  shipped: "shipped",
  deprecated: "deprecated",
  removed: "removed",
};
/** Most items any text format lists, so a long window stays readable. */
const MAX_LINES = 200;

/** Groups items by milestone, in roadmap order, with "No milestone" last. */
function byMilestone(c: Changes) {
  const groups: { title: string | null; items: ChangeItem[] }[] = [];
  for (const m of c.milestones) {
    const items = c.items.filter((i) => i.milestoneId === m.id);
    if (items.length > 0) groups.push({ title: m.title, items });
  }
  const known = new Set(c.milestones.map((m) => m.id));
  const rest = c.items.filter((i) => i.milestoneId === null || !known.has(i.milestoneId));
  if (rest.length > 0) groups.push({ title: null, items: rest });
  return groups;
}

const isPublic = (i: ChangeItem) => i.kind !== "done" || !i.labels.includes(INTERNAL_LABEL);

function plain(c: Changes): string {
  const out = [
    `# Changes since ${c.since.slice(0, 16).replace("T", " ")} UTC`,
    `${capital(c.basis)}${c.milestone ? `, in ${clip(c.milestone.title, 120)}` : ""}: ${plural(c.items.length, "change")}.`,
  ];
  let shown = 0;
  const groups = byMilestone(c);
  for (const g of groups) {
    if (groups.length > 1 || g.title)
      out.push("", `## ${g.title === null ? "No milestone" : clip(g.title, 120)}`);
    const sections: [string, ChangeItem["kind"]][] = [
      ["Done", "done"],
      ["Features", "feature"],
      ["Decisions", "decision"],
      ["Notes", "note"],
    ];
    for (const [heading, kind] of sections) {
      const items = g.items.filter((i) => i.kind === kind);
      if (items.length === 0) continue;
      out.push(`${heading}:`);
      for (const i of items) {
        if (++shown > MAX_LINES) continue;
        const head = `- ${shortHandle(i.id)} ${clip(i.title, 120)}`;
        if (i.kind === "done") {
          const files = i.filesTouched.length
            ? ` Files: ${i.filesTouched.slice(0, 5).join(", ")}${i.filesTouched.length > 5 ? ` (+${i.filesTouched.length - 5})` : ""}.`
            : "";
          const note = i.releaseNote ? ` Release note: ${sentence(clip(i.releaseNote, 200))}` : "";
          out.push(`${head} (${isoDay(i.at)}): ${sentence(clip(i.summary, 300))}${note}${files}`);
        } else if (i.kind === "feature") {
          out.push(`${head}: ${FEATURE_WORDS[i.status]} (${isoDay(i.at)})`);
        } else if (i.kind === "note") {
          out.push(`${head} (${i.edited ? "edited" : "new"}, ${isoDay(i.at)})`);
        } else {
          out.push(`${head} (${isoDay(i.at)})`);
        }
      }
    }
  }
  if (shown > MAX_LINES) out.push(`- … ${shown - MAX_LINES} more; narrow the window or filter.`);
  if (c.items.length === 0) out.push("", "Nothing changed.");
  if (c.blocked.length > 0) {
    out.push("", `## Blocked now (${c.blocked.length})`);
    for (const t of c.blocked.slice(0, 20))
      out.push(`- ${shortHandle(t.id)} ${clip(t.title, 120)}`);
  }
  if (c.overdue.length > 0) {
    out.push("", `## Overdue (${c.overdue.length})`);
    for (const t of c.overdue.slice(0, 20)) {
      out.push(`- ${shortHandle(t.id)} ${clip(t.title, 120)} (due ${t.dueDate})`);
    }
  }
  return `${out.join("\n")}\n`;
}

/** Which changelog heading a change goes under, or `null` to leave it out. */
function heading(i: ChangeItem): "Added" | "Changed" | "Fixed" | "Removed" | null {
  if (i.kind === "feature") {
    if (i.status === "shipped") return "Added";
    if (i.status === "removed") return "Removed";
    return i.status === "deprecated" ? "Changed" : null;
  }
  if (i.kind !== "done") return null;
  const labels = i.labels.map((l) => l.toLowerCase());
  if (labels.some((l) => FIXED.has(l))) return "Fixed";
  if (labels.some((l) => REMOVED.has(l))) return "Removed";
  if (labels.some((l) => ADDED.has(l))) return "Added";
  return "Changed";
}

function changelog(c: Changes): string {
  const title = c.milestone?.title ?? `Changes since ${isoDay(c.since)}`;
  const out = [`## ${clip(title, 120)}`];
  const sections = { Added: [], Changed: [], Fixed: [], Removed: [] } as Record<
    "Added" | "Changed" | "Fixed" | "Removed",
    string[]
  >;
  // Oldest first reads like a story; the same line twice (a feature and its task) shows once.
  for (const i of [...c.items].reverse().filter(isPublic)) {
    const h = heading(i);
    if (!h) continue;
    const line =
      i.kind === "done"
        ? `- ${clip(i.releaseNote ?? i.summary, 300)}`
        : i.kind === "feature" && i.status === "deprecated"
          ? `- ${clip(i.title, 200)} is deprecated`
          : `- ${clip(i.title, 200)}`;
    if (!sections[h].includes(line)) sections[h].push(line);
  }
  let empty = true;
  for (const [h, lines] of Object.entries(sections)) {
    if (lines.length === 0) continue;
    empty = false;
    out.push("", `### ${h}`, ...lines.slice(0, MAX_LINES));
  }
  if (empty) out.push("", "No user-facing changes.");
  return `${out.join("\n")}\n`;
}

function digest(c: Changes): string {
  const visible = c.items.filter(isPublic);
  const done = visible.filter((i) => i.kind === "done");
  const shipped = visible.filter((i) => i.kind === "feature" && i.status === "shipped");
  const decisions = visible.filter((i) => i.kind === "decision");
  const notes = visible.filter((i) => i.kind === "note");
  const scope = c.milestone ? ` in ${clip(c.milestone.title, 120)}` : "";
  const out = [`${c.project}${scope}: ${c.basis} (since ${isoDay(c.since)})`, ""];
  const counts = [
    `${plural(done.length, "task")} done`,
    plural(decisions.length, "decision"),
    `${plural(notes.length, "note")} new or edited`,
  ];
  out.push(`${counts.join(", ")}.`);
  if (shipped.length > 0) out.push(`Shipped: ${shipped.map((f) => clip(f.title, 80)).join(", ")}.`);
  if (done.length > 0) {
    out.push("", "Done:");
    for (const i of done.slice(0, 5)) {
      if (i.kind === "done") out.push(`- ${clip(i.releaseNote ?? i.title, 140)}`);
    }
    if (done.length > 5) out.push(`- and ${done.length - 5} more`);
  }
  if (decisions.length > 0) {
    out.push("", "Decided:");
    for (const d of decisions.slice(0, 3)) out.push(`- ${clip(d.title, 140)}`);
    if (decisions.length > 3) out.push(`- and ${decisions.length - 3} more`);
  }
  const shared = (t: { labels: string[] }) => !t.labels.includes(INTERNAL_LABEL);
  const blocked = c.blocked.filter(shared);
  const overdue = c.overdue.filter(shared);
  if (blocked.length + overdue.length > 0) {
    const attention = [
      ...overdue.slice(0, 3).map((t) => `- ${clip(t.title, 120)} (overdue since ${t.dueDate})`),
      ...blocked.slice(0, 3).map((t) => `- ${clip(t.title, 120)} (blocked)`),
    ];
    out.push(
      "",
      `Needs attention: ${plural(blocked.length, "blocked task")}, ${overdue.length} overdue.`,
      ...attention,
    );
  }
  if (c.items.length === 0) out.push("Nothing changed.");
  return `${out.join("\n")}\n`;
}

/** Renders changes as text. Every format prints to stdout; sati writes no user files. */
export function formatChanges(c: Changes, format: ChangeFormat = "plain"): string {
  if (format === "changelog") return changelog(c);
  if (format === "digest") return digest(c);
  return plain(c);
}

/**
 * What the product does today, for READMEs, sales sheets or release pages: shipped features
 * (and deprecated ones, marked) with their acceptance criteria, grouped by milestone.
 */
export async function featureList(ctx: ServiceContext): Promise<string> {
  const { project, features, milestones } = await ctx.store.read(async (r) => ({
    project: await r.getProject(),
    features: (await listAll(r, ctx, "feature")).filter(
      (f) => f.status === "shipped" || f.status === "deprecated",
    ),
    milestones: (await listAll(r, ctx, "milestone")).sort(
      (a, b) => a.order - b.order || a.id.localeCompare(b.id),
    ),
  }));
  const out = [`# ${clip(project?.name ?? "Product", 120)} features`];
  if (features.length === 0) return `${out[0]}\n\nNo shipped features yet.\n`;
  const render = (f: Feature) => {
    const lines = [
      "",
      `### ${clip(f.title, 200)}${f.status === "deprecated" ? " (deprecated)" : ""}`,
    ];
    const intro = f.description.split(/\n\s*\n/u)[0]?.trim();
    if (intro) lines.push("", clip(intro, 600));
    if (f.acceptance.length > 0) lines.push("", ...f.acceptance.map((a) => `- ${clip(a, 300)}`));
    return lines;
  };
  const byTitle = (a: Feature, b: Feature) => a.title.localeCompare(b.title);
  const known = new Set(milestones.map((m) => m.id));
  const grouped = milestones.some((m) => features.some((f) => f.milestoneId === m.id));
  for (const m of milestones) {
    const own = features.filter((f) => f.milestoneId === m.id).sort(byTitle);
    if (own.length === 0) continue;
    out.push("", `## ${clip(m.title, 120)}`);
    for (const f of own) out.push(...render(f));
  }
  const rest = features
    .filter((f) => f.milestoneId === null || !known.has(f.milestoneId))
    .sort(byTitle);
  if (rest.length > 0 && grouped) out.push("", "## Other features");
  for (const f of rest) out.push(...render(f));
  return `${out.join("\n")}\n`;
}
