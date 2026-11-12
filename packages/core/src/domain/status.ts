export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const FEATURE_STATUSES = [
  "planned",
  "building",
  "shipped",
  "deprecated",
  "removed",
] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export const MILESTONE_STATUSES = ["planned", "active", "done", "cancelled"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

type Machine<S extends string> = Readonly<Record<S, readonly S[]>>;

export const TASK_TRANSITIONS: Machine<TaskStatus> = {
  backlog: ["todo", "blocked", "cancelled"],
  todo: ["backlog", "in_progress", "blocked", "cancelled"],
  in_progress: ["todo", "review", "done", "blocked", "cancelled"],
  review: ["todo", "in_progress", "done", "blocked", "cancelled"],
  blocked: ["backlog", "todo", "in_progress", "cancelled"],
  done: ["todo"],
  cancelled: ["backlog", "todo"],
};

export const FEATURE_TRANSITIONS: Machine<FeatureStatus> = {
  planned: ["building", "removed"],
  building: ["planned", "shipped", "removed"],
  shipped: ["deprecated", "removed"],
  deprecated: ["shipped", "removed"],
  removed: [],
};

export const MILESTONE_TRANSITIONS: Machine<MilestoneStatus> = {
  planned: ["active", "cancelled"],
  active: ["planned", "done", "cancelled"],
  done: ["active"],
  // Reopened as planned, never straight to done: its work was dropped, not finished.
  cancelled: ["planned"],
};

/** A feature that has been shipped can only be removed with a linked Decision. */
export function featureRemovalNeedsDecision(from: FeatureStatus, to: FeatureStatus): boolean {
  return to === "removed" && (from === "shipped" || from === "deprecated");
}
