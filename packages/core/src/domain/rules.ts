import type { Feature, Priority } from "./schemas.js";

/** Sort order for priorities: lower ranks first. */
export const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * Only shipped features are guarded (the PLAN rule: a shipped feature warns on change; shipped
 * and protected blocks deletion). The guard and the brief both use this, so they agree.
 */
export function isGuardedFeature(feature: Pick<Feature, "status">): boolean {
  return feature.status === "shipped";
}

/**
 * Returns the cycle (as a list of task IDs, first repeated at the end) that adding
 * `taskId -> dependsOn` would create, or undefined if the graph stays acyclic.
 * `edges` gives the current dependsOn list of every other task.
 */
export function findDependencyCycle(
  taskId: string,
  dependsOn: readonly string[],
  edges: (id: string) => readonly string[] | undefined,
): string[] | undefined {
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (id: string, path: string[]): string[] | undefined => {
    if (id === taskId) return [...path, id];
    if (done.has(id) || visiting.has(id)) return undefined;
    visiting.add(id);
    for (const next of edges(id) ?? []) {
      const cycle = visit(next, [...path, id]);
      if (cycle) return cycle;
    }
    visiting.delete(id);
    done.add(id);
    return undefined;
  };

  for (const dep of dependsOn) {
    const cycle = visit(dep, [taskId]);
    if (cycle) return cycle;
  }
  return undefined;
}
