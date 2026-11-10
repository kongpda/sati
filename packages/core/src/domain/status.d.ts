export declare const TASK_STATUSES: readonly ["backlog", "todo", "in_progress", "review", "done", "blocked", "cancelled"];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export declare const FEATURE_STATUSES: readonly ["planned", "building", "shipped", "deprecated", "removed"];
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];
export declare const MILESTONE_STATUSES: readonly ["planned", "active", "done"];
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];
type Machine<S extends string> = Readonly<Record<S, readonly S[]>>;
export declare const TASK_TRANSITIONS: Machine<TaskStatus>;
export declare const FEATURE_TRANSITIONS: Machine<FeatureStatus>;
export declare const MILESTONE_TRANSITIONS: Machine<MilestoneStatus>;
/** A feature that has been shipped can only be removed with a linked Decision. */
export declare function featureRemovalNeedsDecision(from: FeatureStatus, to: FeatureStatus): boolean;
export {};
