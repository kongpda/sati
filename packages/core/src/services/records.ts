import { SatiError } from "../domain/errors.js";
import type { EntityMap, StoredEntity } from "../domain/schemas.js";
import { featureRemovalNeedsDecision } from "../domain/status.js";
import { CLI_NAME } from "../name.js";
import { actorName, nowIso, type ServiceContext, updateWithLog } from "./context.js";
import { releaseTaskLocks } from "./lock.js";

const SOFT = ["task", "note", "decision", "feature"] as const;
type Soft = (typeof SOFT)[number];

function isSoft(entity: string): entity is Soft {
  return (SOFT as readonly string[]).includes(entity);
}

/** Soft-deletes a task, note or decision. A shipped feature still needs a Decision and `removed`. */
export async function deleteRecord(
  ctx: ServiceContext,
  entity: StoredEntity,
  id: string,
): Promise<EntityMap[Soft]> {
  if (!isSoft(entity)) {
    throw new SatiError("USAGE", `${entity} cannot be deleted this way.`);
  }
  return ctx.store.write(async (w) => {
    const rec = await w.get(entity, id);
    const projectId = rec && "projectId" in rec ? rec.projectId : undefined;
    if (!rec || projectId !== ctx.projectId || rec.deletedAt !== null) {
      throw new SatiError("NOT_FOUND", `No ${entity} with id ${id}.`, {
        hint: `Run \`${CLI_NAME} ${entity} list\` to see ids.`,
      });
    }
    if (entity === "feature") {
      const feature = rec as EntityMap["feature"];
      if (featureRemovalNeedsDecision(feature.status, "removed")) {
        throw new SatiError(
          "VALIDATION",
          `A ${feature.status} feature is removed with a Decision.`,
          {
            hint:
              `Run \`${CLI_NAME} decision record --features ${id}\`, then ` +
              `\`${CLI_NAME} feature update ${id} --status removed --decision <id>\`.`,
          },
        );
      }
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
  return ctx.store.write(async (w) => {
    const rec = await w.get(entity, id);
    const projectId = rec && "projectId" in rec ? rec.projectId : undefined;
    if (!rec || projectId !== ctx.projectId) {
      throw new SatiError("NOT_FOUND", `No ${entity} with id ${id}.`);
    }
    if (rec.deletedAt === null) {
      throw new SatiError("VALIDATION", `${entity} ${id} is not deleted.`);
    }
    return updateWithLog(w, ctx, entity, rec, { deletedAt: null }, { verb: "update" });
  });
}
