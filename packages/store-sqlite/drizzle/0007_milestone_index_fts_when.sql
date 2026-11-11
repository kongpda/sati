CREATE INDEX `features_project_milestone` ON `features` (`project_id`,`milestone_id`);--> statement-breakpoint
CREATE INDEX `tasks_project_milestone` ON `tasks` (`project_id`,`milestone_id`);
--> statement-breakpoint
-- The update triggers rewrote the search row on every update, and most updates (a claim, a
--> statement-breakpoint
-- lease renewal, a status move) change no indexed text. They now run only when it changed.
--> statement-breakpoint
DROP TRIGGER `tasks_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_au` AFTER UPDATE ON `tasks`
WHEN OLD.deleted_at IS NOT NEW.deleted_at OR OLD.project_id IS NOT NEW.project_id
  OR json_extract(OLD.data, '$.title') IS NOT json_extract(NEW.data, '$.title')
  OR (json_extract(OLD.data, '$.body')) IS NOT (json_extract(NEW.data, '$.body'))
BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'task', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.body')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
DROP TRIGGER `features_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `features_fts_au` AFTER UPDATE ON `features`
WHEN OLD.deleted_at IS NOT NEW.deleted_at OR OLD.project_id IS NOT NEW.project_id
  OR json_extract(OLD.data, '$.title') IS NOT json_extract(NEW.data, '$.title')
  OR (json_extract(OLD.data, '$.description') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(OLD.data, '$.acceptance')), '')) IS NOT (json_extract(NEW.data, '$.description') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.acceptance')), ''))
BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'feature', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.description') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.acceptance')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
DROP TRIGGER `notes_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_au` AFTER UPDATE ON `notes`
WHEN OLD.deleted_at IS NOT NEW.deleted_at OR OLD.project_id IS NOT NEW.project_id
  OR json_extract(OLD.data, '$.title') IS NOT json_extract(NEW.data, '$.title')
  OR (json_extract(OLD.data, '$.body') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(OLD.data, '$.tags')), '')) IS NOT (json_extract(NEW.data, '$.body') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), ''))
BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'note', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.body') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
DROP TRIGGER `decisions_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `decisions_fts_au` AFTER UPDATE ON `decisions`
WHEN OLD.deleted_at IS NOT NEW.deleted_at OR OLD.project_id IS NOT NEW.project_id
  OR json_extract(OLD.data, '$.title') IS NOT json_extract(NEW.data, '$.title')
  OR (json_extract(OLD.data, '$.context') || ' ' || json_extract(OLD.data, '$.decision') || ' ' || json_extract(OLD.data, '$.consequences')) IS NOT (json_extract(NEW.data, '$.context') || ' ' || json_extract(NEW.data, '$.decision') || ' ' || json_extract(NEW.data, '$.consequences'))
BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'decision', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.context') || ' ' || json_extract(NEW.data, '$.decision') || ' ' || json_extract(NEW.data, '$.consequences')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
DROP TRIGGER `context_entries_fts_au`;
--> statement-breakpoint
CREATE TRIGGER `context_entries_fts_au` AFTER UPDATE ON `context_entries`
WHEN OLD.deleted_at IS NOT NEW.deleted_at OR OLD.project_id IS NOT NEW.project_id
  OR json_extract(OLD.data, '$.path') IS NOT json_extract(NEW.data, '$.path')
  OR (json_extract(OLD.data, '$.summary') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(OLD.data, '$.facts')), '') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(OLD.data, '$.tags')), '')) IS NOT (json_extract(NEW.data, '$.summary') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.facts')), '') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), ''))
BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'context', NEW.id, NEW.project_id, json_extract(NEW.data, '$.path'), json_extract(NEW.data, '$.summary') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.facts')), '') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), '')
  WHERE NEW.deleted_at IS NULL;
END;
