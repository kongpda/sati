import { describe, expect, it } from "vitest";
// Read from core's source: the board bundle does not ship core, so it keeps copies of these.
// Single files, not the index: the index pulls in services that need Node's types.
import { ACTOR_COLORS, PRIORITIES } from "../../core/src/domain/schemas.js";
import { MILESTONE_TRANSITIONS, TASK_TRANSITIONS } from "../../core/src/domain/status.js";
import { COMMENT_MAX, COMMENT_TAG } from "../../core/src/services/comment.js";
import { MILESTONE_NEXT, PRIORITIES as UI_PRIORITIES } from "../src/forms.js";
import { TASK_NEXT } from "../src/moves.js";
import { COLORS } from "../src/people.js";
import { COMMENT_MAX as UI_COMMENT_MAX, COMMENT_TAG as UI_COMMENT_TAG } from "../src/thread.js";

// Review WP6.5: when core changes one of these and the board's copy does not, the board offers
// a choice core refuses, or hides comments it no longer recognises.
describe("constants copied from core", () => {
  it("match core's", () => {
    expect(UI_PRIORITIES).toEqual(PRIORITIES);
    expect(MILESTONE_NEXT).toEqual(MILESTONE_TRANSITIONS);
    expect(TASK_NEXT).toEqual(TASK_TRANSITIONS);
    expect(COLORS).toEqual(ACTOR_COLORS);
    expect(UI_COMMENT_TAG).toBe(COMMENT_TAG);
    expect(UI_COMMENT_MAX).toBe(COMMENT_MAX);
  });
});
