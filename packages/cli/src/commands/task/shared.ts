import { CLI_NAME, getRecord, resolveId, SatiError, type ServiceContext } from "@sati/core";
import { NONE } from "../../args.js";
import { canAsk, missing } from "../../prompt.js";
import { int, list, ref, refs } from "../../runtime/input.js";

export const token = {
  token: {
    type: "string",
    description: "Fencing token from `task claim` (default: yours, if you hold the claim)",
  },
} as const;

/**
 * The fencing token for a write. Each CLI call is a new process with no memory of the claim, so
 * without `--token` it uses the claim's token only when the caller holds it. If another agent
 * has taken the task over, the caller is not the holder and the write is refused.
 */
export async function claimToken(
  ctx: ServiceContext,
  taskId: string,
  flag: string | undefined,
): Promise<number | undefined> {
  if (flag !== undefined) return int(flag, "token");
  const t = await getRecord(ctx, "task", taskId);
  return t.claim?.actorId === ctx.actorId ? t.claim.token : undefined;
}

/**
 * `--milestone`, `--feature` and `--parent` on create and update: an id or handle, or `none` to
 * clear the link.
 */
export async function link(
  ctx: ServiceContext,
  entity: "milestone" | "feature" | "task",
  value: string | undefined,
): Promise<string | null | undefined> {
  return value === NONE ? null : ref(ctx, entity, value);
}

/** `--depends`: comma-separated ids or handles, or `none` to clear the list. */
export async function depends(ctx: ServiceContext, value: string | undefined) {
  return value === NONE ? [] : refs(ctx, "task", value);
}

/**
 * `--assign`: comma-separated actor names, ids or handles, `me`, or `none` to clear. People
 * know each other by name, so a name is looked up before it is treated as an id.
 */
export async function assignees(
  ctx: ServiceContext,
  value: string | undefined,
): Promise<string[] | undefined> {
  if (value === undefined) return undefined;
  if (value === NONE) return [];
  const out: string[] = [];
  for (const item of list(value) ?? []) {
    if (item === "me") {
      out.push(ctx.actorId);
      continue;
    }
    const named = await ctx.store.read((r) => r.getByKey("actor", ctx.projectId, item));
    out.push(named ? named.id : await resolveId(ctx, "actor", item));
  }
  return [...new Set(out)];
}

export const fields = {
  body: { type: "string", description: "Details in Markdown (- reads stdin)" },
  priority: { type: "string", description: "low | medium | high | urgent" },
  effort: {
    type: "string",
    description: "light (fine for a small model) | standard | deep, or none",
  },
  feature: { type: "string", description: "Feature id or handle, or none" },
  parent: { type: "string", description: "Parent task id or handle, or none" },
  depends: { type: "string", description: "Comma-separated task ids this task waits on, or none" },
  // `task list` filters with --label; both spellings work on every task command (review 5.1).
  labels: { type: "string", alias: "label", description: "Comma-separated labels" },
  branch: { type: "string", description: "Git branch for this task" },
  worktree: { type: "string", description: "Worktree path for this task" },
  due: { type: "string", description: "Due day YYYY-MM-DD, or none" },
  milestone: { type: "string", description: "Milestone (plan) id or handle, or none" },
  assign: {
    type: "string",
    description: "Who should do it: comma-separated names, ids or me, or none",
  },
} as const;

/** A task id that a person at a terminal may leave out, to choose from a list. */
export const pickedId = {
  id: {
    type: "positional",
    required: false,
    description: "Task id or short handle (at a terminal: leave it out to choose)",
  },
} as const;

/** The flags a person typed after the command word, for the "Same as" line. */
export function typedAfter(word: string): string[] {
  const argv = process.argv.slice(2);
  return argv.slice(argv.indexOf(word) + 1);
}

export const noTasks = () =>
  new SatiError("NOT_FOUND", "No tasks.", {
    hint: `Create one with \`${CLI_NAME} task create "title"\`.`,
  });

/**
 * A missing id where nobody can be asked is the usage error it always was. Checked before the
 * project is opened, so the answer is the same outside one.
 */
export function needsId(
  args: { id?: string | undefined; json?: boolean | undefined },
  command: string,
) {
  if (args.id === undefined && !canAsk(args.json)) throw missing("id", command);
}
