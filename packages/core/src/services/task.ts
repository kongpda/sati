import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { findDependencyCycle, PRIORITY_RANK } from "../domain/rules.js";
import {
  BodyText,
  type Claim,
  CONFIG_DIR,
  CommitSha,
  Completion,
  Effort,
  IsoDay,
  LIMITS,
  type Note,
  type Task,
  TaskShape,
  utf8Bytes,
  WAITING_KINDS,
} from "../domain/schemas.js";
import { refuseSecrets } from "../domain/secrets.js";
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
import { handoffFor, unreadHandoff } from "./handoff.js";
import { releaseTaskLocks, renewTaskLocks } from "./lock.js";
import { DEFAULT_LEASE_MINUTES, readSettings } from "./project.js";
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
  dueDate: true,
  assigneeIds: true,
  checklist: true,
  milestoneId: true,
  effort: true,
}).extend({ body: BodyText });
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
  dueDate: true,
  assigneeIds: true,
  checklist: true,
  milestoneId: true,
  effort: true,
} as const;

const Subtask = z.strictObject({
  title: z.string().trim().min(1).max(LIMITS.title),
  body: BodyText.optional(),
  /** Indexes into this same `subtasks` array. Resolved to ids in the one write. */
  dependsOn: z.array(z.number().int().nonnegative()).max(LIMITS.array).optional(),
});

/** New tasks start in `backlog` or `todo`; later states need the update and complete flows. */
export const CreateTaskInput = fields.partial(optional).extend({
  status: z.enum(["backlog", "todo"]).optional(),
  subtasks: z
    .array(Subtask)
    .max(LIMITS.array)
    // 500 subtasks of 100 KB each would be a 50 MB write; the whole batch stays under 1 MB.
    .refine(
      (subs) =>
        subs.reduce((n, s) => n + utf8Bytes(s.title) + utf8Bytes(s.body ?? ""), 0) <= LIMITS.batch,
      "subtasks are over 1 MB together; split them across several calls",
    )
    .optional(),
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
    /**
     * Required when sending a review task back to todo; shown to the next claimer. With the move
     * to `blocked`, it says what the task waits on.
     */
    reason: z.string().trim().min(1).max(LIMITS.shortText).optional(),
    /** The holder asks a person a question and waits for the answer. Cleared by its next write. */
    needsInput: z.string().trim().min(1).max(LIMITS.waitingText).optional(),
    /**
     * Approving a review: the branch commit the reviewer looked at. Refused when the branch has
     * moved on since, so nobody approves code they did not see.
     */
    approvedCommit: CommitSha.optional(),
  });
export const CompleteTaskInput = Completion.pick({
  summary: true,
  releaseNote: true,
  filesTouched: true,
})
  .partial({ filesTouched: true })
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
export const WaitingInput = z.strictObject({
  /** The task; without it, every task the caller holds. */
  taskId: z.string().trim().min(1).max(60).optional(),
  /** What the holder waits for, or null when the person has answered. */
  waiting: z
    .strictObject({
      kind: z.enum(WAITING_KINDS).default("question"),
      text: z.string().trim().min(1).max(LIMITS.waitingText),
    })
    .nullable(),
});
export type WaitingInput = z.input<typeof WaitingInput>;
export const ReleaseTaskInput = z.strictObject({
  /** Release another actor's live claim. Only a person may; the release is logged. */
  force: z.boolean().optional(),
});
export const ListTasksInput = listInput("task").extend({
  ready: z.boolean().optional(),
  /** Only tasks due on or before this day; tasks without a due date are left out. */
  dueBy: IsoDay.optional(),
  /** Only tasks assigned to this actor. */
  assigneeId: z.string().max(100).optional(),
  /** Only tasks of this effort; a task without one counts as `standard`. */
  effort: Effort.optional(),
});
export type CreateTaskInput = z.input<typeof CreateTaskInput>;
export type UpdateTaskInput = z.input<typeof UpdateTaskInput>;
export type CompleteTaskInput = z.input<typeof CompleteTaskInput>;
export type ListTasksInput = z.input<typeof ListTasksInput>;
export type ClaimTaskInput = z.input<typeof ClaimTaskInput>;

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
  // Here, not in createTask: plan import and templates create tasks through this too.
  refuseSecrets("task", parsed);
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
      effort: null,
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
        ...(parent.milestoneId ? { milestoneId: parent.milestoneId } : {}),
        parentId: parent.id,
        dependsOn: (sub.dependsOn ?? []).map((n) => childIds[n] ?? ""),
        labels: [],
        branch: null,
        worktree: null,
        claim: null,
        completion: null,
        effort: null,
      });
    }
    return parent;
  }
}

/** Edits a task. Use `completeTask` to reach `done`; reopening a done task clears its completion. */
export async function updateTask(ctx: ServiceContext, id: string, input: unknown): Promise<Task> {
  const { expectedVersion, token, reviewed, reason, needsInput, approvedCommit, ...patch } =
    parseInput(UpdateTaskInput, input);
  refuseSecrets("task", { ...patch, reason, needsInput });
  // Git is read outside the transaction: the approval compares with the branch as it is now.
  const approving = patch.status === "done" ? await branchHeadOf(ctx, id) : undefined;
  // Read before the transaction: git is not called while the write lock is held.
  const approvedMoved =
    approvedCommit && approving?.head
      ? await movedBeyondSnapshot(ctx, approvedCommit, approving.head)
      : false;
  return ctx.store.write(async (w) => {
    const before = await mustGet(w, ctx, "task", id);
    checkToken(before, token, ctx.actorId);
    // Only newly added assignees must exist here: actors are not in the snapshot, so a task
    // from a teammate's clone may keep someone this database has never seen.
    const added = patch.assigneeIds?.filter((a) => !before.assigneeIds?.includes(a));
    await checkLinks(w, ctx, id, { ...patch, assigneeIds: added });
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
        const head = approving && approving.branch === completion.branch ? approving.head : null;
        if (approvedCommit && head && approvedMoved) {
          throw new SatiError(
            "CONFLICT",
            `Branch ${completion.branch} moved to ${head.slice(0, 12)} after the commit you approved.`,
            {
              hint: "Look at the new commits, then approve again.",
              details: { approvedCommit, head },
            },
          );
        }
        const approved = approvedCommit ?? head ?? completion.commit;
        if (approved) completion = { ...completion, approvedCommit: approved };
      }
      assertTransition(TASK_TRANSITIONS, "task", before.status, patch.status);
      if (patch.status === "review") {
        throw new SatiError("INVALID_TRANSITION", "Use complete to send a task to review.", {
          hint: `Run \`${CLI_NAME} task complete ${id} --summary … --files …\`.`,
        });
      }
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
    let blockedReason = before.blockedReason;
    if (patch.status === "blocked" && before.status !== "blocked") blockedReason = reason ?? null;
    else if (patch.status && patch.status !== "blocked") blockedReason = null;
    else if (before.status === "blocked" && reason) blockedReason = reason;
    let claim = before.claim;
    if (needsInput && claim?.actorId !== ctx.actorId) {
      throw new SatiError(
        "VALIDATION",
        "Only the agent working on a task can ask for input on it.",
        {
          hint: `Claim it first with \`${CLI_NAME} task claim ${id}\`.`,
        },
      );
    }
    if (patch.status && UNCLAIMED_STATUSES.includes(patch.status)) {
      // The claim ends here, so its locks end too, as on release and complete.
      if (claim) await releaseTaskLocks(w, ctx, before.id, claim.actorId);
      claim = null;
    } else if (claim?.actorId === ctx.actorId) {
      // Any write by the holder renews its lease and means it is no longer waiting, unless this
      // write is the question.
      claim = { ...(await lease(w, ctx, undefined, claim)), token: claim.token };
      await renewTaskLocks(w, ctx, before.id, claim.leaseUntil);
      if (needsInput) claim.waiting = { kind: "question", text: needsInput, since: nowIso(ctx) };
    } else if (patch.status === "in_progress" && claim === null) {
      // Starting work is claiming it: an in_progress task with no claim would look free to
      // others and never time out. The token is the new version, as in applyClaim.
      claim = { ...(await lease(w, ctx)), token: before.version + 1 };
    }
    return updateWithLog(
      w,
      ctx,
      "task",
      before,
      {
        ...patch,
        completion,
        claim,
        reviewNote,
        ...(blockedReason !== undefined ? { blockedReason } : {}),
      },
      { expectedVersion, clear: reviewed ? ["needsReview"] : [] },
    );
  });
}

/** Marks a task done with a summary and the files touched, and releases its claim and locks. */
export async function completeTask(ctx: ServiceContext, id: string, input: unknown): Promise<Task> {
  const { expectedVersion, token, ...data } = parseInput(CompleteTaskInput, input);
  refuseSecrets("task", { completion: data });
  // The commit the work was finished at, so a reviewer can see what moved after it.
  const commit = (await ctx.repo?.head()) ?? null;
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
    if (before.claim === null && (before.status === "todo" || before.status === "backlog")) {
      throw new SatiError("INVALID_TRANSITION", `Task ${id} was never started.`, {
        hint: `Claim it first (task_claim, or \`${CLI_NAME} task claim\`), do the work, then complete it.`,
      });
    }
    assertTransition(TASK_TRANSITIONS, "task", before.status, status);
    const filesTouched = data.filesTouched ?? [];
    if (settings.kind === "code" && filesTouched.length === 0) {
      throw new SatiError("VALIDATION", "List every file you touched.", {
        hint: "Pass filesTouched (`--files a.ts,b.ts` on the command line); it is how reviewers and the guard trace a change.",
      });
    }
    const completion = {
      ...data,
      filesTouched,
      completedAt: nowIso(ctx),
      completedBy: ctx.actorId,
      ...(commit ? { commit } : {}),
      ...(commit && ctx.branch ? { branch: ctx.branch } : {}),
    };
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
): Promise<Task & { handoff?: DeliveredHandoff }> {
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
  await renewTaskLocks(w, ctx, before.id, claim.leaseUntil);
  const actor = await w.get("actor", ctx.actorId);
  // Where the work happens, so worktree checks and cleanup can find the task's branch.
  const place = {
    ...(ctx.branch ? { branch: ctx.branch } : {}),
    ...(actor?.worktree ? { worktree: actor.worktree } : {}),
  };
  const task = await updateWithLog(
    w,
    ctx,
    "task",
    before,
    { status: "in_progress", claim, ...place },
    { verb: "claim" },
  );
  const handoff = await deliverHandoff(w, ctx, task.id);
  return handoff ? { ...task, handoff } : task;
}

/** What a claim hands the new holder: the handoff note left on the task, as data. */
export interface DeliveredHandoff {
  id: string;
  from: string;
  body: string;
}

/**
 * The claim result carries the task's unread handoff, so the new holder gets it with the claim;
 * delivering it acknowledges it in the same transaction. A handoff addressed to someone else
 * stays unread for them.
 */
async function deliverHandoff(
  w: StorageWriter,
  ctx: ServiceContext,
  taskId: string,
): Promise<DeliveredHandoff | undefined> {
  // Only unread handoffs: every claim runs this inside the write lock, so it must not read all notes.
  const notes = await listAll(w, ctx, "note", { handoff: "unread" });
  const me = await w.get("actor", ctx.actorId);
  const note = notes.find(
    (n: Note) => unreadHandoff(n) && n.links.includes(taskId) && handoffFor(n, me),
  );
  if (!note) return undefined;
  if (note.createdBy === ctx.actorId && note.handoffTo === undefined) {
    // Your own note, read back by you: deliver it, but leave it for whoever comes next.
    return { id: note.id, from: note.createdBy, body: note.body };
  }
  await updateWithLog(w, ctx, "note", note, {
    acknowledged: { by: ctx.actorId, at: nowIso(ctx) },
  });
  return { id: note.id, from: note.createdBy, body: note.body };
}

export async function claimTask(
  ctx: ServiceContext,
  id: string,
  input: unknown = {},
): Promise<Task & { handoff?: DeliveredHandoff }> {
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
): Promise<Task & { handoff?: DeliveredHandoff }> {
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
): Promise<{ task: Task & { handoff?: DeliveredHandoff }; acceptance: string[] }> {
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

/** A holder that wrote within this window is never called gone, whatever the process check says. */
export const HOLDER_QUIET_MS = 60_000;
/** When at least this many claims look gone at once, and most of them do, release none. */
const MASS_GONE_MIN = 3;

export interface ClaimHealth {
  /** Live claims whose holder process has exited on this machine and has been quiet a minute. */
  gone: Task[];
  /**
   * True when most probed holders looked gone at once, which points at the check (a container
   * that cannot see the host's processes, say), not at that many agents dying. Nothing is gone.
   */
  tripped: boolean;
  /** How many claims could be checked: they name a holder on this machine. */
  probed: number;
}

/**
 * Which live claims belong to an agent whose process is gone. Only a definite "exited" from
 * the process check counts; an unknown answer, another host or a recent write keeps the claim
 * until its lease runs out.
 */
export function claimHealth(ctx: ServiceContext, tasks: readonly Task[]): ClaimHealth {
  const probe = ctx.processes;
  const now = ctx.clock.now().getTime();
  const nowText = new Date(now).toISOString();
  const quietSince = new Date(now - HOLDER_QUIET_MS).toISOString();
  if (!probe) return { gone: [], tripped: false, probed: 0 };
  let probed = 0;
  const gone: Task[] = [];
  for (const t of tasks) {
    const c = t.claim;
    if (!c?.holder || c.leaseUntil <= nowText) continue;
    const alive = probe.alive(c.holder);
    if (alive === null) continue;
    probed++;
    if (alive === false && c.heartbeatAt <= quietSince) gone.push(t);
  }
  if (gone.length >= MASS_GONE_MIN && gone.length * 2 > probed) {
    return { gone: [], tripped: true, probed };
  }
  return { gone, tripped: false, probed };
}

/**
 * Points the caller's live claims at this process when the process that held them has exited.
 * An agent tool that restarts its MCP server (a reload or reconnect) keeps working on the same
 * tasks under a new process id; without this its claims would look abandoned. A holder that is
 * still running (another session as the same actor) or that this machine cannot check keeps them.
 */
export async function adoptClaims(ctx: ServiceContext): Promise<Task[]> {
  const probe = ctx.processes;
  const self = probe?.self;
  if (!probe || !self) return [];
  const now = nowIso(ctx);
  return ctx.store.write(async (w) => {
    const tasks = await listAll(w, ctx, "task", { status: ["in_progress", "review", "blocked"] });
    const adopted: Task[] = [];
    for (const t of tasks) {
      const c = t.claim;
      if (!c?.holder || c.actorId !== ctx.actorId || c.leaseUntil <= now) continue;
      if (c.holder.host === self.host && c.holder.pid === self.pid) continue;
      if (probe.alive(c.holder) !== false) continue;
      adopted.push(await updateWithLog(w, ctx, "task", t, { claim: { ...c, holder: self } }));
    }
    return adopted;
  });
}

/**
 * Clears claims whose lease has run out, or whose holder process has exited (see
 * `claimHealth`), so abandoned work returns to the pool: an `in_progress` task goes back to
 * `todo`; `review` and `blocked` tasks keep their status. Writes only when something is
 * released. Returns the released tasks.
 */
export async function releaseExpiredClaims(ctx: ServiceContext): Promise<Task[]> {
  const now = nowIso(ctx);
  const expired = (t: Task) => t.claim !== null && t.claim.leaseUntil <= now;
  const active = await ctx.store.read(async (r) =>
    listAll(r, ctx, "task", { status: ["in_progress", "review", "blocked"] }),
  );
  const goneIds = new Set(claimHealth(ctx, active).gone.map((t) => t.id));
  const candidates = active.filter((t) => expired(t) || goneIds.has(t.id));
  if (candidates.length === 0) return [];
  return ctx.store.write(async (w) => {
    const released: Task[] = [];
    for (const { id } of candidates) {
      // Re-read inside the transaction: the holder may have renewed since the check above.
      const before = await w.get("task", id);
      const stillGone =
        before?.claim != null &&
        goneIds.has(id) &&
        before.claim.heartbeatAt <=
          new Date(ctx.clock.now().getTime() - HOLDER_QUIET_MS).toISOString();
      if (!before || !(expired(before) || stillGone)) continue;
      const status = before.status === "in_progress" ? "todo" : before.status;
      if (before.claim) await releaseTaskLocks(w, ctx, id, before.claim.actorId);
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

/**
 * A fresh lease for the calling actor, defaulting to the project's lease length. It names this
 * process as the holder when it is a long-lived one, else keeps the holder `prev` named.
 */
async function lease(
  r: StorageReader,
  ctx: ServiceContext,
  minutes?: number,
  prev?: Claim,
): Promise<Claim> {
  const now = ctx.clock.now();
  const length = minutes ?? (await r.getProject())?.settings.leaseMinutes ?? DEFAULT_LEASE_MINUTES;
  const holder = ctx.processes?.self ?? prev?.holder;
  return {
    actorId: ctx.actorId,
    leaseUntil: new Date(now.getTime() + length * 60_000).toISOString(),
    heartbeatAt: now.toISOString(),
    ...(holder ? { holder: { ...holder } } : {}),
  };
}

/**
 * Marks the caller's held tasks as waiting on a person, or clears that. The holder sets it;
 * the holder or a person clears it (a person answered in the agent's session). Setting it is a
 * holder write, so it renews the lease: an agent waiting on a person keeps its task.
 */
export async function markWaiting(ctx: ServiceContext, input: unknown): Promise<Task[]> {
  const { taskId, waiting } = parseInput(WaitingInput, input);
  refuseSecrets("task", { waiting });
  return ctx.store.write(async (w) => {
    const now = nowIso(ctx);
    const caller = await w.get("actor", ctx.actorId);
    const person = caller?.kind === "human";
    const tasks = taskId
      ? [await mustGet(w, ctx, "task", taskId)]
      : (await listAll(w, ctx, "task", { status: ["in_progress", "review", "blocked"] })).filter(
          (t) => t.claim?.actorId === ctx.actorId && t.claim.leaseUntil > now,
        );
    const out: Task[] = [];
    for (const t of tasks) {
      const claim = t.claim;
      const mine = claim?.actorId === ctx.actorId && claim.leaseUntil > now;
      if (!claim || (!mine && (waiting !== null || !person))) {
        if (taskId) {
          throw new SatiError(
            "CONFLICT",
            waiting === null
              ? `Only the holder or a person can mark task ${t.id} answered.`
              : `Only the agent working on task ${t.id} can say it is waiting.`,
          );
        }
        continue;
      }
      if (waiting === null && claim.waiting === undefined) {
        out.push(t);
        continue;
      }
      const { waiting: _old, ...rest } = claim;
      const next: Claim = mine
        ? { ...(await lease(w, ctx, undefined, claim)), token: claim.token }
        : rest;
      if (waiting) next.waiting = { ...waiting, since: claim.waiting?.since ?? now };
      if (mine) await renewTaskLocks(w, ctx, t.id, next.leaseUntil);
      out.push(await updateWithLog(w, ctx, "task", t, { claim: next }));
    }
    return out;
  });
}

/** The commit a task's branch points at now, read from git, for approving a review. */
async function branchHeadOf(
  ctx: ServiceContext,
  taskId: string,
): Promise<{ branch: string; head: string | null } | undefined> {
  const task = await ctx.store.read((r) => r.get("task", taskId));
  const branch = task?.completion?.branch;
  if (!branch || !ctx.repo?.branchHead) return undefined;
  return { branch, head: await ctx.repo.branchHead(branch) };
}

/** Where a task in review stands against its branch: whether commits landed after it was sent. */
export interface ReviewDrift {
  commit: string;
  branch: string;
  /** The branch's commit now; null when the branch is gone. */
  head: string | null;
  /** True when the branch points elsewhere than the commit the work was sent at. */
  moved: boolean;
}

/**
 * True when the branch moved from `from` to `to` in more than sati's own snapshot. Agents commit
 * their work, and with it the `.sati/` export of their completion, after `task_complete`; a move
 * that only touched `.sati/` is not new work to review. Unknown (no git method, or git failed)
 * counts as moved.
 */
async function movedBeyondSnapshot(
  ctx: ServiceContext,
  from: string,
  to: string,
): Promise<boolean> {
  if (from === to) return false;
  const changed = await ctx.repo?.changedBetween?.(from, to);
  if (!changed) return true;
  return changed.some((p) => p !== CONFIG_DIR && !p.startsWith(`${CONFIG_DIR}/`));
}

/** Review drift for each task that was finished at a known commit. Needs git; empty without it. */
export async function reviewDrift(
  ctx: ServiceContext,
  tasks: readonly Task[],
): Promise<Map<string, ReviewDrift>> {
  const out = new Map<string, ReviewDrift>();
  const branchHead = ctx.repo?.branchHead?.bind(ctx.repo);
  if (!branchHead) return out;
  const heads = new Map<string, string | null>();
  for (const t of tasks) {
    const c = t.completion;
    if (!c?.commit || !c.branch) continue;
    if (!heads.has(c.branch)) heads.set(c.branch, await branchHead(c.branch));
    const head = heads.get(c.branch) ?? null;
    const seen = c.approvedCommit ?? c.commit;
    const moved = head !== null && (await movedBeyondSnapshot(ctx, seen, head));
    out.set(t.id, { commit: seen, branch: c.branch, head, moved });
  }
  return out;
}

/** The store's page cap for ready tasks. */
const READY_PAGE = 500;

/**
 * Lists tasks; `ready: true` returns todo, unclaimed tasks whose dependencies are done.
 * `milestoneId` matches a task whose own `milestoneId` is that milestone, or whose feature is in
 * it, so the milestone's features are looked up before the store sees the query.
 * The store's ready query takes no filters, so the filters apply here, page by page, until
 * the page is full. `includeDeleted` has no effect on ready tasks: a deleted task is never ready.
 */
export async function listTasks(ctx: ServiceContext, input: unknown = {}): Promise<Task[]> {
  const { ready, milestoneId, ...query } = parseInput(ListTasksInput, input);
  return ctx.store.read(async (r) => {
    const inMilestone = milestoneId
      ? {
          milestoneId,
          featureIds: (await listAll(r, ctx, "feature"))
            .filter((f) => f.milestoneId === milestoneId)
            .map((f) => f.id),
        }
      : undefined;
    if (!ready) return r.list("task", ctx.projectId, { ...query, inMilestone });
    const { status, featureId, parentId, label, dueBy, assigneeId, effort } = query;
    const start = query.offset ?? 0;
    const want = start + (query.limit ?? 50);
    const matches = (t: Task) =>
      (!status || status.includes(t.status)) &&
      (!featureId || t.featureId === featureId) &&
      (!inMilestone ||
        t.milestoneId === inMilestone.milestoneId ||
        (t.featureId !== null && inMilestone.featureIds.includes(t.featureId))) &&
      (!parentId || t.parentId === parentId) &&
      (!label || t.labels.includes(label)) &&
      (!dueBy || (t.dueDate != null && t.dueDate <= dueBy)) &&
      (!assigneeId || (t.assigneeIds ?? []).includes(assigneeId)) &&
      (!effort || (t.effort ?? "standard") === effort);
    // Page through the ready queue: a match may sit past the first 500 ready tasks.
    const out: Task[] = [];
    const now = nowIso(ctx);
    let after: string | undefined;
    while (out.length < want) {
      const page = await r.readyTasks(ctx.projectId, now, READY_PAGE, after);
      out.push(...page.filter(matches));
      if (page.length < READY_PAGE) break;
      after = page[page.length - 1]?.id;
    }
    return out.slice(start, want);
  });
}

/** Checks that linked feature, parent and dependencies exist and form no cycle. */
export async function checkLinks(
  r: StorageReader,
  ctx: ServiceContext,
  taskId: string,
  links: {
    featureId?: string | null | undefined;
    parentId?: string | null | undefined;
    dependsOn?: readonly string[] | undefined;
    assigneeIds?: readonly string[] | undefined;
    milestoneId?: string | null | undefined;
  },
): Promise<void> {
  if (links.featureId) await mustGet(r, ctx, "feature", links.featureId);
  if (links.milestoneId) await mustGet(r, ctx, "milestone", links.milestoneId);
  for (const actorId of links.assigneeIds ?? []) await mustGet(r, ctx, "actor", actorId);
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

/** A task as a list row; see `taskRow`. */
export type TaskRow = Pick<Task, "id" | "title" | "status" | "priority" | "version"> &
  Partial<
    Pick<
      Task,
      | "featureId"
      | "milestoneId"
      | "parentId"
      | "dependsOn"
      | "labels"
      | "dueDate"
      | "assigneeIds"
      | "effort"
      | "reviewNote"
      | "needsReview"
    >
  > & {
    claim?: { actorId: string; leaseUntil: string };
    /** Steps done of all, as "2/5". */
    checklist?: string;
  };

/**
 * A task as a list row: what an agent needs to pick, filter or update it (version for
 * expectedVersion), with empty and unset fields left out. A full record carries the body,
 * completion and per-field stamps, several times the size; MCP `task_list` asks for it with
 * `detail: "full"`, the CLI with `--full`.
 */
export function taskRow(t: Task): TaskRow {
  const row: TaskRow = {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    version: t.version,
  };
  if (t.featureId) row.featureId = t.featureId;
  if (t.milestoneId) row.milestoneId = t.milestoneId;
  if (t.parentId) row.parentId = t.parentId;
  if (t.dependsOn.length) row.dependsOn = t.dependsOn;
  if (t.labels.length) row.labels = t.labels;
  if (t.dueDate) row.dueDate = t.dueDate;
  if (t.assigneeIds?.length) row.assigneeIds = t.assigneeIds;
  if (t.effort) row.effort = t.effort;
  if (t.claim) row.claim = { actorId: t.claim.actorId, leaseUntil: t.claim.leaseUntil };
  if (t.checklist?.length) {
    row.checklist = `${t.checklist.filter((c) => c.done).length}/${t.checklist.length}`;
  }
  if (t.reviewNote) row.reviewNote = t.reviewNote;
  if (t.needsReview) row.needsReview = true;
  return row;
}
