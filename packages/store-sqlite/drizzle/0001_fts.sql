-- Full-text search over tasks, features, notes and decisions (FTS5, BM25).
--> statement-breakpoint
-- Soft-deleted records are removed from the index.
--> statement-breakpoint
CREATE VIRTUAL TABLE `search_fts` USING fts5(
--> statement-breakpoint
  entity UNINDEXED, id UNINDEXED, project_id UNINDEXED, title, body,
--> statement-breakpoint
  tokenize = 'unicode61 remove_diacritics 2'
--> statement-breakpoint
);
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_ai` AFTER INSERT ON `tasks` BEGIN
  INSERT INTO search_fts (entity, id, project_id, title, body)
  SELECT 'task', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.body')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_au` AFTER UPDATE ON `tasks` BEGIN
  DELETE FROM search_fts WHERE id = OLD.id;
  INSERT INTO search_fts (entity, id, project_id, title, body)
  SELECT 'task', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.body')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_ad` AFTER DELETE ON `tasks` BEGIN
  DELETE FROM search_fts WHERE id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `features_fts_ai` AFTER INSERT ON `features` BEGIN
  INSERT INTO search_fts (entity, id, project_id, title, body)
  SELECT 'feature', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.description') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.acceptance')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `features_fts_au` AFTER UPDATE ON `features` BEGIN
  DELETE FROM search_fts WHERE id = OLD.id;
  INSERT INTO search_fts (entity, id, project_id, title, body)
  SELECT 'feature', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.description') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.acceptance')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `features_fts_ad` AFTER DELETE ON `features` BEGIN
  DELETE FROM search_fts WHERE id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_ai` AFTER INSERT ON `notes` BEGIN
  INSERT INTO search_fts (entity, id, project_id, title, body)
  SELECT 'note', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.body') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_au` AFTER UPDATE ON `notes` BEGIN
  DELETE FROM search_fts WHERE id = OLD.id;
  INSERT INTO search_fts (entity, id, project_id, title, body)
  SELECT 'note', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.body') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `notes_fts_ad` AFTER DELETE ON `notes` BEGIN
  DELETE FROM search_fts WHERE id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `decisions_fts_ai` AFTER INSERT ON `decisions` BEGIN
  INSERT INTO search_fts (entity, id, project_id, title, body)
  SELECT 'decision', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.context') || ' ' || json_extract(NEW.data, '$.decision') || ' ' || json_extract(NEW.data, '$.consequences')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `decisions_fts_au` AFTER UPDATE ON `decisions` BEGIN
  DELETE FROM search_fts WHERE id = OLD.id;
  INSERT INTO search_fts (entity, id, project_id, title, body)
  SELECT 'decision', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.context') || ' ' || json_extract(NEW.data, '$.decision') || ' ' || json_extract(NEW.data, '$.consequences')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `decisions_fts_ad` AFTER DELETE ON `decisions` BEGIN
  DELETE FROM search_fts WHERE id = OLD.id;
END;
