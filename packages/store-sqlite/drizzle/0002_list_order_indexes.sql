DROP INDEX `actors_project_status`;--> statement-breakpoint
CREATE INDEX `actors_project_rank` ON `actors` (`project_id`,`rank`,`id`);--> statement-breakpoint
CREATE INDEX `actors_project_status` ON `actors` (`project_id`,`status`,`rank`,`id`);--> statement-breakpoint
DROP INDEX `context_entries_project_status`;--> statement-breakpoint
CREATE INDEX `context_entries_project_rank` ON `context_entries` (`project_id`,`rank`,`id`);--> statement-breakpoint
CREATE INDEX `context_entries_project_status` ON `context_entries` (`project_id`,`status`,`rank`,`id`);--> statement-breakpoint
DROP INDEX `decisions_project_status`;--> statement-breakpoint
CREATE INDEX `decisions_project_rank` ON `decisions` (`project_id`,`rank`,`id`);--> statement-breakpoint
CREATE INDEX `decisions_project_status` ON `decisions` (`project_id`,`status`,`rank`,`id`);--> statement-breakpoint
DROP INDEX `features_project_status`;--> statement-breakpoint
CREATE INDEX `features_project_rank` ON `features` (`project_id`,`rank`,`id`);--> statement-breakpoint
CREATE INDEX `features_project_status` ON `features` (`project_id`,`status`,`rank`,`id`);--> statement-breakpoint
DROP INDEX `locks_project_status`;--> statement-breakpoint
CREATE INDEX `locks_project_rank` ON `locks` (`project_id`,`rank`,`id`);--> statement-breakpoint
CREATE INDEX `locks_project_status` ON `locks` (`project_id`,`status`,`rank`,`id`);--> statement-breakpoint
DROP INDEX `milestones_project_status`;--> statement-breakpoint
CREATE INDEX `milestones_project_rank` ON `milestones` (`project_id`,`rank`,`id`);--> statement-breakpoint
CREATE INDEX `milestones_project_status` ON `milestones` (`project_id`,`status`,`rank`,`id`);--> statement-breakpoint
DROP INDEX `notes_project_status`;--> statement-breakpoint
CREATE INDEX `notes_project_rank` ON `notes` (`project_id`,`rank`,`id`);--> statement-breakpoint
CREATE INDEX `notes_project_status` ON `notes` (`project_id`,`status`,`rank`,`id`);--> statement-breakpoint
DROP INDEX `projects_project_status`;--> statement-breakpoint
CREATE INDEX `projects_project_rank` ON `projects` (`project_id`,`rank`,`id`);--> statement-breakpoint
CREATE INDEX `projects_project_status` ON `projects` (`project_id`,`status`,`rank`,`id`);--> statement-breakpoint
DROP INDEX `tasks_project_status`;--> statement-breakpoint
CREATE INDEX `tasks_project_rank` ON `tasks` (`project_id`,`rank`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_project_status` ON `tasks` (`project_id`,`status`,`rank`,`id`);