import { z } from "zod";
import { shortHandle } from "../domain/ids.js";
import type { Feature, Task } from "../domain/schemas.js";
import { CLI_NAME } from "../name.js";
import { actorName, nowIso, parseInput, type ServiceContext } from "./context.js";
import { getContext } from "./context-cache.js";
import { releaseExpiredClaims } from "./task.js";

/** PLAN: the brief stays under 1,500 tokens so it is cheap to inject at every session start. */
export const BRIEF_TOKEN_CAP = 1_500;
const DAY_MS = 24 * 60 * 60 * 1000;
const LINE_CHARS = 160;
/** No section shows more lines than this, which also bounds the work in `fit`. */
const SECTION_LINES = 40;

export const BriefInput = z.strictObject({
  /** `short` is for resumed or compacted sessions: your tasks and the top 3 ready tasks. */
  format: z.enum(["agent", "short"]).optional(),
  maxTokens: z.number().int().min(200).max(BRIEF_TOKEN_CAP).optional(),
});
export type BriefInput = z.input<typeof BriefInput>;

export interface Brief {
  markdown: string;
  /** Estimated as characters / 4, which overestimates for English Markdown. */
  tokens: number;
  /** Lines left out to stay under the cap. */
  omitted: number;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const clip = (s: string, max = LINE_CHARS): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

interface Section {
  title: string;
  /** Shown when the section has no items, or `null` to hide an empty section. */
  empty: string | null;
  items: string[];
}

/**
 * The session-start brief: who I am, my claimed tasks with their acceptance criteria, ready
 * tasks, paths other agents have locked, recent decisions, stale context entries and protected features. Every line carries an id so the agent can
 * fetch more. Lower sections lose items first when the text would exceed the token cap.
 */
export async function buildBrief(ctx: ServiceContext, input: unknown = {}): Promise<Brief> {
  const { format = "agent", maxTokens = BRIEF_TOKEN_CAP } = parseInput(BriefInput, input);
  const short = format === "short";
  const now = nowIso(ctx);
  const since = new Date(ctx.clock.now().getTime() - 7 * DAY_MS).toISOString();
  // "Every brief clears expired leases" (PLAN), so abandoned tasks show up as ready again.
  await releaseExpiredClaims(ctx);

  const data = await ctx.store.read(async (r) => {
    const project = await r.getProject();
    const actor = await r.get("actor", ctx.actorId);
    const active = await r.list("task", ctx.projectId, {
      status: ["in_progress", "review", "blocked"],
      limit: 500,
    });
    const mine = active.filter((t) => t.claim?.actorId === ctx.actorId && t.claim.leaseUntil > now);
    const ready = await r.readyTasks(ctx.projectId, now, short ? 3 : 5);
    const featureIds = [...new Set(mine.map((t) => t.featureId).filter((id) => id !== null))];
    const features = new Map<string, Feature>();
    for (const id of featureIds) {
      const f = await r.get("feature", id);
      if (f && f.deletedAt === null) features.set(id, f);
    }
    const decisions = short
      ? []
      : (await r.list("decision", ctx.projectId, { newestFirst: true, limit: 20 })).filter(
          (d) => d.createdAt >= since,
        );
    const allFeatures = short ? [] : await r.list("feature", ctx.projectId, { limit: 500 });
    const guarded = allFeatures.filter((f) => f.protected && f.status !== "removed");
    // Features tied to my tasks come first: those are the ones I am most likely to touch.
    guarded.sort((a, b) => Number(features.has(b.id)) - Number(features.has(a.id)));
    const locks = short
      ? []
      : (await r.list("lock", ctx.projectId, { limit: 500 })).filter(
          (l) => l.actorId !== ctx.actorId && l.leaseUntil > now,
        );
    const held = [];
    for (const l of locks) held.push({ ...l, holder: await actorName(r, l.actorId) });
    return { project, actor, mine, ready, features, decisions, guarded, locks: held };
  });

  // Read after the DB snapshot: staleness needs the git index, which is outside the store.
  const stale = short ? [] : (await getContext(ctx)).filter((e) => e.stale === true);

  const name = data.project?.name ?? "this project";
  const who = data.actor ? `${data.actor.name} (${shortHandle(data.actor.id)})` : ctx.actorId;
  const header = [
    `# ${CLI_NAME} brief: ${clip(name, 80)}`,
    `${data.project?.mode ?? "git"} mode. You are ${who}. Workflow: ${CLI_NAME}://workflow.`,
  ];

  const taskLine = (t: Task, extra = "") =>
    `- ${shortHandle(t.id)} [${t.status === "todo" ? "" : `${t.status}, `}${t.priority}] ${clip(t.title)}${extra}`;

  const mine: string[] = [];
  for (const t of data.mine) {
    mine.push(taskLine(t, ` (lease until ${t.claim?.leaseUntil.slice(11, 16)}Z)`));
    const f = t.featureId ? data.features.get(t.featureId) : undefined;
    if (f && f.acceptance.length > 0) {
      mine.push(`  Acceptance (${shortHandle(f.id)} ${clip(f.title, 60)}):`);
      for (const a of f.acceptance) mine.push(`  - ${clip(a)}`);
    }
  }

  const sections: Section[] = [
    {
      title: "Your tasks",
      empty: "None claimed. Pick a ready task and call task_claim.",
      items: mine,
    },
    {
      title: short ? "Ready (top 3)" : "Ready (top 5)",
      empty: "No ready tasks.",
      items: data.ready.map((t) => taskLine(t)),
    },
    {
      title: "Locked by other agents",
      empty: null,
      items: data.locks.map((l) => {
        const until = l.leaseUntil.slice(11, 16);
        return `- ${shortHandle(l.id)} ${l.mode} ${clip(l.paths.join(", "), 80)} by ${clip(l.holder, 60)} until ${until}Z`;
      }),
    },
    {
      title: "Decisions, last 7 days",
      empty: null,
      items: data.decisions.map(
        (d) => `- ${shortHandle(d.id)} ${clip(d.title)} (${d.createdAt.slice(0, 10)})`,
      ),
    },
    {
      title: "Stale context (files changed since summary; re-read, then context_put)",
      empty: null,
      items: stale.map((e) => `- ${shortHandle(e.id)} ${clip(e.path, 80)}: ${clip(e.summary, 80)}`),
    },
    {
      title: "Protected features",
      empty: null,
      items: data.guarded.map((f) => {
        const paths = f.paths.length > 0 ? `: ${clip(f.paths.join(", "), 80)}` : "";
        return `- ${shortHandle(f.id)} ${clip(f.title, 80)} (${f.status})${paths}`;
      }),
    },
  ];
  return fit(header, sections, maxTokens);
}

/** Renders the sections, dropping items from the bottom section up until the text fits. */
function fit(header: string[], sections: Section[], maxTokens: number): Brief {
  const dropped = sections.map((s) => Math.max(0, s.items.length - SECTION_LINES));
  const render = (): string => {
    const out = [...header];
    sections.forEach((s, i) => {
      const cut = dropped[i] ?? 0;
      const items = s.items.slice(0, s.items.length - cut);
      if (items.length === 0 && cut === 0 && s.empty === null) return;
      out.push("", `## ${s.title}`);
      out.push(...(items.length > 0 ? items : cut === 0 && s.empty ? [s.empty] : []));
      if (cut > 0) out.push(`- … ${cut} more left out to keep this brief short.`);
    });
    return `${out.join("\n")}\n`;
  };
  let text = render();
  for (let i = sections.length - 1; i >= 0 && estimateTokens(text) > maxTokens; i--) {
    const section = sections[i];
    if (!section) continue;
    while ((dropped[i] ?? 0) < section.items.length && estimateTokens(text) > maxTokens) {
      dropped[i] = (dropped[i] ?? 0) + 1;
      text = render();
    }
  }
  const omitted = dropped.reduce((a, b) => a + b, 0);
  return { markdown: text, tokens: estimateTokens(text), omitted };
}
