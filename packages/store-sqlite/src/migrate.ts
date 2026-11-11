import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.gen.js";

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

/** The schema version, `PRAGMA user_version`. */
export function userVersion(db: DatabaseSync): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
}

/**
 * Brings the DB up to LATEST_SCHEMA_VERSION. The schema version is `PRAGMA user_version`.
 * Before changing an existing DB it writes a backup, then migrates under an exclusive lock
 * so other processes wait instead of reading a half-migrated schema.
 * Returns the resulting version (higher than LATEST if a newer binary already upgraded it).
 */
export async function migrate(db: DatabaseSync, path: string): Promise<number> {
  const current = userVersion(db);
  if (current >= LATEST_SCHEMA_VERSION) return current;

  if (current > 0 && path !== ":memory:" && existsSync(path)) {
    const dir = join(dirname(path), "backups");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(dir, `${basename(path)}.v${current}.${stamp}.bak`);
    await backup(db, target);
  }

  db.exec("BEGIN EXCLUSIVE");
  try {
    // Re-read inside the lock: another process may have migrated while we waited.
    const locked = userVersion(db);
    for (const m of MIGRATIONS) {
      if (m.version > locked) db.exec(m.sql);
    }
    const next = Math.max(locked, LATEST_SCHEMA_VERSION);
    db.exec(`PRAGMA user_version = ${next}`);
    db.exec("COMMIT");
    return next;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}
