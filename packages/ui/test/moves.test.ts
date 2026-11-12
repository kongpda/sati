import { describe, expect, it } from "vitest";
import type { Snapshot, Task } from "../src/api.js";
import {
  allInReview,
  answerRefusal,
  canTakeOver,
  claimRefusal,
  heldByOther,
  moveRefusal,
  moveTargets,
  needsReason,
  personOnly,
} from "../src/moves.js";

const later = new Date(Date.now() + 3_600_000).toISOString();
const earlier = new Date(Date.now() - 3_600_000).toISOString();

function board(you: "me" | "bot" = "me", review: "agents" | "all" | "none" = "agents"): Snapshot {
  return {
    you,
    project: { name: "P", kind: "code", review },
    actors: [
      { id: "me", name: "kong", kind: "human" },
      { id: "bot", name: "codex", kind: "agent" },
    ],
  } as unknown as Snapshot;
}

function task(status: string, more: Partial<Task> = {}): Task {
  return { id: "t1", title: "T", status, claim: null, completion: null, ...more } as Task;
}

const claim = (actorId: string, leaseUntil = later) => ({ actorId, leaseUntil }) as Task["claim"];
const finished = { summary: "did it", filesTouched: [], completedBy: "bot" } as Task["completion"];

// The board must not offer what core is certain to refuse: a refused drop or save reads as a
// broken product. Each case below is a refusal core gives (services/task.ts).
describe("moveRefusal", () => {
  it("allows the moves core allows and nothing else", () => {
    expect(moveRefusal(board(), task("todo"), "in_progress")).toBeNull();
    expect(moveRefusal(board(), task("todo"), "todo")).toBeNull();
    expect(moveRefusal(board(), task("backlog"), "in_progress")).toMatch(
      /cannot go to Working on it\. It can go to To do, Blocked or Cancelled\./u,
    );
    expect(moveTargets(board(), task("done"))).toEqual(["todo"]);
  });

  it("never offers review by hand: only finishing the work with a summary gets there", () => {
    for (const from of ["todo", "in_progress", "blocked"]) {
      expect(moveRefusal(board(), task(from), "review")).toMatch(/finishes it with a summary/u);
      expect(moveTargets(board(), task(from))).not.toContain("review");
    }
  });

  it("offers done only for finished work in review", () => {
    expect(moveRefusal(board(), task("in_progress"), "done")).toMatch(/Only work in/u);
    expect(moveRefusal(board(), task("review"), "done")).toMatch(/Only work in/u);
    expect(moveRefusal(board(), task("review", { completion: finished }), "done")).toBeNull();
  });

  it("keeps approval for people unless the project turned the review gate off", () => {
    const inReview = task("review", { completion: finished });
    expect(moveRefusal(board("bot"), inReview, "done")).toMatch(/Only a person can approve/u);
    expect(moveRefusal(board("bot", "none"), inReview, "done")).toBeNull();
    // Sending back is open to anyone.
    expect(moveRefusal(board("bot"), inReview, "todo")).toBeNull();
  });

  it("refuses every move on a task someone else holds, even after their time ran out", () => {
    const data = board();
    for (const held of [claim("bot"), claim("bot", earlier)]) {
      const t = task("in_progress", { claim: held });
      expect(heldByOther(data, t)).toBe(true);
      expect(moveRefusal(data, t, "todo")).toMatch(/codex is working on this task/u);
      expect(moveTargets(data, t)).toEqual([]);
    }
    expect(moveTargets(data, task("in_progress", { claim: claim("me") }))).toContain("todo");
  });
});

describe("what only a person may do", () => {
  it("says who the board runs as, so the reader knows how to get the action", () => {
    expect(personOnly(board("me"))).toBeNull();
    expect(personOnly(board("bot"))).toMatch(/runs as codex, an agent/u);
  });

  it("lets an agent-run board end only its own claim or one that ran out", () => {
    expect(claimRefusal(board("bot"), { actorId: "me", leaseUntil: later })).toMatch(/an agent/u);
    expect(claimRefusal(board("bot"), { actorId: "me", leaseUntil: earlier })).toBeNull();
    expect(claimRefusal(board("bot"), { actorId: "bot", leaseUntil: later })).toBeNull();
    expect(claimRefusal(board("me"), { actorId: "bot", leaseUntil: later })).toBeNull();
  });

  it("lets the holder or a person mark a question answered", () => {
    const asked = task("in_progress", { claim: claim("bot") });
    expect(answerRefusal(board("me"), asked)).toBeNull();
    expect(answerRefusal(board("bot"), asked)).toBeNull();
    const others = task("in_progress", { claim: claim("me") });
    expect(answerRefusal(board("bot"), others)).toMatch(/an agent/u);
  });
});

describe("send back and take over", () => {
  it("asks for a reason only when work goes back from review to To do", () => {
    expect(needsReason(task("review"), "todo")).toBe(true);
    expect(needsReason(task("review"), "in_progress")).toBe(false);
    expect(needsReason(task("blocked"), "todo")).toBe(false);
  });

  it("offers Take over only where the task can be claimed again", () => {
    expect(canTakeOver(task("in_progress"))).toBe(true);
    expect(canTakeOver(task("todo"))).toBe(true);
    expect(canTakeOver(task("blocked"))).toBe(false);
    expect(canTakeOver(task("review"))).toBe(false);
  });
});

// Review 1.1: Approve and Send back are offered for a selection only when every task in it is
// finished work waiting in review. One task that is not would make the whole action refuse.
describe("allInReview", () => {
  it("only completed review tasks can be approved together", () => {
    const done = task("review", { completion: finished });
    expect(allInReview([done, { ...done, id: "t2" }])).toBe(true);
    expect(allInReview([])).toBe(false);
    expect(allInReview([done, task("todo")])).toBe(false);
    expect(allInReview([done, task("review")])).toBe(false);
  });
});
