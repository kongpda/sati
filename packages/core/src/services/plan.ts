import { createHash } from "node:crypto";
import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { LIMITS } from "../domain/schemas.js";
import { CLI_NAME } from "../name.js";
import type { StorageReader, StorageWriter } from "../ports/storage.js";
import { listAll, parseInput, type ServiceContext } from "./context.js";
import { createMilestoneIn } from "./milestone.js";
import { createTaskIn } from "./task.js";

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

/** Most tasks and milestones one import may add, so a pasted file cannot flood the project. */
export const PLAN_MAX_TASKS = 500;
export const PLAN_MAX_MILESTONES = 100;

interface Item {
  heading: string;
  line: number;
  title: string;
  key: string;
}

/** One milestone per heading, one task per unchecked box in it. The key is heading plus item text. */
export function parsePlan(markdown: string): Item[] {
  const items: Item[] = [];
  let heading = "Imported";
  // The open code fence (its character and length), if any: lines inside are examples, not plan.
  let fence: { char: string; length: number } | undefined;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const marker = /^(`{3,}|~{3,})/.exec(line.trim())?.[1];
    if (marker) {
      const char = marker[0] as string;
      if (!fence) fence = { char, length: marker.length };
      else if (char === fence.char && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const head = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (head?.[2]) {
      heading = head[2].trim();
      continue;
    }
    const box = /^[-*]\s+\[\s\]\s+(.+)$/.exec(line.trim());
    if (!box?.[1]) continue;
    const title = box[1].trim();
    const key = createHash("sha256").update(`${heading}\n${title}`).digest("hex").slice(0, 16);
    items.push({ heading, line: index + 1, title, key });
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
  // Checked before any read or write, so a dry run reports the same refusal as a real import.
  const long = items.find((i) => i.title.length > LIMITS.title);
  if (long) {
    throw new SatiError(
      "VALIDATION",
      `Line ${long.line}: the task title is ${long.title.length} characters; the limit is ${LIMITS.title}.`,
      { hint: "Shorten that checkbox line and import again." },
    );
  }
  const headingCount = new Set(items.map((i) => i.heading)).size;
  if (items.length > PLAN_MAX_TASKS || headingCount > PLAN_MAX_MILESTONES) {
    throw new SatiError(
      "VALIDATION",
      `This plan has ${items.length} tasks under ${headingCount} headings; one import takes at most ${PLAN_MAX_TASKS} tasks and ${PLAN_MAX_MILESTONES} milestones.`,
      { hint: `Split the file and run \`${CLI_NAME} plan import\` on each part.` },
    );
  }
  // Everything is parsed above, before the first write. The whole import is one transaction, so a
  // failure part-way leaves nothing behind. Deleted records count as existing, so a task someone
  // deleted is not silently re-created.
  const run = async (w: StorageReader | StorageWriter, write: StorageWriter | undefined) => {
    const existing = {
      milestones: await listAll(w, ctx, "milestone", { includeDeleted: true }),
      // Only the tasks this plan may already have made, found in SQL rather than by reading every
      // task inside the write lock (review WP3.2).
      tasks: await listAll(w, ctx, "task", {
        includeDeleted: true,
        anyLabel: items.map((i) => `plan:${i.key}`),
      }),
    };
    const result: PlanImport = { added: [], skipped: [] };
    // Live milestones only: a task must not land in a deleted one.
    const milestoneIds = new Map(
      existing.milestones.filter((m) => m.deletedAt === null).map((m) => [m.title, m.id]),
    );
    const milestoneTitles = new Set(existing.milestones.map((m) => m.title));
    const taskKeys = new Set(
      existing.tasks.flatMap((t) => t.labels.filter((l) => l.startsWith("plan:"))),
    );
    // Computed once; each created milestone takes the next order (see createMilestoneIn).
    let nextOrder =
      existing.milestones
        .filter((m) => m.deletedAt === null)
        .reduce((max, m) => Math.max(max, m.order), -1) + 1;
    const headings = [...new Set(items.map((i) => i.heading))];
    for (const title of headings) {
      const key = `plan:${createHash("sha256").update(title).digest("hex").slice(0, 16)}`;
      if (milestoneTitles.has(title)) {
        result.skipped.push({ kind: "milestone", title, key });
        continue;
      }
      result.added.push({ kind: "milestone", title, key });
      if (write)
        milestoneIds.set(
          title,
          (await createMilestoneIn(write, ctx, { title, goal: "", order: nextOrder++ })).id,
        );
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
      const milestoneId = milestoneIds.get(item.heading);
      if (write) {
        await createTaskIn(write, ctx, {
          title: item.title,
          labels: [label],
          ...(milestoneId ? { milestoneId } : {}),
        });
      }
    }
    return result;
  };
  return dryRun ? ctx.store.read((r) => run(r, undefined)) : ctx.store.write((w) => run(w, w));
}
