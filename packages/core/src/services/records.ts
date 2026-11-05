import { SatiError } from "../domain/errors.js";
import type { EntityMap, StoredEntity } from "../domain/schemas.js";
import { featureRemovalNeedsDecision } from "../domain/status.js";
import { CLI_NAME } from "../name.js";
import { nowIso, type ServiceContext, updateWithLog } from "./context.js";

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
              `Run \`${CLI_NAME} decision record --feature ${id}\`, then ` +
              `\`${CLI_NAME} feature update ${id} --status removed --decision <id>\`.`,
          },
        );
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
