-- Notes have no status, so the column now marks handoff notes: 'handoff' while unread and
--> statement-breakpoint
-- 'handoff_read' once acknowledged. A claim then finds its task's handoff by index.
--> statement-breakpoint
UPDATE `notes` SET `status` = CASE WHEN json_extract(`data`, '$.acknowledged') IS NULL THEN 'handoff' ELSE 'handoff_read' END WHERE EXISTS (SELECT 1 FROM json_each(`notes`.`data`, '$.tags') WHERE `value` = 'handoff');
