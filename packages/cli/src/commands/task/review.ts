import {
  CLI_NAME,
  completeTask,
  type ListTasksInput,
  resolveId,
  SatiError,
  type ServiceContext,
  shortHandle,
  type Task,
  updateTask,
} from "@sati/core";
import { defineCommand } from "citty";
import { expectedVersion, json, taskId } from "../../args.js";
import { askFiles, askText, canAsk, missingFlag, pickTask, sameAs } from "../../prompt.js";
import { row } from "../../render.js";
import { heldTask, int, list } from "../../runtime/input.js";
import { execute } from "../../runtime/output.js";
import { claimToken, needsId, pickedId, token, typedAfter } from "./shared.js";

export const completeCommand = defineCommand({
  meta: {
    name: "complete",
    description:
      "Finish a task with a summary of what changed (an agent's task goes to review when the review setting asks for approval)",
  },
  args: {
    ...taskId,
    summary: {
      type: "string",
      description: "What was done (required; at a terminal: asked when left out)",
    },
    "release-note": {
      type: "string",
      description: "One line for users, for the changelog (default: the summary)",
    },
    files: {
      type: "string",
      description: "Comma-separated files touched (required in a code project)",
    },
    ...expectedVersion,
    ...token,
    ...json,
  },
  run: ({ args }) => {
    if (args.summary === undefined && !canAsk(args.json)) {
      throw missingFlag("summary", "task complete");
    }
    return execute(
      args.json,
      async ({ ctx, location }) => {
        const taskId = await heldTask(ctx, args.id);
        // A person who typed no summary is asked for it, and for the files when none were given:
        // the ones git says this worktree changed are offered, already ticked.
        const summary = args.summary ?? (await askText("What was done?"));
        let files = list(args.files);
        if (args.summary === undefined && files === undefined) {
          const changed = (await ctx.repo?.changedFiles?.(location.root)) ?? [];
          const offered = changed.filter((f) => !f.startsWith(".sati/")).sort();
          files = await askFiles("Files touched", offered);
        }
        if (args.summary === undefined) {
          sameAs(
            "task",
            "complete",
            shortHandle(taskId),
            "--summary",
            summary,
            ...(files?.length && args.files === undefined ? ["--files", files.join(",")] : []),
            ...typedAfter("complete").filter((w) => w !== args.id),
          );
        }
        return completeTask(ctx, taskId, {
          summary,
          releaseNote: args["release-note"],
          filesTouched: files?.length ? files : undefined,
          expectedVersion: int(args["expected-version"], "expected-version"),
          token: await claimToken(ctx, taskId, args.token),
        });
      },
      (t: Task) =>
        t.status === "review"
          ? `Completed ${row(t)}\n  Waiting for a person to approve it (settings --review).`
          : `Completed ${row(t)}`,
    );
  },
});

/** The task a command is about: the id typed, or the one a person picks from `filter`. */
async function taskOrPick(
  ctx: ServiceContext,
  args: { id?: string | undefined; json?: boolean | undefined },
  ask: { filter: ListTasksInput; message: string; empty: SatiError },
): Promise<{ id: string; picked: boolean }> {
  if (args.id !== undefined) return { id: await resolveId(ctx, "task", args.id), picked: false };
  return { id: await pickTask(ctx, ask.filter, ask.message, { empty: ask.empty }), picked: true };
}

const noneInReview = () =>
  new SatiError("NOT_FOUND", "No task waits for approval.", {
    hint: `See what waits for you with \`${CLI_NAME} inbox\`.`,
  });
const inReview = (message: string) => ({
  filter: { status: ["review"] },
  message,
  empty: noneInReview(),
});

export const approveCommand = defineCommand({
  meta: {
    name: "approve",
    description:
      "Approve a task in review: it moves to done (people only). The same as `task update <id> --status done`",
  },
  args: {
    ...pickedId,
    commit: {
      type: "string",
      description: "The commit you looked at; refused if the branch moved since",
    },
    ...json,
  },
  run: ({ args }) => {
    needsId(args, "task approve");
    return execute(
      args.json,
      async ({ ctx }) => {
        const task = await taskOrPick(ctx, args, inReview("Approve which task?"));
        if (task.picked) sameAs("task", "approve", shortHandle(task.id));
        return updateTask(ctx, task.id, { status: "done", approvedCommit: args.commit });
      },
      (t: Task) => `Approved ${row(t)}`,
    );
  },
});

export const sendBackCommand = defineCommand({
  meta: {
    name: "send-back",
    description:
      "Send a task in review back to todo with what to change (the next claimer sees it). The same as `task update <id> --status todo --reason`",
  },
  args: {
    ...pickedId,
    reason: { type: "string", description: "What to change" },
    ...json,
  },
  run: ({ args }) => {
    if (args.reason === undefined && !canAsk(args.json)) {
      throw new SatiError("USAGE", "Missing --reason.", {
        hint: `Run \`${CLI_NAME} task send-back <id> --reason "what to change"\`.`,
      });
    }
    needsId(args, "task send-back");
    return execute(
      args.json,
      async ({ ctx }) => {
        const task = await taskOrPick(ctx, args, inReview("Send back which task?"));
        const reason = args.reason ?? (await askText("What should change?"));
        if (task.picked || args.reason === undefined) {
          sameAs("task", "send-back", shortHandle(task.id), "--reason", reason);
        }
        return updateTask(ctx, task.id, { status: "todo", reason });
      },
      (t: Task) => `Sent back ${row(t)}`,
    );
  },
});
