import { createHash } from "node:crypto";
import { z } from "zod";
import { listAll, parseInput, type ServiceContext } from "./context.js";
import { createMilestone } from "./milestone.js";
import { createTask } from "./task.js";

export const ImportPlanInput = z.strictObject({
  markdown: z.string().max(2_000_000),
  dryRun: z.boolean().optional(),
});

export interface PlanChange {
  kind: "milestone" | "task";
  title: string;
  key: string;
}

export interface PlanImport {
  added: PlanChange[];
  skipped: PlanChange[];
}

interface Item {
  heading: string;
  title: string;
  key: string;
}

/** One milestone per heading, one task per unchecked box. The key is heading plus item text. */
export function parsePlan(markdown: string): Item[] {
  const items: Item[] = [];
  let heading = "Imported";
  for (const line of markdown.split(/\r?\n/)) {
    const head = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (head?.[2]) {
      heading = head[2].trim();
      continue;
    }
    const box = /^[-*]\s+\[\s\]\s+(.+)$/.exec(line.trim());
    if (!box?.[1]) continue;
    const title = box[1].trim();
    const key = createHash("sha256").update(`${heading}\n${title}`).digest("hex").slice(0, 16);
    items.push({ heading, title, key });
  }
  return items;
}

/**
 * Adds milestones and tasks from a Markdown list. Re-running matches the stable key and
 * adds only what is new. It never deletes and never writes the file.
 */
export async function importPlan(ctx: ServiceContext, input: unknown): Promise<PlanImport> {
  const { markdown, dryRun } = parseInput(ImportPlanInput, input);
  const items = parsePlan(markdown);
  const existing = await ctx.store.read(async (r) => ({
    milestones: await listAll(r, ctx, "milestone"),
    tasks: await listAll(r, ctx, "task"),
  }));
  const result: PlanImport = { added: [], skipped: [] };
  const milestoneId = new Map(existing.milestones.map((m) => [m.title, m.id]));
  const taskKeys = new Set(
    existing.tasks.flatMap((t) => t.labels.filter((l) => l.startsWith("plan:"))),
  );
  const headings = [...new Set(items.map((i) => i.heading))];
  for (const title of headings) {
    const key = `plan:${createHash("sha256").update(title).digest("hex").slice(0, 16)}`;
    if (milestoneId.has(title)) {
      result.skipped.push({ kind: "milestone", title, key });
      continue;
    }
    result.added.push({ kind: "milestone", title, key });
    if (!dryRun) {
      const created = await createMilestone(ctx, { title, goal: "" });
      milestoneId.set(title, created.id);
    }
  }
  for (const item of items) {
    const label = `plan:${item.key}`;
    const change = { kind: "task" as const, title: item.title, key: label };
    if (taskKeys.has(label)) {
      result.skipped.push(change);
      continue;
    }
    result.added.push(change);
    taskKeys.add(label);
    if (!dryRun) {
      await createTask(ctx, { title: item.title, labels: [label] });
    }
  }
  return result;
}
