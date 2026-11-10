import type { EntityMap, StoredEntity } from "../domain/schemas.js";
import { type ServiceContext } from "./context.js";
declare const SOFT: readonly ["task", "note", "decision", "feature"];
type Soft = (typeof SOFT)[number];
/** Soft-deletes a task, note or decision. A shipped feature still needs a Decision and `removed`. */
export declare function deleteRecord(ctx: ServiceContext, entity: StoredEntity, id: string): Promise<EntityMap[Soft]>;
/** Clears `deletedAt` on a soft-deleted record. */
export declare function restoreRecord(ctx: ServiceContext, entity: StoredEntity, id: string): Promise<EntityMap[Soft]>;
export {};
