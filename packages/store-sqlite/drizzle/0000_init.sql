CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`at` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_project_at` ON `activity` (`project_id`,`at`);--> statement-breakpoint
CREATE INDEX `activity_entity` ON `activity` (`entity_id`,`at`);--> statement-breakpoint
CREATE INDEX `activity_actor` ON `activity` (`actor_id`,`at`);--> statement-breakpoint
CREATE TABLE `actors` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text,
	`status` text,
	`feature_id` text,
	`milestone_id` text,
	`parent_id` text,
	`claim_lease_until` text,
	`rank` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`version` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `actors_project_status` ON `actors` (`project_id`,`status`,`rank`);--> statement-breakpoint
CREATE INDEX `actors_project_feature` ON `actors` (`project_id`,`feature_id`);--> statement-breakpoint
CREATE INDEX `actors_project_updated` ON `actors` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `actors_project_key` ON `actors` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `context_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text,
	`status` text,
	`feature_id` text,
	`milestone_id` text,
	`parent_id` text,
	`claim_lease_until` text,
	`rank` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`version` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `context_entries_project_status` ON `context_entries` (`project_id`,`status`,`rank`);--> statement-breakpoint
CREATE INDEX `context_entries_project_feature` ON `context_entries` (`project_id`,`feature_id`);--> statement-breakpoint
CREATE INDEX `context_entries_project_updated` ON `context_entries` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `context_entries_project_key` ON `context_entries` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text,
	`status` text,
	`feature_id` text,
	`milestone_id` text,
	`parent_id` text,
	`claim_lease_until` text,
	`rank` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`version` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `decisions_project_status` ON `decisions` (`project_id`,`status`,`rank`);--> statement-breakpoint
CREATE INDEX `decisions_project_feature` ON `decisions` (`project_id`,`feature_id`);--> statement-breakpoint
CREATE INDEX `decisions_project_updated` ON `decisions` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_project_key` ON `decisions` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `features` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text,
	`status` text,
	`feature_id` text,
	`milestone_id` text,
	`parent_id` text,
	`claim_lease_until` text,
	`rank` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`version` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `features_project_status` ON `features` (`project_id`,`status`,`rank`);--> statement-breakpoint
CREATE INDEX `features_project_feature` ON `features` (`project_id`,`feature_id`);--> statement-breakpoint
CREATE INDEX `features_project_updated` ON `features` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `features_project_key` ON `features` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `locks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text,
	`status` text,
	`feature_id` text,
	`milestone_id` text,
	`parent_id` text,
	`claim_lease_until` text,
	`rank` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`version` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `locks_project_status` ON `locks` (`project_id`,`status`,`rank`);--> statement-breakpoint
CREATE INDEX `locks_project_feature` ON `locks` (`project_id`,`feature_id`);--> statement-breakpoint
CREATE INDEX `locks_project_updated` ON `locks` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `locks_project_key` ON `locks` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text,
	`status` text,
	`feature_id` text,
	`milestone_id` text,
	`parent_id` text,
	`claim_lease_until` text,
	`rank` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`version` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `milestones_project_status` ON `milestones` (`project_id`,`status`,`rank`);--> statement-breakpoint
CREATE INDEX `milestones_project_feature` ON `milestones` (`project_id`,`feature_id`);--> statement-breakpoint
CREATE INDEX `milestones_project_updated` ON `milestones` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `milestones_project_key` ON `milestones` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text,
	`status` text,
	`feature_id` text,
	`milestone_id` text,
	`parent_id` text,
	`claim_lease_until` text,
	`rank` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`version` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notes_project_status` ON `notes` (`project_id`,`status`,`rank`);--> statement-breakpoint
CREATE INDEX `notes_project_feature` ON `notes` (`project_id`,`feature_id`);--> statement-breakpoint
CREATE INDEX `notes_project_updated` ON `notes` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `notes_project_key` ON `notes` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text,
	`status` text,
	`feature_id` text,
	`milestone_id` text,
	`parent_id` text,
	`claim_lease_until` text,
	`rank` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`version` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_project_status` ON `projects` (`project_id`,`status`,`rank`);--> statement-breakpoint
CREATE INDEX `projects_project_feature` ON `projects` (`project_id`,`feature_id`);--> statement-breakpoint
CREATE INDEX `projects_project_updated` ON `projects` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_project_key` ON `projects` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text,
	`status` text,
	`feature_id` text,
	`milestone_id` text,
	`parent_id` text,
	`claim_lease_until` text,
	`rank` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`version` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_project_status` ON `tasks` (`project_id`,`status`,`rank`);--> statement-breakpoint
CREATE INDEX `tasks_project_feature` ON `tasks` (`project_id`,`feature_id`);--> statement-breakpoint
CREATE INDEX `tasks_project_updated` ON `tasks` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_key` ON `tasks` (`project_id`,`key`);--> statement-breakpoint
CREATE INDEX `tasks_claim_lease` ON `tasks` (`claim_lease_until`);--> statement-breakpoint
CREATE INDEX `tasks_parent` ON `tasks` (`parent_id`);