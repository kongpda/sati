import type { z } from "zod";
import { BodyText, Decision } from "../domain/schemas.js";
import { refuseSecrets } from "../domain/secrets.js";
import type { StorageReader } from "../ports/storage.js";
import {
  baseFields,
  insertWithLog,
  listAll,
  mustGet,
  parseInput,
  type ServiceContext,
  writeTx,
} from "./context.js";

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
  return writeTx(ctx, async (w) => {
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

/**
 * For each of `ids`, the newest decision whose `supersedes` names it. Reads every decision, so
 * call it only when one is about to be shown.
 */
export async function supersededBy(
  r: StorageReader,
  ctx: ServiceContext,
  ids: readonly string[],
): Promise<Map<string, Decision>> {
  const out = new Map<string, Decision>();
  if (ids.length === 0) return out;
  const want = new Set(ids);
  // listAll pages in id order, so a later decision overwrites an earlier one.
  for (const d of await listAll(r, ctx, "decision")) {
    if (d.supersedes && want.has(d.supersedes)) out.set(d.supersedes, d);
  }
  return out;
}

export interface DecisionView extends Decision {
  /** The decision that replaced this one, if any. */
  supersededBy: { id: string; title: string } | null;
}

/** One decision, with the decision that replaced it. */
export async function getDecision(ctx: ServiceContext, decisionId: string): Promise<DecisionView> {
  return ctx.store.read(async (r) => {
    const d = await mustGet(r, ctx, "decision", decisionId);
    const next = (await supersededBy(r, ctx, [d.id])).get(d.id);
    return { ...d, supersededBy: next ? { id: next.id, title: next.title } : null };
  });
}
