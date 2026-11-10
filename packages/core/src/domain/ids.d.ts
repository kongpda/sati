export declare const ID_PREFIXES: {
    readonly project: "prj";
    readonly milestone: "mil";
    readonly feature: "feat";
    readonly task: "tsk";
    readonly lock: "lck";
    readonly decision: "dec";
    readonly note: "note";
    readonly context: "ctx";
    readonly activity: "act";
    readonly actor: "actr";
};
export type EntityName = keyof typeof ID_PREFIXES;
export type IdFactory = (entity: EntityName) => string;
/** Monotonic ULIDs keep IDs sortable even when many are made in the same millisecond. */
export declare function createIdFactory(now?: () => number): IdFactory;
export declare function parseId(id: string): {
    prefix: string;
    ulid: string;
} | undefined;
/**
 * Short display handle, e.g. `tsk_8f3k2a`: the prefix plus the last 6 characters
 * (random part) of the ULID, lowercased. Not guaranteed unique; lookups must
 * report ambiguity.
 */
export declare function shortHandle(id: string): string;
/** Matches `tsk_8f3k2a` style input (case-insensitive). */
export declare function parseHandle(input: string): {
    prefix: string;
    suffix: string;
} | undefined;
