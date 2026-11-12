import { describe, expect, it } from "vitest";
import { createNote, createTask, recall, search, updateTask } from "../src/index.js";
import { setup } from "./support/setup.js";

describe("search service", () => {
  it("finds records across entities", async () => {
    const { ctx } = await setup();
    await createTask(ctx, { title: "Fix login redirect" });
    await createNote(ctx, { title: "Login flow notes" });
    const hits = await search(ctx, { query: "login" });
    expect(hits.map((h) => h.entity).sort()).toEqual(["note", "task"]);
  });

  it("rejects an empty query before touching the store", async () => {
    const { ctx } = await setup();
    await expect(search(ctx, { query: "  " })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(search(ctx, { query: "x", entities: ["lock"] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("recall candidates", () => {
  // Recall reads 40 candidates. If closed tasks filled them, the open task a question is about
  // would be missing from the answer, not only slower to find.
  it("closed tasks never use up recall's candidate slots", async () => {
    const { ctx } = await setup();
    for (let i = 0; i < 50; i++) {
      const t = await createTask(ctx, { title: `Venue deposit ${i}` });
      await updateTask(ctx, t.id, { status: "cancelled" });
    }
    const open = await createTask(ctx, { title: "Venue deposit for spring" });
    const answer = await recall(ctx, { question: "venue deposit" });
    expect(JSON.stringify(answer)).toContain(open.id);
  });
});
