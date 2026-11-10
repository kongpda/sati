-- Released locks stay as tombstones, and every lock check reads only live rows inside the write
-- lock. These partial indexes skip the tombstones; the second finds a task's locks by its id.
--> statement-breakpoint
-- Written by hand: drizzle-kit splits the json_extract expression at its comma.
--> statement-breakpoint
CREATE INDEX `locks_live` ON `locks` (`project_id`,`rank`,`id`) WHERE `deleted_at` IS NULL;--> statement-breakpoint
CREATE INDEX `locks_live_task` ON `locks` (`project_id`,json_extract(`data`, '$.taskId')) WHERE `deleted_at` IS NULL;
