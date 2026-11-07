import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { findDependencyCycle, PRIORITY_RANK } from "../domain/rules.js";
import { type Claim, Completion, LIMITS, type Task, TaskShape } from "../domain/schemas.js";
import { TASK_TRANSITIONS } from "../domain/status.js";
import { CLI_NAME } from "../name.js";
import type { StorageReader, StorageWriter } from "../ports/storage.js";
import {
  assertTransition,
  baseFields,
  ExpectedVersion,
  insertWithLog,
  listAll,
  mustGet,
  nowIso,
  parseInput,
  type ServiceContext,
  updateWithLog,
} from "./context.js";
import { releaseTaskLocks } from "./lock.js";
import { readSettings } from "./project.js";
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

const Subtask = z.strictObject({
  title: z.string().trim().min(1).max(LIMITS.title),
  body: z.string().max(LIMITS.body).optional(),
  /** Indexes into this same `subtasks` array. Resolved to ids in the one write. */
  dependsOn: z.array(z.number().int().nonnegative()).max(LIMITS.array).optional(),
});

/** New tasks start in `backlog` or `todo`; later states need the update and complete flows. */
export const CreateTaskInput = fields.partial(optional).extend({
  status: z.enum(["backlog", "todo"]).optional(),
  subtasks: z.array(Subtask).max(LIMITS.array).optional(),
});
/** The fencing token from `claimTask`. Required while the task is claimed. */
const ClaimToken = { token: z.number().int().positive().optional() };
export const UpdateTaskInput = fields
  .partial()
  .extend(ExpectedVersion)
  .extend(ClaimToken)
  .extend({
    /** Clear `needsReview` after a person has looked at the merge. */
    reviewed: z.literal(true).optional(),
    /** Required when sending a review task back to todo. Shown to the next claimer. */
    reason: z.string().trim().min(1).max(LIMITS.shortText).optional(),
  });
export const CompleteTaskInput = Completion.pick({ summary: true, filesTouched: true })
  .extend(ExpectedVersion)
  .extend(ClaimToken);
export const ClaimTaskInput = z.strictObject({
  leaseMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
});
export const ReleaseTaskInput = z.strictObject({
  /** Release another actor's live claim. Only a person may; the release is logged. */
  force: z.boolean().optional(),
});
export const ListTasksInput = listInput("task").extend({ ready: z.boolean().optional() });
export type CreateTaskInput = z.input<typeof CreateTaskInput>;
export type UpdateTaskInput = z.input<typeof UpdateTaskInput>;
export type CompleteTaskInput = z.input<typeof CompleteTaskInput>;
export type ListTasksInput = z.input<typeof ListTasksInput>;
export type ClaimTaskInput = z.input<typeof ClaimTaskInput>;
export type ReleaseTaskInput = z.input<typeof ReleaseTaskInput>;

/** Statuses that put a task back in the pool, so moving there drops the claim. */
const UNCLAIMED_STATUSES: readonly string[] = ["backlog", "todo", "cancelled"];

export async function createTask(ctx: ServiceContext, input: unknown): Promise<Task> {
  const data = parseInput(CreateTaskInput, input);
  return ctx.store.write((w) => createTaskIn(w, ctx, data));
}

/** `createTask` inside a caller's transaction, for services that write several records at once. */
export async function createTaskIn(
  w: StorageWriter,
  ctx: ServiceContext,
  parsed: z.output<typeof CreateTaskInput>,
): Promise<Task> {
  const { subtasks = [], ...data } = parsed;
  {
    const base = baseFields(ctx, "task");
    await checkLinks(w, ctx, base.id, data);
    const parent = await insertWithLog(w, ctx, "task", {
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
    const childIds = subtasks.map(() => ctx.ids("task"));
    for (const [index, sub] of subtasks.entries()) {
      const deps = sub.dependsOn ?? [];
      if (deps.some((n) => n >= subtasks.length || childIds[n] === undefined)) {
        throw new SatiError("VALIDATION", `Subtask ${index} depends on a missing index.`, {
          details: { index, dependsOn: deps },
        });
      }
    }
    // Subtask edges are indexes; cycles (and self-dependency) among them would never become ready.
    const edges = (key: string) => subtasks[Number(key)]?.dependsOn?.map(String);
    for (const [index, sub] of subtasks.entries()) {
      const cycle = findDependencyCycle(String(index), (sub.dependsOn ?? []).map(String), edges);
      if (cycle) {
        throw new SatiError("VALIDATION", `Subtask dependency cycle: ${cycle.join(" -> ")}.`, {
          details: { cycle },
        });
      }
    }
    for (const [index, sub] of subtasks.entries()) {
      const id = childIds[index];
      if (!id) continue;
      await insertWithLog(w, ctx, "task", {
        ...baseFields(ctx, "task"),
        id,
        title: sub.title,
        body: sub.body ?? "",
        status: "todo",
        priority: "medium",
        featureId: parent.featureId,
        parentId: parent.id,
        dependsOn: (sub.dependsOn ?? []).map((n) => childIds[n] ?? ""),
        labels: [],
        branch: null,
        worktree: null,
        claim: null,
        completion: null,
      });
    }
    return parent;
  }
}

/** Edits a task. Use `completeTask` to reach `done`; reopening a done task clears its completion. */
export async function updateTask(ctx: ServiceContext, id: string, input: unknown): Promise<Task> {
  const { expectedVersion, token, reviewed, reason, ...patch } = parseInput(UpdateTaskInput, input);
  return ctx.store.write(async (w) => {
    const before = await mustGet(w, ctx, "task", id);
    checkToken(before, token, ctx.actorId);
    await checkLinks(w, ctx, id, patch);
    const settings = readSettings((await w.getProject())?.settings);
    let completion = before.completion;
    let reviewNote = before.reviewNote;
    if (patch.status && patch.status !== before.status) {
      if (patch.status === "done") {
        if (before.status !== "review" || completion === null) {
          throw new SatiError("INVALID_TRANSITION", "Use complete to mark a task done.", {
            hint: `Run \`${CLI_NAME} task complete ${id} --summary … --files …\`.`,
          });
        }
        const actor = await w.get("actor", ctx.actorId);
        if (settings.review !== "none" && actor?.kind !== "human") {
          throw new SatiError("INVALID_TRANSITION", "Only a person can approve a task in review.", {
            hint: `A person runs \`${CLI_NAME} task update ${id} --status done\`, or turn the gate off with \`${CLI_NAME} settings --review none\`.`,
          });
        }
        reviewNote = null;
      }
      assertTransition(TASK_TRANSITIONS, "task", before.status, patch.status);
      if (before.status === "done") completion = null;
      if (patch.status === "todo" && before.status === "review") {
        if (!reason) {
          throw new SatiError("VALIDATION", "Sending a task back needs a reason.", {
            hint: `Run \`${CLI_NAME} task update ${id} --status todo --reason "what to change"\`.`,
          });
        }
        reviewNote = reason;
      }
    }
    let claim = before.claim;
    if (patch.status && UNCLAIMED_STATUSES.includes(patch.status)) claim = null;
    else if (claim?.actorId === ctx.actorId)
      claim = { ...(await lease(w, ctx)), token: claim.token };
    return updateWithLog(
      w,
      ctx,
      "task",
      before,
      { ...patch, completion, claim, reviewNote },
      { expectedVersion, clear: reviewed ? ["needsReview"] : [] },
    );
  });
}

/** Marks a task done with a summary and the files touched, and releases its claim and locks. */
export async function completeTask(ctx: ServiceContext, id: string, input: unknown): Promise<Task> {
  const { expectedVersion, token, ...data } = parseInput(CompleteTaskInput, input);
  return ctx.store.write(async (w) => {
    const before = await mustGet(w, ctx, "task", id);
    checkToken(before, token, ctx.actorId);
    const actor = await w.get("actor", ctx.actorId);
    const settings = readSettings((await w.getProject())?.settings);
    const gated =
      settings.review === "all" || (settings.review === "agents" && actor?.kind !== "human");
    if (gated && before.status === "review") {
      throw new SatiError("INVALID_TRANSITION", `Task ${id} is waiting for review.`, {
        hint: "A person moves it to done, or back to todo with a reason.",
      });
    }
    const status = gated ? "review" : "done";
    assertTransition(TASK_TRANSITIONS, "task", before.status, status);
    const completion = { ...data, completedAt: nowIso(ctx), completedBy: ctx.actorId };
    await releaseTaskLocks(w, ctx, id);
    return updateWithLog(
      w,
      ctx,
      "task",
      before,
      { status, completion, claim: null },
      { verb: "complete", expectedVersion },
    );
  });
}

/**
 * Claims a task for the calling actor and moves it to `in_progress`. The check and the write run
 * in one write transaction, so two agents can never both hold the same task. Fails with CONFLICT,
 * naming the holder, while another actor's lease is live. Claiming again renews the lease.
 * Every claim returns a new fencing token in `claim.token`; later writes must present it.
 */
async function applyClaim(
  w: StorageWriter,
  ctx: ServiceContext,
  before: Task,
  leaseMinutes: number | undefined,
): Promise<Task> {
  const held = before.claim;
  if (held && held.actorId !== ctx.actorId && held.leaseUntil > nowIso(ctx)) {
    const holder = await w.get("actor", held.actorId);
    const name = holder?.name ?? held.actorId;
    throw new SatiError(
      "CONFLICT",
      `Task ${before.id} is claimed by ${name} until ${held.leaseUntil}.`,
      {
        hint: `Pick another ready task with \`${CLI_NAME} task list --ready\`.`,
        details: { holder: held.actorId, holderName: name, leaseUntil: held.leaseUntil },
      },
    );
  }
  if (before.status !== "todo" && before.status !== "in_progress") {
    throw new SatiError(
      "INVALID_TRANSITION",
      `Only todo tasks can be claimed; ${before.id} is ${before.status}.`,
      { details: { from: before.status } },
    );
  }
  const claim = { ...(await lease(w, ctx, leaseMinutes)), token: before.version + 1 };
  return updateWithLog(w, ctx, "task", before, { status: "in_progress", claim }, { verb: "claim" });
}

export async function claimTask(
  ctx: ServiceContext,
  id: string,
  input: unknown = {},
): Promise<Task> {
  const { leaseMinutes } = parseInput(ClaimTaskInput, input);
  return ctx.store.write(async (w) =>
    applyClaim(w, ctx, await mustGet(w, ctx, "task", id), leaseMinutes),
  );
}

/**
 * Drops a task's claim inside `w`: an `in_progress` task goes back to `todo`, other statuses stay,
 * and the holder's locks for the task are released. The holder may always release; anyone may
 * release an expired claim; another actor's live claim needs `force`, which only a person may use,
 * so agents cannot take work from each other. The new version invalidates the old fencing token.
 */
async function applyRelease(
  w: StorageWriter,
  ctx: ServiceContext,
  before: Task,
  force: boolean,
): Promise<Task> {
  const held = before.claim;
  if (!held) {
    throw new SatiError("VALIDATION", `Task ${before.id} is not claimed.`, {
      hint: `Claim it with \`${CLI_NAME} task claim ${before.id}\`.`,
    });
  }
  const live = held.leaseUntil > nowIso(ctx);
  if (held.actorId !== ctx.actorId && live) {
    const holder = await w.get("actor", held.actorId);
    const name = holder?.name ?? held.actorId;
    const details = { holder: held.actorId, holderName: name, leaseUntil: held.leaseUntil };
    if (!force) {
      throw new SatiError("CONFLICT", `Task ${before.id} is claimed by ${name}.`, {
        hint: "Only the holder releases a live claim. A person can override with --force; it is logged.",
        details,
      });
    }
    if ((await w.get("actor", ctx.actorId))?.kind !== "human") {
      throw new SatiError("CONFLICT", `Only a person can take task ${before.id} from ${name}.`, {
        hint: `Pick another ready task with \`${CLI_NAME} task list --ready\`.`,
        details,
      });
    }
  }
  await releaseTaskLocks(w, ctx, before.id, held.actorId);
  const status = before.status === "in_progress" ? "todo" : before.status;
  return updateWithLog(w, ctx, "task", before, { status, claim: null }, { verb: "release" });
}

/** Releases a task's claim; see `applyRelease` for who may. */
export async function releaseTask(
  ctx: ServiceContext,
  id: string,
  input: unknown = {},
): Promise<Task> {
  const { force } = parseInput(ReleaseTaskInput, input);
  return ctx.store.write(async (w) =>
    applyRelease(w, ctx, await mustGet(w, ctx, "task", id), force ?? false),
  );
}

/**
 * A person takes a task over in one transaction: the current claim is released (forced and
 * logged when it is someone else's and still live), then the caller claims it with a new token,
 * so the previous holder's next write is refused.
 */
export async function takeOverTask(
  ctx: ServiceContext,
  id: string,
  input: unknown = {},
): Promise<Task> {
  const { leaseMinutes } = parseInput(ClaimTaskInput, input);
  return ctx.store.write(async (w) => {
    let task = await mustGet(w, ctx, "task", id);
    if (task.claim && task.claim.actorId !== ctx.actorId) {
      task = await applyRelease(w, ctx, task, true);
    }
    return applyClaim(w, ctx, task, leaseMinutes);
  });
}

/**
 * Claims the top ready task in the same transaction that picks it: highest priority, then
 * oldest id. Two callers queue on the store, so they cannot receive the same task.
 */
export async function claimNext(
  ctx: ServiceContext,
  input: unknown = {},
): Promise<{ task: Task; acceptance: string[] }> {
  const { leaseMinutes } = parseInput(ClaimTaskInput, input);
  return ctx.store.write(async (w) => {
    const ready = await w.readyTasks(ctx.projectId, nowIso(ctx), 500);
    ready.sort(
      (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.id < b.id ? -1 : 1),
    );
    const top = ready[0];
    if (!top) {
      throw new SatiError("NOT_FOUND", "No ready task.", {
        hint: `Create one with \`${CLI_NAME} task create\`, or see \`${CLI_NAME} task list\`.`,
      });
    }
    const task = await applyClaim(w, ctx, top, leaseMinutes);
    const feature = task.featureId ? await w.get("feature", task.featureId) : undefined;
    return { task, acceptance: feature?.deletedAt ? [] : (feature?.acceptance ?? []) };
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

/**
 * Fencing: while a task is claimed, a write must present the claim's token, and come from the
 * actor that holds the claim. A token from a claim that was lost (expired, released, or taken by
 * another agent) no longer matches, so a paused agent that wakes up late cannot overwrite the new
 * holder's work; and a token read from `task show` does not let anyone else write either.
 * The holder may still write after its lease ran out while nobody else has claimed the task.
 */
function checkToken(task: Task, token: number | undefined, actorId: string): void {
  const current = task.claim?.token;
  if (token === undefined && current === undefined) return;
  if (token === current && task.claim?.actorId === actorId) return;
  const details = { token: token ?? null, holder: task.claim?.actorId ?? null };
  if (token !== undefined && token === current) {
    throw new SatiError("CONFLICT", `Task ${task.id} is claimed by another actor.`, {
      hint: `Only the holder writes with its token. A person can run \`${CLI_NAME} task take-over ${task.id}\`.`,
      details,
    });
  }
  const hint =
    token === undefined
      ? `Claim it with \`${CLI_NAME} task claim ${task.id}\` and pass the token it returns.`
      : `Your claim was lost. Run \`${CLI_NAME} task show ${task.id}\` before changing anything.`;
  throw new SatiError(
    "CONFLICT",
    token === undefined
      ? `Task ${task.id} is claimed; this write needs the claim's fencing token.`
      : `Fencing token ${token} is stale for task ${task.id}.`,
    { hint, details },
  );
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

/**
 * Lists tasks; `ready: true` returns todo, unclaimed tasks whose dependencies are done.
 * The store's ready query takes no filters, so the filters and paging apply here to up to 500
 * ready tasks. `includeDeleted` has no effect on ready tasks: a deleted task is never ready.
 */
export async function listTasks(ctx: ServiceContext, input: unknown = {}): Promise<Task[]> {
  const { ready, ...query } = parseInput(ListTasksInput, input);
  if (!ready) return ctx.store.read((r) => r.list("task", ctx.projectId, query));
  const { status, featureId, milestoneId, parentId, label } = query;
  const { all, inMilestone } = await ctx.store.read(async (r) => {
    const tasks = await r.readyTasks(ctx.projectId, nowIso(ctx), 500);
    // Tasks have no milestone of their own; they belong to their feature's milestone.
    const ids = new Set<string>();
    if (milestoneId) {
      for (const f of await listAll(r, ctx, "feature"))
        if (f.milestoneId === milestoneId) ids.add(f.id);
    }
    return { all: tasks, inMilestone: ids };
  });
  const start = query.offset ?? 0;
  return all
    .filter(
      (t) =>
        (!status || status.includes(t.status)) &&
        (!featureId || t.featureId === featureId) &&
        (!milestoneId || (t.featureId !== null && inMilestone.has(t.featureId))) &&
        (!parentId || t.parentId === parentId) &&
        (!label || t.labels.includes(label)),
    )
    .slice(start, start + (query.limit ?? 50));
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
      throw new SatiError("VALIDATION", `Dependency cycle: ${cycle.join(" -> ")}.`, {
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
      throw new SatiError("VALIDATION", `Task ${taskId} cannot be its own ancestor.`);
    }
    seen.add(current);
    current = (await mustGet(r, ctx, "task", current)).parentId;
  }
}
