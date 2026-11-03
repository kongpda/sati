import type { z } from "zod";
import { Decision } from "../domain/schemas.js";
import { baseFields, insertWithLog, mustGet, parseInput, type ServiceContext } from "./context.js";

export const RecordDecisionInput = Decision.pick({
  title: true,
  context: true,
  decision: true,
  consequences: true,
  supersedes: true,
  featureIds: true,
})
  .partial({ context: true, consequences: true, supersedes: true, featureIds: true })
  .extend({ decision: Decision.shape.decision.min(1) });
export type RecordDecisionInput = z.input<typeof RecordDecisionInput>;

/** Decisions are append-only: to change one, record a new one that `supersedes` it. */
export async function recordDecision(ctx: ServiceContext, input: unknown): Promise<Decision> {
  const data = parseInput(RecordDecisionInput, input);
  return ctx.store.write(async (w) => {
    if (data.supersedes) await mustGet(w, ctx, "decision", data.supersedes);
    for (const featureId of data.featureIds ?? []) await mustGet(w, ctx, "feature", featureId);
    return insertWithLog(w, ctx, "decision", {
      ...baseFields(ctx, "decision"),
      context: "",
      consequences: "",
      supersedes: null,
      featureIds: [],
      ...data,
    });
  });
}
