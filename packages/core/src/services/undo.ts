import { SatiError } from "../domain/errors.js";
import type { StoredEntity } from "../domain/schemas.js";
import { CLI_NAME } from "../name.js";
import { nowIso, type ServiceContext, updateWithLog } from "./context.js";

const ENTITIES = new Set<StoredEntity>([
  "project",
  "milestone",
  "feature",
  "task",
  "lock",
  "decision",
  "note",
  "context",
  "actor",
]);

function isEntity(value: string): value is StoredEntity {
  return ENTITIES.has(value as StoredEntity);
}

function pair(value: unknown): { from: unknown; to: unknown } | undefined {
  if (value === null || typeof value !== "object" || !("from" in value) || !("to" in value)) {
    return undefined;
  }
  return value as { from: unknown; to: unknown };
}

/**
 * Reverts one activity row when every field it changed still has the value that row wrote.
 * The revert is its own activity row. A later edit is CONFLICT.
 */
export async function undoActivity(ctx: ServiceContext, activityId: string) {
  return ctx.store.write(async (w) => {
    const act = await w.getActivity(activityId);
    if (!act || act.projectId !== ctx.projectId) {
      throw new SatiError("NOT_FOUND", `No activity ${activityId}.`, {
        hint: `Run \`${CLI_NAME} activity\` to see ids.`,
      });
    }
    if (!isEntity(act.entity)) {
      throw new SatiError("VALIDATION", `Activity ${activityId} is not a record change.`);
    }
    const current = await w.get(act.entity, act.entityId);
    if (!current) throw new SatiError("NOT_FOUND", `The ${act.entity} from that activity is gone.`);
    if (act.verb === "create") {
      if (current.version !== 1 || current.deletedAt !== null) {
        throw new SatiError(
          "CONFLICT",
          "That create has been changed since, so it cannot be undone.",
        );
      }
      return updateWithLog(
        w,
        ctx,
        act.entity,
        current,
        { deletedAt: nowIso(ctx) },
        { verb: "delete" },
      );
    }
    const patch: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(act.diff)) {
      const change = pair(raw);
      if (!change) continue;
      const now = (current as unknown as Record<string, unknown>)[key];
      if (JSON.stringify(now) !== JSON.stringify(change.to)) {
        throw new SatiError(
          "CONFLICT",
          `${act.entity} ${act.entityId} changed after ${activityId}.`,
          { hint: "Undo only the latest write, or edit the record by hand." },
        );
      }
      patch[key] = change.from;
    }
    if (Object.keys(patch).length === 0) {
      throw new SatiError("VALIDATION", `Activity ${activityId} has no field change to revert.`);
    }
    return updateWithLog(w, ctx, act.entity, current, patch, { verb: "update" });
  });
}
