import { z } from "zod";
import { type EntityMap } from "../domain/schemas.js";
import { type ServiceContext } from "./context.js";
/** The records the git snapshot carries. Actors, locks and activity stay machine-local. */
export declare const SNAPSHOT_ENTITIES: readonly ["milestone", "feature", "task", "decision", "note", "context"];
export type SnapshotEntity = (typeof SNAPSHOT_ENTITIES)[number];
/** Folder of each entity under `.sati/`. */
export declare const SNAPSHOT_DIRS: Record<SnapshotEntity, string>;
export type SnapshotRecord = {
    [E in SnapshotEntity]: {
        entity: E;
        record: EntityMap[E];
    };
}[SnapshotEntity];
/** True for a private note or card, which never leaves this machine's database. */
export declare const isPrivate: (record: object) => boolean;
/** Every snapshot record of the project except private ones, soft-deleted ones as tombstones. */
export declare function snapshotRecords(ctx: ServiceContext): Promise<SnapshotRecord[]>;
export declare const ImportRecordsInput: z.ZodArray<z.ZodObject<{
    entity: z.ZodEnum<{
        context: "context";
        decision: "decision";
        feature: "feature";
        milestone: "milestone";
        note: "note";
        task: "task";
    }>;
    source: z.ZodString;
    record: z.ZodUnknown;
}, z.core.$strict>>;
export type ImportRecordsInput = z.input<typeof ImportRecordsInput>;
export interface ImportResult {
    imported: {
        entity: SnapshotEntity;
        id: string;
        version: number;
    }[];
    unchanged: number;
    /**
     * Cycles and broken links among the imported tasks. A merge can make them, so the import does
     * not refuse (that would stop every git hook until someone edited `.sati/` by hand); it says so.
     */
    problems: string[];
}
/**
 * Upserts snapshot records into the DB in one transaction: new records are inserted, and stored
 * ones are replaced when the incoming copy is newer. Every record is validated first; one bad
 * record rejects the whole import. Each imported record writes an `import` activity row.
 */
export declare function importRecords(ctx: ServiceContext, input: unknown): Promise<ImportResult>;
