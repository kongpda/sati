import type { z } from "zod";
import { BodyText, Decision } from "../domain/schemas.js";
import { refuseSecrets } from "../domain/secrets.js";
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
  .extend({
    context: BodyText.optional(),
    decision: BodyText.min(1),
    consequences: BodyText.optional(),
  });
export type RecordDecisionInput = z.input<typeof RecordDecisionInput>;

/** Decisions are append-only: to change one, record a new one that `supersedes` it. */
export async function recordDecision(ctx: ServiceContext, input: unknown): Promise<Decision> {
  const data = parseInput(RecordDecisionInput, input);
  refuseSecrets("decision", data);
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
