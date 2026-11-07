-- Cards (context entries) join the search index: the path as the title, the summary, facts and
-- tags as the body. Same rowid scheme as 0003_fts_rowids.sql.
--> statement-breakpoint
INSERT OR IGNORE INTO search_rowids (id) SELECT id FROM `context_entries` WHERE deleted_at IS NULL;
--> statement-breakpoint
INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = c.id), 'context', c.id, c.project_id, json_extract(c.data, '$.path'), json_extract(c.data, '$.summary') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(c.data, '$.facts')), '') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(c.data, '$.tags')), '')
  FROM `context_entries` c WHERE c.deleted_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER `context_entries_fts_ai` AFTER INSERT ON `context_entries` BEGIN
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'context', NEW.id, NEW.project_id, json_extract(NEW.data, '$.path'), json_extract(NEW.data, '$.summary') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.facts')), '') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `context_entries_fts_au` AFTER UPDATE ON `context_entries` BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT (SELECT rowid FROM search_rowids WHERE id = NEW.id), 'context', NEW.id, NEW.project_id, json_extract(NEW.data, '$.path'), json_extract(NEW.data, '$.summary') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.facts')), '') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), '')
  WHERE NEW.deleted_at IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `context_entries_fts_ad` AFTER DELETE ON `context_entries` BEGIN
  DELETE FROM search_fts WHERE rowid = (SELECT rowid FROM search_rowids WHERE id = OLD.id);
  DELETE FROM search_rowids WHERE id = OLD.id;
END;
