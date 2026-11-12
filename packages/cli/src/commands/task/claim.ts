import {
  CLI_NAME,
  claimNext,
  claimTask,
  getRecord,
  listTasks,
  releaseTask,
  resolveId,
  SatiError,
  type ServiceContext,
  shortHandle,
  type Task,
  takeOverTask,
} from "@sati/core";
import { defineCommand } from "citty";
import { id, json, taskId } from "../../args.js";
import { canAsk, pickTask, sameAs } from "../../prompt.js";
import { claimed, row } from "../../render.js";
import { heldTask, int } from "../../runtime/input.js";
import { execute } from "../../runtime/output.js";
import { when } from "../../term.js";

/** The task with its feature's acceptance lines, as `claimNext` gives them. */
async function withAcceptance<T extends Task>(
  ctx: ServiceContext,
  task: T,
): Promise<T & { acceptance: string[] }> {
  const feature = task.featureId ? await getRecord(ctx, "feature", task.featureId) : undefined;
  return { ...task, acceptance: feature?.deletedAt ? [] : (feature?.acceptance ?? []) };
}

/**
 * `task claim --pick`: a person chooses from the ready tasks, in the order `task claim` would
 * take them.
 */
async function pickReady(ctx: ServiceContext, conflict: boolean): Promise<string> {
  if (conflict || !canAsk()) {
    throw new SatiError(
      "USAGE",
      "--pick asks a question, so it needs a terminal and no id or --json.",
      {
        hint: `Run \`${CLI_NAME} task list --ready\`, then \`${CLI_NAME} task claim <id>\`.`,
      },
    );
  }
  return pickTask(ctx, { ready: true }, "Claim which task?", {
    empty: new SatiError("NOT_FOUND", "No ready task.", {
      hint: `Create one with \`${CLI_NAME} task create\`, or see \`${CLI_NAME} task list\`.`,
    }),
    cancelled: "Nothing claimed.",
  });
}

export const claimCommand = defineCommand({
  meta: {
    name: "claim",
    description: "Claim a task before working on it (moves it to in_progress)",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description: "Task id, or omit to claim the top ready task",
    },
    lease: { type: "string", description: "Lease length in minutes (default: project setting)" },
    pick: { type: "boolean", description: "Choose from the ready tasks (needs a terminal)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const leaseMinutes = int(args.lease, "lease");
        if (args.pick) {
          const chosen = await pickReady(ctx, args.id !== undefined || args.json === true);
          return withAcceptance(ctx, await claimTask(ctx, chosen, { leaseMinutes }));
        }
        // A person with several ready tasks chooses; the top one is first, so Enter takes what
        // `task claim` always took. Scripts and agents get the top one without a question.
        if (!args.id && canAsk(args.json)) {
          const ready = await listTasks(ctx, { ready: true, limit: 2 });
          if (ready.length > 1) {
            const chosen = await pickReady(ctx, false);
            sameAs("task", "claim", shortHandle(chosen));
            return withAcceptance(ctx, await claimTask(ctx, chosen, { leaseMinutes }));
          }
        }
        if (!args.id) {
          const next = await claimNext(ctx, { leaseMinutes });
          return { ...next.task, acceptance: next.acceptance };
        }
        return withAcceptance(
          ctx,
          await claimTask(ctx, await resolveId(ctx, "task", args.id), { leaseMinutes }),
        );
      },
      claimed,
    ),
});

export const releaseCommand = defineCommand({
  meta: {
    name: "release",
    description: "Give up a claim (an in_progress task goes back to todo)",
  },
  args: {
    ...taskId,
    force: {
      type: "boolean",
      description: "Release another actor's live claim (people only; logged)",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        releaseTask(ctx, await heldTask(ctx, args.id), { force: args.force ?? false }),
      (t: Task) => `Released ${row(t)}`,
    ),
});

export const takeOverCommand = defineCommand({
  meta: {
    name: "take-over",
    description: "Take a task from its holder and claim it yourself (people only; logged)",
  },
  args: {
    ...id("Task"),
    lease: { type: "string", description: "Lease length in minutes (default: project setting)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        takeOverTask(ctx, await resolveId(ctx, "task", args.id), {
          leaseMinutes: int(args.lease, "lease"),
        }),
      (t: Task) =>
        `Took over ${row(t)} until ${when(t.claim?.leaseUntil)}, token ${t.claim?.token}`,
    ),
});
