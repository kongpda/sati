import { describe, expect, it } from "vitest";
import { createTask, resolveId, shortHandle } from "../src/index.js";
import { setup } from "./support/setup.js";

describe("resolveId", () => {
  it("accepts a full id or its short handle, in any case", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    expect(await resolveId(ctx, "task", t.id)).toBe(t.id);
    expect(await resolveId(ctx, "task", shortHandle(t.id))).toBe(t.id);
    expect(await resolveId(ctx, "task", shortHandle(t.id).toUpperCase())).toBe(t.id);
  });

  // Acting on the wrong record is worse than asking: agents must get the candidates back.
  it("reports AMBIGUOUS with candidates when a handle matches several records", async () => {
    const { ctx } = await setup();
    const taskIds = ["tsk_01JC000000000000000000ABCD", "tsk_01JD000000000000000000ABCD"];
    const withIds = {
      ...ctx,
      ids: (e: Parameters<typeof ctx.ids>[0]) =>
        e === "task" ? (taskIds.shift() ?? "") : ctx.ids(e),
    };
    const a = await createTask(withIds, { title: "a" });
    const b = await createTask(withIds, { title: "b" });
    const err = await resolveId(ctx, "task", "tsk_00abcd").catch((e) => e);
    expect(err.code).toBe("AMBIGUOUS");
    expect(err.details.candidates.map((c: { id: string }) => c.id).sort()).toEqual([a.id, b.id]);
    expect(await resolveId(ctx, "task", "tsk_1JC000000000000000000abcd")).toBe(a.id);
  });

  it("rejects the wrong kind of id and unknown handles", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    await expect(resolveId(ctx, "feature", t.id)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(resolveId(ctx, "task", "tsk_zzzzzz")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(resolveId(ctx, "task", "drop table")).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});
