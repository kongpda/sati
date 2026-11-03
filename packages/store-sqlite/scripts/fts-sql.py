# One-off generator for drizzle/0001_fts.sql (kept for reference when FTS columns change).
tables = {
  "task": ("tasks", "json_extract(NEW.data, '$.body')"),
  "feature": ("features", "json_extract(NEW.data, '$.description') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.acceptance')), '')"),
  "note": ("notes", "json_extract(NEW.data, '$.body') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), '')"),
  "decision": ("decisions", "json_extract(NEW.data, '$.context') || ' ' || json_extract(NEW.data, '$.decision') || ' ' || json_extract(NEW.data, '$.consequences')"),
}
out = ["-- Full-text search over tasks, features, notes and decisions (FTS5, BM25).",
"-- Soft-deleted records are removed from the index.",
"CREATE VIRTUAL TABLE `search_fts` USING fts5(",
"  entity UNINDEXED, id UNINDEXED, project_id UNINDEXED, title, body,",
"  tokenize = 'unicode61 remove_diacritics 2'",
");"]
for ent,(tbl,body) in tables.items():
    ins = f"""INSERT INTO search_fts (entity, id, project_id, title, body)
  SELECT '{ent}', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), {body}
  WHERE NEW.deleted_at IS NULL;"""
    out += [f"CREATE TRIGGER `{tbl}_fts_ai` AFTER INSERT ON `{tbl}` BEGIN\n  {ins}\nEND;",
            f"CREATE TRIGGER `{tbl}_fts_au` AFTER UPDATE ON `{tbl}` BEGIN\n  DELETE FROM search_fts WHERE id = OLD.id;\n  {ins}\nEND;",
            f"CREATE TRIGGER `{tbl}_fts_ad` AFTER DELETE ON `{tbl}` BEGIN\n  DELETE FROM search_fts WHERE id = OLD.id;\nEND;"]
open("drizzle/0001_fts.sql","w").write("\n--> statement-breakpoint\n".join(out)+"\n")
