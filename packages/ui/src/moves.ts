import type { Snapshot, Task } from "./api.js";
import { holderName } from "./people.js";
import { statusWord } from "./words.js";

/*
 * What core will refuse, known before the click. Core stays the judge: these rules only keep the
 * board from offering a move, a save or a button that the server is certain to refuse.
 */

/** Where a task may go next; mirrors TASK_TRANSITIONS in core (test/constants.test.ts checks it). */
export const TASK_NEXT: Record<string, string[]> = {
  backlog: ["todo", "blocked", "cancelled"],
  todo: ["backlog", "in_progress", "blocked", "cancelled"],
  in_progress: ["todo", "review", "done", "blocked", "cancelled"],
  review: ["todo", "in_progress", "done", "blocked", "cancelled"],
  blocked: ["backlog", "todo", "in_progress", "cancelled"],
  done: ["todo"],
  cancelled: ["backlog", "todo"],
};

/** The actor this board writes as. Started from an agent's terminal, the board is that agent. */
const boardActor = (data: Snapshot) => data.actors.find((a) => a.id === data.you);

/** Approving, taking over and ending someone's live claim are for people. */
const actsAsPerson = (data: Snapshot): boolean => boardActor(data)?.kind === "human";

/** Why this board cannot do what only a person may, or null when it can. */
export function personOnly(data: Snapshot): string | null {
  if (actsAsPerson(data)) return null;
  const name = boardActor(data)?.name ?? "an agent";
  return `This board runs as ${name}, an agent. Start it from your own terminal to do this.`;
}

/**
 * Someone else's claim, live or run out: core refuses every save on the task until the claim is
 * released or taken over, because the save has no fencing token.
 */
export const heldByOther = (data: Snapshot, task: Task): boolean =>
  task.claim !== null && task.claim.actorId !== data.you;

const list = (words: string[]): string =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;

/** Why the task cannot move to `to`, in words a person can act on; null when it can. */
export function moveRefusal(data: Snapshot, task: Task, to: string): string | null {
  const from = task.status;
  if (from === to) return null;
  if (heldByOther(data, task)) {
    return `${holderName(data, task.claim?.actorId)} is working on this task. Open it to take it over or release it first.`;
  }
  if (to === "review") {
    return `A task reaches ${statusWord("review")} when whoever does it finishes it with a summary. It cannot be moved there by hand.`;
  }
  if (to === "done") {
    if (from !== "review" || task.completion === null) {
      return `Only work in ${statusWord("review")} can be moved to ${statusWord("done")}. Whoever does the task finishes it with a summary.`;
    }
    if (data.project?.review !== "none" && !actsAsPerson(data)) {
      return `Only a person can approve work. ${personOnly(data)}`;
    }
    return null;
  }
  if (TASK_NEXT[from]?.includes(to)) return null;
  const next = (TASK_NEXT[from] ?? []).filter((s) => moveRefusal(data, task, s) === null);
  return `A task in ${statusWord(from)} cannot go to ${statusWord(to)}. It can go to ${list(next.map(statusWord))}.`;
}

/** The statuses the task can move to from here. */
export const moveTargets = (data: Snapshot, task: Task): string[] =>
  (TASK_NEXT[task.status] ?? []).filter((to) => moveRefusal(data, task, to) === null);

/** Work sent back from review carries what still needs doing; core refuses it without. */
export const needsReason = (task: Task, to: string): boolean =>
  task.status === "review" && to === "todo";

/** A claim can be taken over only where the task can be claimed again. */
export const canTakeOver = (task: Task): boolean =>
  task.status === "todo" || task.status === "in_progress";

/**
 * Why this board cannot end the claim, or null when it can. Core lets the holder end their own
 * claim, anyone end one that ran out, and only a person end someone else's live one.
 */
export function claimRefusal(
  data: Snapshot,
  claim: { actorId: string; leaseUntil: string },
): string | null {
  if (claim.actorId === data.you || Date.parse(claim.leaseUntil) <= Date.now()) return null;
  return personOnly(data);
}

/** Why this board cannot mark the agent's question answered, or null when it can. */
export function answerRefusal(data: Snapshot, task: Task): string | null {
  const claim = task.claim;
  if (claim?.actorId === data.you && Date.parse(claim.leaseUntil) > Date.now()) return null;
  return personOnly(data);
}
