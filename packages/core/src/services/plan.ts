import { createHash } from "node:crypto";
import { z } from "zod";
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
  // Everything is parsed above, before the first write. The whole import is one transaction, so a
  // failure part-way leaves nothing behind. Deleted records count as existing, so a task someone
  // deleted is not silently re-created.
  const run = async (w: StorageReader | StorageWriter, write: StorageWriter | undefined) => {
    const existing = {
      milestones: await listAll(w, ctx, "milestone", { includeDeleted: true }),
      tasks: await listAll(w, ctx, "task", { includeDeleted: true }),
    };
    const result: PlanImport = { added: [], skipped: [] };
    const milestoneTitles = new Set(existing.milestones.map((m) => m.title));
    const taskKeys = new Set(
      existing.tasks.flatMap((t) => t.labels.filter((l) => l.startsWith("plan:"))),
    );
    const headings = [...new Set(items.map((i) => i.heading))];
    for (const title of headings) {
      const key = `plan:${createHash("sha256").update(title).digest("hex").slice(0, 16)}`;
      if (milestoneTitles.has(title)) {
        result.skipped.push({ kind: "milestone", title, key });
        continue;
      }
      result.added.push({ kind: "milestone", title, key });
      if (write) await createMilestoneIn(write, ctx, { title, goal: "" });
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
      if (write) await createTaskIn(write, ctx, { title: item.title, labels: [label] });
    }
    return result;
  };
  return dryRun ? ctx.store.read((r) => run(r, undefined)) : ctx.store.write((w) => run(w, w));
}
