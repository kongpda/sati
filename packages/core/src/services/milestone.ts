import type { z } from "zod";
import { Milestone } from "../domain/schemas.js";
import { refuseSecrets } from "../domain/secrets.js";
import { MILESTONE_TRANSITIONS } from "../domain/status.js";
import type { StorageWriter } from "../ports/storage.js";
import {
  assertTransition,
  baseFields,
  ExpectedVersion,
  insertWithLog,
  listAll,
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
  return ctx.store.write((w) => createMilestoneIn(w, ctx, data));
}

/** `createMilestone` inside a caller's transaction. */
export async function createMilestoneIn(
  w: StorageWriter,
  ctx: ServiceContext,
  data: z.output<typeof CreateMilestoneInput>,
): Promise<Milestone> {
  // Here, not in createMilestone: plan import and templates create milestones through this too.
  refuseSecrets("milestone", data);
  {
    // max+1, not a count: gaps would otherwise hand out a duplicate order.
    // Only when no order was given: a plan import passes one for each of its milestones.
    const order =
      data.order ??
      (await listAll(w, ctx, "milestone")).reduce((max, m) => Math.max(max, m.order), -1) + 1;
    return insertWithLog(w, ctx, "milestone", {
      ...baseFields(ctx, "milestone"),
      goal: "",
      targetDate: null,
      status: "planned",
      ...data,
      order,
    });
  }
}

export async function updateMilestone(
  ctx: ServiceContext,
  id: string,
  input: unknown,
): Promise<Milestone> {
  const { expectedVersion, ...patch } = parseInput(UpdateMilestoneInput, input);
  refuseSecrets("milestone", patch);
  return ctx.store.write(async (w) => {
    const before = await mustGet(w, ctx, "milestone", id);
    if (patch.status)
      assertTransition(MILESTONE_TRANSITIONS, "milestone", before.status, patch.status);
    return updateWithLog(w, ctx, "milestone", before, patch, { expectedVersion });
  });
}

export type CreateMilestoneInput = z.input<typeof CreateMilestoneInput>;
