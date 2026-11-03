# Generator for the FTS triggers. 0001_fts.sql created the index; 0003_fts_rowids.sql holds the
# current triggers, which find a record's index row by rowid through `search_rowids`.
# (Deleting by `id`, an UNINDEXED FTS column, scanned the whole index on every update.)
# To change indexed columns, add a new migration that drops and recreates the triggers.
tables = {
  "task": ("tasks", "json_extract(NEW.data, '$.body')"),
  "feature": ("features", "json_extract(NEW.data, '$.description') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.acceptance')), '')"),
  "note": ("notes", "json_extract(NEW.data, '$.body') || ' ' || coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.data, '$.tags')), '')"),
  "decision": ("decisions", "json_extract(NEW.data, '$.context') || ' ' || json_extract(NEW.data, '$.decision') || ' ' || json_extract(NEW.data, '$.consequences')"),
}
out = ["-- Gives each indexed record a stable FTS rowid, so updates and deletes find its index row",
"-- by rowid instead of scanning the index for the UNINDEXED `id` column.",
"CREATE TABLE `search_rowids` (`rowid` integer PRIMARY KEY, `id` text NOT NULL UNIQUE);",
"INSERT INTO `search_rowids` (`rowid`, `id`) SELECT rowid, id FROM search_fts;"]
rowid = lambda ref: f"(SELECT rowid FROM search_rowids WHERE id = {ref}.id)"
delete = f"DELETE FROM search_fts WHERE rowid = {rowid('OLD')};"
for ent,(tbl,body) in tables.items():
    ins = f"""INSERT OR IGNORE INTO search_rowids (id) VALUES (NEW.id);
  INSERT INTO search_fts (rowid, entity, id, project_id, title, body)
  SELECT {rowid('NEW')}, '{ent}', NEW.id, NEW.project_id, json_extract(NEW.data, '$.title'), {body}
  WHERE NEW.deleted_at IS NULL;"""
    for kind in ("ai", "au", "ad"):
        out.append(f"DROP TRIGGER `{tbl}_fts_{kind}`;")
    out += [f"CREATE TRIGGER `{tbl}_fts_ai` AFTER INSERT ON `{tbl}` BEGIN\n  {ins}\nEND;",
            f"CREATE TRIGGER `{tbl}_fts_au` AFTER UPDATE ON `{tbl}` BEGIN\n  {delete}\n  {ins}\nEND;",
            f"CREATE TRIGGER `{tbl}_fts_ad` AFTER DELETE ON `{tbl}` BEGIN\n  {delete}\n  DELETE FROM search_rowids WHERE id = OLD.id;\nEND;"]
open("drizzle/0003_fts_rowids.sql","w").write("\n--> statement-breakpoint\n".join(out)+"\n")
