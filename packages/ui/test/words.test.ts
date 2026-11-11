import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api.js";
import { activityWords, plainError, statusWord, untilTime } from "../src/words.js";

describe("plain words", () => {
  it("names statuses as people say them and leaves unknown ones alone", () => {
    expect(statusWord("in_progress")).toBe("Working on it");
    expect(statusWord("review")).toBe("Waiting for approval");
    expect(statusWord("archived")).toBe("archived");
  });

  it("turns activity rows into sentences", () => {
    const moved = { status: { from: "in_progress", to: "review" } };
    expect(activityWords("status", "task", moved)).toBe("moved the task to Waiting for approval");
    expect(activityWords("claim", "task", {})).toBe("started working on the task");
    expect(
      activityWords("complete", "task", { status: { from: "in_progress", to: "review" } }),
    ).toBe("finished the task and sent it for approval");
    expect(activityWords("complete", "task", { status: { from: "in_progress", to: "done" } })).toBe(
      "finished the task",
    );
    expect(activityWords("create", "actor", {})).toBe("joined the project");
    expect(activityWords("create", "lock", {})).toBe("added the file reservation");
    expect(
      activityWords("update", "note", {
        deletedAt: { from: "2026-11-07T00:00:00.000Z", to: null },
      }),
    ).toBe("restored the note");
    expect(activityWords("update", "note", { title: { from: "a", to: "b" } })).toBe(
      "changed the note",
    );
    // Features have their own statuses, shown as stored.
    expect(
      activityWords("status", "feature", { status: { from: "building", to: "shipped" } }),
    ).toBe("moved the feature to shipped");
  });

  it("shows the day only when the time is not today", () => {
    const now = new Date(2026, 10, 7, 9, 0);
    const later = new Date(2026, 10, 7, 14, 32).toISOString();
    const tomorrow = new Date(2026, 10, 8, 14, 32).toISOString();
    expect(untilTime(later, now)).not.toMatch(/Nov|Sun/u);
    expect(untilTime(later, now)).toMatch(/32/u);
    expect(untilTime(tomorrow, now)).toMatch(/Sun/u);
  });

  it("explains refused saves without versions, tokens or commands", () => {
    const stale = new ApiError(
      "task tsk_1 is at version 3, not 2.",
      "Re-read the record.",
      "CONFLICT",
    );
    expect(plainError(stale)).toMatch(/since you opened it/u);
    const held = new ApiError(
      "Task tsk_1 is claimed; this write needs the claim's fencing token.",
      "Run `sati task take-over tsk_1`.",
      "CONFLICT",
    );
    expect(plainError(held)).toMatch(/Take it over or release it/u);
    const other = new ApiError("Title is required.", "Run `sati task create`.", "VALIDATION");
    expect(plainError(other)).toBe("Title is required.");
    expect(plainError(new ApiError("Bad date.", "Use YYYY-MM-DD.", "VALIDATION"))).toBe(
      "Bad date. Use YYYY-MM-DD.",
    );
  });

  // A person reads these on the board: no status ids, record ids or command names.
  it("puts a refused move in the board's own words", () => {
    const move = new ApiError(
      "A task cannot move from in_progress to backlog.",
      "Allowed from in_progress: todo, review, done, blocked, cancelled.",
      "INVALID_TRANSITION",
    );
    expect(plainError(move)).toBe(
      "This cannot go from Working on it to Backlog. It can go to To do, Waiting for approval, Done, Blocked, Cancelled.",
    );
    const review = new ApiError(
      "Use complete to send a task to review.",
      "Complete it: `sati task complete`.",
      "INVALID_TRANSITION",
    );
    expect(plainError(review)).toMatch(/finishes it with a summary/u);
    expect(plainError(review)).not.toMatch(/complete/u);
    const taken = new ApiError(
      "Only a person can take task 01M74PVVB2MP62GRN1XC90AKCE from codex.",
      "Pick another ready task with `sati task list --ready`.",
      "CONFLICT",
    );
    expect(plainError(taken)).toBe("Only a person can take a task from whoever is working on it.");
    const waiting = new ApiError(
      "Task 01M74PVVB2MP62GRN1XC90AKCE is waiting for review.",
      "A person moves it to done, or back to todo with a reason.",
      "INVALID_TRANSITION",
    );
    expect(plainError(waiting)).toBe(
      "This task is waiting for review. A person moves it to done, or back to todo with a reason.",
    );
  });
});
