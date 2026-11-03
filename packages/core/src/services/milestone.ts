import type { z } from "zod";
import { Milestone } from "../domain/schemas.js";
import { MILESTONE_TRANSITIONS } from "../domain/status.js";
import {
  assertTransition,
  baseFields,
  ExpectedVersion,
  insertWithLog,
  mustGet,
  parseInput,
  type ServiceContext,
  updateWithLog,
} from "./context.js";

const fields = Milestone.pick({
  title: true,
  goal: true,
  targetDate: true,
  status: true,
  order: true,
});
export const CreateMilestoneInput = fields.partial({
  goal: true,
  targetDate: true,
  status: true,
  order: true,
});
export const UpdateMilestoneInput = fields.partial().extend(ExpectedVersion);

export async function createMilestone(ctx: ServiceContext, input: unknown): Promise<Milestone> {
  const data = parseInput(CreateMilestoneInput, input);
  return ctx.store.write(async (w) => {
    const order = data.order ?? (await w.list("milestone", ctx.projectId, { limit: 500 })).length;
    return insertWithLog(w, ctx, "milestone", {
      ...baseFields(ctx, "milestone"),
      goal: "",
      targetDate: null,
      status: "planned",
      ...data,
      order,
    });
  });
}

export async function updateMilestone(
  ctx: ServiceContext,
  id: string,
  input: unknown,
): Promise<Milestone> {
  const { expectedVersion, ...patch } = parseInput(UpdateMilestoneInput, input);
  return ctx.store.write(async (w) => {
    const before = await mustGet(w, ctx, "milestone", id);
    if (patch.status)
      assertTransition(MILESTONE_TRANSITIONS, "milestone", before.status, patch.status);
    return updateWithLog(w, ctx, "milestone", before, patch, { expectedVersion });
  });
}

export type CreateMilestoneInput = z.input<typeof CreateMilestoneInput>;
