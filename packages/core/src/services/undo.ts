import { SatiError } from "../domain/errors.js";
import type { StoredEntity, Task } from "../domain/schemas.js";
import { CLI_NAME } from "../name.js";
import { isCompacted, nowIso, type ServiceContext, updateWithLog } from "./context.js";

const COORDINATION = new Set(["claim", "release", "complete"]);

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
    // Claims, releases, completions and locks are coordination state: replaying an old value
    // would steal a claim or bring back a lock without the overlap and fencing checks.
    if (act.entity === "lock" || COORDINATION.has(act.verb)) {
      throw new SatiError("VALIDATION", `A ${act.verb} of a ${act.entity} cannot be undone.`, {
        hint: `Use the ${act.entity} commands instead, such as \`${CLI_NAME} task update\`.`,
      });
    }
    if (Object.hasOwn(act.diff, "claim")) {
      throw new SatiError(
        "VALIDATION",
        `A change to the claim of a ${act.entity} cannot be undone.`,
        {
          hint: `Use \`${CLI_NAME} task claim\` or \`${CLI_NAME} task release\` instead.`,
        },
      );
    }
    const current = await w.get(act.entity, act.entityId);
    if (!current) throw new SatiError("NOT_FOUND", `The ${act.entity} from that activity is gone.`);
    if (act.entity === "task") {
      const holder = (current as Task).claim?.actorId;
      if (holder !== undefined && holder !== ctx.actorId) {
        throw new SatiError("CONFLICT", `Task ${act.entityId} is claimed by ${holder}.`, {
          hint: "Undo it after the claim is released.",
          details: { holder },
        });
      }
    }
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
      // The log keeps only the length of long text, so there is nothing real to write back.
      if (isCompacted(change.from) || isCompacted(change.to)) {
        throw new SatiError(
          "VALIDATION",
          `${act.entity} ${act.entityId}: field "${key}" was too long to keep in the log, so it cannot be undone.`,
          { hint: "Restore the text by hand, or from git history." },
        );
      }
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
