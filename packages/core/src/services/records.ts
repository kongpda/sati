import { SatiError } from "../domain/errors.js";
import type { EntityMap, StoredEntity } from "../domain/schemas.js";
import { CLI_NAME } from "../name.js";
import {
  actorName,
  isDeleted,
  nowIso,
  type ServiceContext,
  updateWithLog,
  writeTx,
} from "./context.js";
import { releaseTaskLocks } from "./lock.js";

/**
 * Records a person may delete and restore. Not decisions: one that is deleted stops protecting
 * its feature from removal, so a decision is append-only and a newer one supersedes it. Not
 * features: a shipped one is removed with a Decision and status `removed`.
 */
const SOFT = ["task", "note"] as const;
type Soft = (typeof SOFT)[number];

function isSoft(entity: string): entity is Soft {
  return (SOFT as readonly string[]).includes(entity);
}

/** Soft-deletes a task or note. */
export async function deleteRecord(
  ctx: ServiceContext,
  entity: StoredEntity,
  id: string,
): Promise<EntityMap[Soft]> {
  if (!isSoft(entity)) {
    throw new SatiError("USAGE", `${entity} cannot be deleted this way.`);
  }
  return writeTx(ctx, async (w) => {
    const rec = await w.get(entity, id);
    const projectId = rec && "projectId" in rec ? rec.projectId : undefined;
    if (!rec || projectId !== ctx.projectId || isDeleted(rec)) {
      throw new SatiError("NOT_FOUND", `No ${entity} with id ${id}.`, {
        hint: `Run \`${CLI_NAME} ${entity} list\` to see ids.`,
      });
    }
    if (entity === "task") {
      const claim = (rec as EntityMap["task"]).claim;
      if (claim) {
        // A live claim is someone's work in progress: only its holder or a person may delete it.
        if (claim.actorId !== ctx.actorId && claim.leaseUntil > nowIso(ctx)) {
          const caller = await w.get("actor", ctx.actorId);
          if (caller?.kind !== "human") {
            throw new SatiError(
              "CONFLICT",
              `Task ${id} is claimed by ${await actorName(w, claim.actorId)}.`,
              {
                hint: "Only the holder or a person can delete a claimed task; wait for the claim to expire or ask the holder to release it.",
                details: { holder: claim.actorId, leaseUntil: claim.leaseUntil },
              },
            );
          }
        }
        await releaseTaskLocks(w, ctx, id, claim.actorId);
      }
    }
    return updateWithLog(w, ctx, entity, rec, { deletedAt: nowIso(ctx) }, { verb: "delete" });
  });
}

/** Clears `deletedAt` on a soft-deleted record. */
export async function restoreRecord(
  ctx: ServiceContext,
  entity: StoredEntity,
  id: string,
): Promise<EntityMap[Soft]> {
  if (!isSoft(entity)) {
    throw new SatiError("USAGE", `${entity} cannot be restored this way.`);
  }
  return writeTx(ctx, async (w) => {
    const rec = await w.get(entity, id);
    const projectId = rec && "projectId" in rec ? rec.projectId : undefined;
    if (!rec || projectId !== ctx.projectId) {
      throw new SatiError("NOT_FOUND", `No ${entity} with id ${id}.`);
    }
    if (!isDeleted(rec)) {
      throw new SatiError("VALIDATION", `${entity} ${id} is not deleted.`);
    }
    return updateWithLog(w, ctx, entity, rec, { deletedAt: null }, { verb: "update" });
  });
}
