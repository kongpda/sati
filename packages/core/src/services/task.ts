import { z } from "zod";
import { BrainError } from "../domain/errors.js";
import { findDependencyCycle } from "../domain/rules.js";
import { type Claim, Completion, type Task, TaskShape } from "../domain/schemas.js";
import { TASK_TRANSITIONS } from "../domain/status.js";
import type { StorageReader } from "../ports/storage.js";
import {
  assertTransition,
  baseFields,
  ExpectedVersion,
  insertWithLog,
  mustGet,
  nowIso,
  parseInput,
  type ServiceContext,
  updateWithLog,
} from "./context.js";
import { listInput } from "./query.js";

const fields = TaskShape.pick({
  title: true,
  body: true,
  status: true,
  priority: true,
  featureId: true,
  parentId: true,
  dependsOn: true,
  labels: true,
  branch: true,
  worktree: true,
});
const optional = {
  body: true,
  status: true,
  priority: true,
  featureId: true,
  parentId: true,
  dependsOn: true,
  labels: true,
  branch: true,
  worktree: true,
} as const;

/** New tasks start in `backlog` or `todo`; later states need the update and complete flows. */
export const CreateTaskInput = fields
  .partial(optional)
  .extend({ status: z.enum(["backlog", "todo"]).optional() });
export const UpdateTaskInput = fields.partial().extend(ExpectedVersion);
export const CompleteTaskInput = Completion.pick({ summary: true, filesTouched: true }).extend(
  ExpectedVersion,
);
export const ClaimTaskInput = z.strictObject({
  leaseMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
});
export const ListTasksInput = listInput("task").extend({ ready: z.boolean().optional() });
export type CreateTaskInput = z.input<typeof CreateTaskInput>;
export type UpdateTaskInput = z.input<typeof UpdateTaskInput>;
export type CompleteTaskInput = z.input<typeof CompleteTaskInput>;
export type ListTasksInput = z.input<typeof ListTasksInput>;
export type ClaimTaskInput = z.input<typeof ClaimTaskInput>;

/** Statuses that put a task back in the pool, so moving there drops the claim. */
const UNCLAIMED_STATUSES: readonly string[] = ["backlog", "todo", "cancelled"];

export async function createTask(ctx: ServiceContext, input: unknown): Promise<Task> {
  const data = parseInput(CreateTaskInput, input);
  return ctx.store.write(async (w) => {
    const base = baseFields(ctx, "task");
    await checkLinks(w, ctx, base.id, data);
    return insertWithLog(w, ctx, "task", {
      ...base,
      body: "",
      status: "todo",
      priority: "medium",
      featureId: null,
      parentId: null,
      dependsOn: [],
      labels: [],
      branch: null,
      worktree: null,
      claim: null,
      completion: null,
      ...data,
    });
  });
}

/** Edits a task. Use `completeTask` to reach `done`; reopening a done task clears its completion. */
export async function updateTask(ctx: ServiceContext, id: string, input: unknown): Promise<Task> {
  const { expectedVersion, ...patch } = parseInput(UpdateTaskInput, input);
  return ctx.store.write(async (w) => {
    const before = await mustGet(w, ctx, "task", id);
    await checkLinks(w, ctx, id, patch);
    let completion = before.completion;
    if (patch.status && patch.status !== before.status) {
      if (patch.status === "done") {
        throw new BrainError("INVALID_TRANSITION", "Use complete to mark a task done.", {
          hint: `Run \`brain task complete ${id} --summary … --files …\`.`,
        });
      }
      assertTransition(TASK_TRANSITIONS, "task", before.status, patch.status);
      if (before.status === "done") completion = null;
    }
    let claim = before.claim;
    if (patch.status && UNCLAIMED_STATUSES.includes(patch.status)) claim = null;
    else if (claim?.actorId === ctx.actorId) claim = await lease(w, ctx);
    return updateWithLog(
      w,
      ctx,
      "task",
      before,
      { ...patch, completion, claim },
      { expectedVersion },
    );
  });
}

/** Marks a task done with a summary and the files touched, and releases its claim. */
export async function completeTask(ctx: ServiceContext, id: string, input: unknown): Promise<Task> {
  const { expectedVersion, ...data } = parseInput(CompleteTaskInput, input);
  return ctx.store.write(async (w) => {
    const before = await mustGet(w, ctx, "task", id);
    assertTransition(TASK_TRANSITIONS, "task", before.status, "done");
    const completion = { ...data, completedAt: nowIso(ctx), completedBy: ctx.actorId };
    return updateWithLog(
      w,
      ctx,
      "task",
      before,
      { status: "done", completion, claim: null },
      { verb: "complete", expectedVersion },
    );
  });
}

/**
 * Claims a task for the calling actor and moves it to `in_progress`. The check and the write run
 * in one write transaction, so two agents can never both hold the same task. Fails with CONFLICT,
 * naming the holder, while another actor's lease is live. Claiming again renews the lease.
 */
export async function claimTask(
  ctx: ServiceContext,
  id: string,
  input: unknown = {},
): Promise<Task> {
  const { leaseMinutes } = parseInput(ClaimTaskInput, input);
  return ctx.store.write(async (w) => {
    const before = await mustGet(w, ctx, "task", id);
    const held = before.claim;
    if (held && held.actorId !== ctx.actorId && held.leaseUntil > nowIso(ctx)) {
      const holder = await w.get("actor", held.actorId);
      const name = holder?.name ?? held.actorId;
      throw new BrainError(
        "CONFLICT",
        `Task ${id} is claimed by ${name} until ${held.leaseUntil}.`,
        {
          hint: "Pick another ready task with `brain task list --ready`.",
          details: { holder: held.actorId, holderName: name, leaseUntil: held.leaseUntil },
        },
      );
    }
    if (before.status !== "todo" && before.status !== "in_progress") {
      throw new BrainError(
        "INVALID_TRANSITION",
        `Only todo tasks can be claimed; ${id} is ${before.status}.`,
        {
          details: { from: before.status },
        },
      );
    }
    const claim = await lease(w, ctx, leaseMinutes);
    return updateWithLog(
      w,
      ctx,
      "task",
      before,
      { status: "in_progress", claim },
      { verb: "claim" },
    );
  });
}

/**
 * Clears claims whose lease has run out, so abandoned work returns to the pool: an
 * `in_progress` task goes back to `todo`; `review` and `blocked` tasks keep their status.
 * Writes only when something expired. Returns the released tasks.
 */
export async function releaseExpiredClaims(ctx: ServiceContext): Promise<Task[]> {
  const now = nowIso(ctx);
  const expired = (t: Task) => t.claim !== null && t.claim.leaseUntil <= now;
  const candidates = await ctx.store.read(async (r) =>
    (
      await r.list("task", ctx.projectId, {
        status: ["in_progress", "review", "blocked"],
        limit: 500,
      })
    ).filter(expired),
  );
  if (candidates.length === 0) return [];
  return ctx.store.write(async (w) => {
    const released: Task[] = [];
    for (const { id } of candidates) {
      // Re-read inside the transaction: the holder may have renewed since the check above.
      const before = await w.get("task", id);
      if (!before || !expired(before)) continue;
      const status = before.status === "in_progress" ? "todo" : before.status;
      released.push(
        await updateWithLog(w, ctx, "task", before, { status, claim: null }, { verb: "release" }),
      );
    }
    return released;
  });
}

/** A fresh lease for the calling actor, defaulting to the project's lease length. */
async function lease(r: StorageReader, ctx: ServiceContext, minutes?: number): Promise<Claim> {
  const now = ctx.clock.now();
  const length = minutes ?? (await r.getProject())?.settings.leaseMinutes ?? 30;
  return {
    actorId: ctx.actorId,
    leaseUntil: new Date(now.getTime() + length * 60_000).toISOString(),
    heartbeatAt: now.toISOString(),
  };
}

/** Lists tasks; `ready: true` returns todo, unclaimed tasks whose dependencies are done. */
export async function listTasks(ctx: ServiceContext, input: unknown = {}): Promise<Task[]> {
  const { ready, ...query } = parseInput(ListTasksInput, input);
  return ctx.store.read((r) =>
    ready
      ? r.readyTasks(ctx.projectId, nowIso(ctx), query.limit ?? 50)
      : r.list("task", ctx.projectId, query),
  );
}

/** Checks that linked feature, parent and dependencies exist and form no cycle. */
async function checkLinks(
  r: StorageReader,
  ctx: ServiceContext,
  taskId: string,
  links: {
    featureId?: string | null | undefined;
    parentId?: string | null | undefined;
    dependsOn?: readonly string[] | undefined;
  },
): Promise<void> {
  if (links.featureId) await mustGet(r, ctx, "feature", links.featureId);
  if (links.parentId) await checkParent(r, ctx, taskId, links.parentId);
  if (links.dependsOn?.length) {
    const graph = new Map<string, readonly string[]>();
    const queue = [...links.dependsOn];
    for (const dep of links.dependsOn) await mustGet(r, ctx, "task", dep);
    while (queue.length > 0) {
      const next = queue.pop();
      if (next === undefined || next === taskId || graph.has(next)) continue;
      const deps = (await r.get("task", next))?.dependsOn ?? [];
      graph.set(next, deps);
      queue.push(...deps);
    }
    const cycle = findDependencyCycle(taskId, links.dependsOn, (id) => graph.get(id));
    if (cycle) {
      throw new BrainError("VALIDATION", `Dependency cycle: ${cycle.join(" -> ")}.`, {
        details: { cycle },
      });
    }
  }
}

async function checkParent(
  r: StorageReader,
  ctx: ServiceContext,
  taskId: string,
  parentId: string,
): Promise<void> {
  let current: string | null = parentId;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    if (current === taskId) {
      throw new BrainError("VALIDATION", `Task ${taskId} cannot be its own ancestor.`);
    }
    seen.add(current);
    current = (await mustGet(r, ctx, "task", current)).parentId;
  }
}
