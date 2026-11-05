import { describe, expect, it } from "vitest";
import { claimNext, createTask, ensureActor } from "../src/index.js";
import { setup } from "./support/setup.js";

const steps = Number(process.env.SATI_E2E_STEPS ?? 200);
const repeat = Number(process.env.SATI_E2E_REPEAT ?? 1);

describe("four agents claim without collisions", () => {
  it(`runs ${repeat} time(s), ${steps} claims each`, async () => {
    for (let run = 0; run < repeat; run++) {
      const { ctx } = await setup();
      const actors = [ctx];
      for (const name of ["b@test", "c@test", "d@test"]) {
        const actor = await ensureActor(ctx, { name, kind: "agent" });
        actors.push({ ...ctx, actorId: actor.id });
      }
      for (let i = 0; i < steps; i++) await createTask(ctx, { title: `t${run}-${i}` });
      const seen = new Set<string>();
      const pending = [];
      for (let i = 0; i < steps; i++) {
        pending.push(claimNext(actors[i % actors.length] ?? ctx).then((got) => got.task.id));
        if (pending.length === actors.length || i === steps - 1) {
          const ids = await Promise.all(pending);
          for (const id of ids) {
            expect(seen.has(id)).toBe(false);
            seen.add(id);
          }
          pending.length = 0;
        }
      }
      expect(seen.size).toBe(steps);
    }
  }, 30_000);
});
