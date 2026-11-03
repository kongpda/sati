import type { Task } from "./schemas.js";

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

export function isClaimActive(task: Pick<Task, "claim">, now: Date): boolean {
  return task.claim !== null && Date.parse(task.claim.leaseUntil) > now.getTime();
}

/** Ready = `todo`, not actively claimed, and every dependency is `done`. */
export function isReady(
  task: Pick<Task, "status" | "claim" | "dependsOn" | "deletedAt">,
  depStatus: (id: string) => Task["status"] | undefined,
  now: Date,
): boolean {
  if (task.deletedAt !== null || task.status !== "todo") return false;
  if (isClaimActive(task, now)) return false;
  return task.dependsOn.every((id) => depStatus(id) === "done");
}
