import { describe, expect, it } from "vitest";
import { createTask, findSimilarTasks, updateTask } from "../src/index.js";
import { setup } from "./support/setup.js";

// Two agents filing the same work under slightly different titles is the duplicate we want to catch;
// tasks that only share a common word must not be flagged, or agents learn to ignore the warning.
describe("findSimilarTasks", () => {
  it("flags a reworded title of an existing task and ignores tasks sharing one common word", async () => {
    const { ctx } = await setup();
    const login = await createTask(ctx, { title: "Fix login redirect loop" });
    await createTask(ctx, { title: "Login page styling" });
    await createTask(ctx, { title: "Redirect old blog URLs" });
    const similar = await findSimilarTasks(ctx, { title: "Login redirect loop after OAuth" });
    expect(similar.map((s) => s.id)).toEqual([login.id]);
    expect(similar[0]).toMatchObject({ status: "todo", title: "Fix login redirect loop" });
    expect(similar[0]?.score).toBeGreaterThanOrEqual(0.5);
  });

  // PLAN Phase 9e: a title without spaces was one word, so a reworded duplicate scored 0.
  it("flags a reworded Thai or Chinese title", async () => {
    const { ctx } = await setup();
    const thai = await createTask(ctx, { title: "จองห้องประชุมสำหรับงานเปิดตัว" });
    const chinese = await createTask(ctx, { title: "预订发布会的会议室" });
    await createTask(ctx, { title: "ส่งใบแจ้งหนี้" });
    expect(
      (await findSimilarTasks(ctx, { title: "จองห้องประชุมงานเปิดตัว" })).map((s) => s.id),
    ).toEqual([thai.id]);
    expect((await findSimilarTasks(ctx, { title: "发布会会议室预订" })).map((s) => s.id)).toEqual([
      chinese.id,
    ]);
  });

  it("keeps done tasks (redoing them is duplicate work) but skips cancelled ones", async () => {
    const { ctx } = await setup();
    const a = await createTask(ctx, { title: "Export tasks to CSV" });
    const b = await createTask(ctx, { title: "Export tasks as CSV file" });
    await updateTask(ctx, b.id, { status: "cancelled" });
    expect(
      (await findSimilarTasks(ctx, { title: "CSV export of tasks" })).map((s) => s.id),
    ).toEqual([a.id]);
  });

  it("returns nothing for a title made only of common words", async () => {
    const { ctx } = await setup();
    await createTask(ctx, { title: "Add the new thing" });
    expect(await findSimilarTasks(ctx, { title: "add the new" })).toEqual([]);
  });
});
