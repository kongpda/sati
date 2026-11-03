import { z } from "zod";
import type { EntityMap, StoredEntity } from "../domain/schemas.js";
import { FEATURE_STATUSES, MILESTONE_STATUSES, TASK_STATUSES } from "../domain/status.js";
import type { ListQuery } from "../ports/storage.js";
import { mustGet, parseInput, type ServiceContext } from "./context.js";

const STATUSES: Partial<Record<StoredEntity, readonly [string, ...string[]]>> = {
  task: TASK_STATUSES,
  feature: FEATURE_STATUSES,
  milestone: MILESTONE_STATUSES,
};

const id = z.string().max(60);

export function listInput(entity: StoredEntity) {
  const statuses = STATUSES[entity];
  return z.strictObject({
    status: z
      .array(statuses ? z.enum(statuses) : z.never())
      .max(10)
      .optional(),
    featureId: id.optional(),
    milestoneId: id.optional(),
    parentId: id.optional(),
    label: z.string().max(100).optional(),
    includeDeleted: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  });
}

export async function getRecord<E extends StoredEntity>(
  ctx: ServiceContext,
  entity: E,
  recordId: string,
): Promise<EntityMap[E]> {
  return ctx.store.read((r) => mustGet(r, ctx, entity, recordId));
}

export async function listRecords<E extends StoredEntity>(
  ctx: ServiceContext,
  entity: E,
  input: unknown = {},
): Promise<EntityMap[E][]> {
  const query: ListQuery = parseInput(listInput(entity), input);
  return ctx.store.read((r) => r.list(entity, ctx.projectId, query));
}
