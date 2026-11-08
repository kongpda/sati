import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { BodyText, DecisionId, Feature } from "../domain/schemas.js";
import { FEATURE_TRANSITIONS, featureRemovalNeedsDecision } from "../domain/status.js";
import { CLI_NAME } from "../name.js";
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

const fields = Feature.pick({
  title: true,
  description: true,
  status: true,
  protected: true,
  paths: true,
  tests: true,
  acceptance: true,
  milestoneId: true,
}).extend({ description: BodyText });
export const CreateFeatureInput = fields.partial({
  description: true,
  status: true,
  protected: true,
  paths: true,
  tests: true,
  acceptance: true,
  milestoneId: true,
});
export const UpdateFeatureInput = fields.partial().extend({
  ...ExpectedVersion,
  decisionId: DecisionId.optional(),
  reviewed: z.literal(true).optional(),
});
export type CreateFeatureInput = z.input<typeof CreateFeatureInput>;
export type UpdateFeatureInput = z.input<typeof UpdateFeatureInput>;

export async function createFeature(ctx: ServiceContext, input: unknown): Promise<Feature> {
  const data = parseInput(CreateFeatureInput, input);
  return ctx.store.write(async (w) => {
    if (data.milestoneId) await mustGet(w, ctx, "milestone", data.milestoneId);
    return insertWithLog(w, ctx, "feature", {
      ...baseFields(ctx, "feature"),
      description: "",
      status: "planned",
      protected: false,
      paths: [],
      tests: [],
      acceptance: [],
      milestoneId: null,
      ...data,
    });
  });
}

/**
 * Updates a feature. Removing a shipped or deprecated feature needs `decisionId`: a Decision
 * that lists this feature, so the reason for the removal is on record.
 */
export async function updateFeature(
  ctx: ServiceContext,
  id: string,
  input: unknown,
): Promise<Feature> {
  const { expectedVersion, decisionId, reviewed, ...patch } = parseInput(UpdateFeatureInput, input);
  return ctx.store.write(async (w) => {
    const before = await mustGet(w, ctx, "feature", id);
    if (patch.milestoneId) await mustGet(w, ctx, "milestone", patch.milestoneId);
    if (patch.status) {
      assertTransition(FEATURE_TRANSITIONS, "feature", before.status, patch.status);
      if (featureRemovalNeedsDecision(before.status, patch.status)) {
        const hint = `Record one first: \`${CLI_NAME} decision record --features ${id}\`, then pass its id.`;
        if (!decisionId) {
          throw new SatiError(
            "VALIDATION",
            `Removing a ${before.status} feature needs a Decision.`,
            { hint },
          );
        }
        const decision = await mustGet(w, ctx, "decision", decisionId);
        if (!decision.featureIds.includes(id)) {
          throw new SatiError("VALIDATION", `Decision ${decisionId} does not list feature ${id}.`, {
            hint,
          });
        }
      }
    }
    return updateWithLog(w, ctx, "feature", before, patch, {
      expectedVersion,
      clear: reviewed ? ["needsReview"] : [],
    });
  });
}
