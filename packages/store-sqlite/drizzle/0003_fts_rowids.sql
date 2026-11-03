-- Gives each indexed record a stable FTS rowid, so updates and deletes find its index row
--> statement-breakpoint
-- by rowid instead of scanning the index for the UNINDEXED `id` column.
--> statement-breakpoint
CREATE TABLE `search_rowids` (`rowid` integer PRIMARY KEY, `id` text NOT NULL UNIQUE);
--> statement-breakpoint
INSERT INTO `search_rowids` (`rowid`, `id`) SELECT rowid, id FROM search_fts;
--> statement-breakpoint
DROP TRIGGER `tasks_fts_ai`;
--> statement-breakpoint
DROP TRIGGER `tasks_fts_au`;
--> statement-breakpoint
DROP TRIGGER `tasks_fts_ad`;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_ai` AFTER INSERT ON `tasks` BEGIN
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'task', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.body')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_au` AFTER UPDATE ON `tasks` BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'task', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.body')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_ad` AFTER DELETE ON `tasks` BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  DELETE FROM search_rowids WHERE id = OLD.id;
END;
--> statement-breakpoint
DROP TRIGGER `features_fts_ai`;
--> statement-breakpoint
DROP TRIGGER `features_fts_au`;
--> statement-breakpoint
DROP TRIGGER `features_fts_ad`;
--> statement-breakpoint
CREATE TRIGGER `features_fts_ai` AFTER INSERT ON `features` BEGIN
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'feature', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.description') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.acceptance')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `features_fts_au` AFTER UPDATE ON `features` BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'feature', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.description') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.acceptance')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `features_fts_ad` AFTER DELETE ON `features` BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  DELETE FROM search_rowids WHERE id = OLD.id;
END;
--> statement-breakpoint
DROP TRIGGER `notes_fts_ai`;
--> statement-breakpoint
DROP TRIGGER `notes_fts_au`;
--> statement-breakpoint
DROP TRIGGER `notes_fts_ad`;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_ai` AFTER INSERT ON `notes` BEGIN
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'note', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.body') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_au` AFTER UPDATE ON `notes` BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'note', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.body') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_ad` AFTER DELETE ON `notes` BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  DELETE FROM search_rowids WHERE id = OLD.id;
END;
--> statement-breakpoint
DROP TRIGGER `decisions_fts_ai`;
--> statement-breakpoint
DROP TRIGGER `decisions_fts_au`;
--> statement-breakpoint
DROP TRIGGER `decisions_fts_ad`;
--> statement-breakpoint
CREATE TRIGGER `decisions_fts_ai` AFTER INSERT ON `decisions` BEGIN
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'decision', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.context') || ' ' || json_extract(NEW.data, '$.decision') || ' ' || json_extract(NEW.data, '$.consequences')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `decisions_fts_au` AFTER UPDATE ON `decisions` BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'decision', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.context') || ' ' || json_extract(NEW.data, '$.decision') || ' ' || json_extract(NEW.data, '$.consequences')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `decisions_fts_ad` AFTER DELETE ON `decisions` BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  DELETE FROM search_rowids WHERE id = OLD.id;
END;
