import { describe, expect, it } from "vitest";
import { createNote, createTask, search } from "../src/index.js";
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
