import type { Feature, Priority } from "./schemas.js";
/** Sort order for priorities: lower ranks first. */
export declare const PRIORITY_RANK: Record<Priority, number>;
/**
 * Only shipped features are guarded (the PLAN rule: a shipped feature warns on change; shipped
 * and protected blocks deletion). The guard and the brief both use this, so they agree.
 */
export declare function isGuardedFeature(feature: Pick<Feature, "status">): boolean;
/**
 * Returns the cycle (as a list of task IDs, first repeated at the end) that adding
 * `taskId -> dependsOn` would create, or undefined if the graph stays acyclic.
 * `edges` gives the current dependsOn list of every other task.
 */
export declare function findDependencyCycle(taskId: string, dependsOn: readonly string[], edges: (id: string) => readonly string[] | undefined): string[] | undefined;
