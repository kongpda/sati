import {
  type ChecklistItem,
  getRecord,
  resolveId,
  SatiError,
  shortHandle,
  type Task,
  updateTask,
} from "@sati/core";
import { defineCommand } from "citty";
import { expectedVersion, json, orNone, taskId } from "../../args.js";
import { pickTask, sameAs } from "../../prompt.js";
import { row } from "../../render.js";
import { bodyText, heldTask, int, list, someChange } from "../../runtime/input.js";
import { execute } from "../../runtime/output.js";
import {
  assignees,
  claimToken,
  depends,
  fields,
  link,
  needsId,
  noTasks,
  pickedId,
  token,
  typedAfter,
} from "./shared.js";

export const updateCommand = defineCommand({
  meta: { name: "update", description: "Change a task (use `complete` to finish it)" },
  args: {
    ...pickedId,
    title: { type: "string", description: "New title" },
    status: {
      type: "string",
      description:
        "New status. done approves a task in review (people only); otherwise finish with complete",
    },
    ...fields,
    ...expectedVersion,
    ...token,
    reviewed: { type: "boolean", description: "Clear needsReview" },
    reason: {
      type: "string",
      description: "Why a review task goes back to todo, or what a blocked task waits on",
    },
    "needs-input": {
      type: "string",
      description: "Ask a person this question; your next write clears it",
    },
    "approved-commit": {
      type: "string",
      description: "Approving: the commit you looked at; refused if the branch moved since",
    },
    ...json,
  },
  run: ({ args }) => {
    needsId(args, "task update");
    return execute(
      args.json,
      async ({ ctx }) => {
        // A typed id is checked first, as before; a person who typed none picks after the flags
        // are known to be good, so no choice is thrown away by a bad flag.
        const typed = args.id === undefined ? undefined : await resolveId(ctx, "task", args.id);
        const input = someChange(
          {
            needsInput: args["needs-input"],
            approvedCommit: args["approved-commit"],
            title: args.title,
            body: bodyText(args.body),
            status: args.status,
            priority: args.priority,
            effort: orNone(args.effort),
            featureId: await link(ctx, "feature", args.feature),
            parentId: await link(ctx, "task", args.parent),
            dependsOn: await depends(ctx, args.depends),
            labels: list(args.labels),
            branch: args.branch,
            worktree: args.worktree,
            dueDate: orNone(args.due),
            milestoneId: await link(ctx, "milestone", args.milestone),
            assigneeIds: await assignees(ctx, args.assign),
            expectedVersion: int(args["expected-version"], "expected-version"),
            reviewed: args.reviewed ? true : undefined,
            reason: args.reason,
          },
          "task update",
        );
        const taskId =
          typed ?? (await pickTask(ctx, {}, "Update which task?", { empty: noTasks() }));
        if (typed === undefined)
          sameAs("task", "update", shortHandle(taskId), ...typedAfter("update"));
        return updateTask(ctx, taskId, {
          ...input,
          token: await claimToken(ctx, taskId, args.token),
        });
      },
      (t: Task) => `Updated ${row(t)}`,
    );
  },
});

/** The checklist as numbered lines, so `--done 2` refers to what the person sees. */
function checklistText(t: Task): string {
  const items = t.checklist ?? [];
  if (items.length === 0) return `${row(t)}\n  No checklist. Add a step with --add "text".`;
  const lines = items.map((c, i) => `  ${i + 1}. [${c.done ? "x" : " "}] ${c.text}`);
  return [row(t), ...lines].join("\n");
}

export const checklistCommand = defineCommand({
  meta: {
    name: "checklist",
    description: "Show a task's checklist, or add, tick, untick or remove a step",
  },
  args: {
    ...taskId,
    add: { type: "string", description: "Add a step with this text" },
    done: { type: "string", description: "Tick step number N" },
    undone: { type: "string", description: "Untick step number N" },
    remove: { type: "string", description: "Remove step number N" },
    ...token,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const taskId = await heldTask(ctx, args.id);
        const t = await getRecord(ctx, "task", taskId);
        const items: ChecklistItem[] = [...(t.checklist ?? [])];
        const step = (flag: "done" | "undone" | "remove") => {
          const n = int(args[flag], flag);
          if (n === undefined) return undefined;
          if (n < 1 || n > items.length) {
            throw new SatiError(
              "USAGE",
              `--${flag} ${n}: the checklist has ${items.length} steps.`,
            );
          }
          return n - 1;
        };
        const done = step("done");
        const undone = step("undone");
        const removed = step("remove");
        if (done !== undefined && items[done]) items[done] = { ...items[done], done: true };
        if (undone !== undefined && items[undone])
          items[undone] = { ...items[undone], done: false };
        if (removed !== undefined) items.splice(removed, 1);
        if (args.add !== undefined) items.push({ text: args.add, done: false });
        const changed =
          args.add !== undefined ||
          done !== undefined ||
          undone !== undefined ||
          removed !== undefined;
        if (!changed) return t;
        // The version read above guards the whole list against a change made meanwhile.
        return updateTask(ctx, taskId, {
          checklist: items,
          expectedVersion: t.version,
          token: await claimToken(ctx, taskId, args.token),
        });
      },
      checklistText,
    ),
});
