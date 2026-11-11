import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceContext } from "@sati/core";

/** How often the board and the MCP server look for files a file-sync app brought (ADR 0009). */
const CHECK_MS = 5000;

/** What this machine last saw of each record file. Kept next to the database, never in the folder. */
const seenFile = (db: string) => `${db}.folder.json`;

function readSeen(db: string): Record<string, string> {
  const file = seenFile(db);
  if (!existsSync(file)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value !== null && typeof value === "object" ? (value as Record<string, string>) : {};
  } catch {
    // A torn file only costs one full import.
    return {};
  }
}

/**
 * Loads the record files that changed since this machine last looked: the ones a file-sync app
 * brought from another person. Copies the app made of a record are merged into it. A failure is
 * reported and the files are tried again next time; it never stops the command, because a file
 * may simply be half synced. One file that cannot be read is left out and the rest are loaded.
 */
export async function loadFolder(
  ctx: ServiceContext,
  dir: string,
  db: string,
  report: (err: unknown) => void,
): Promise<void> {
  const { exportSnapshot, fileStamp, importSnapshot, snapshotStamps, writeFileAtomic } =
    await import("@sati/sync");
  try {
    const seen = readSeen(db);
    const now = snapshotStamps(dir);
    const changed = new Set(Object.keys(now).filter((path) => seen[path] !== now[path]));
    if (changed.size === 0) return;
    const result = await importSnapshot(ctx, dir, {
      only: changed,
      mergeCopies: true,
      skipBad: true,
    });
    for (const p of result.problems) process.stderr.write(`warning: ${p}\n`);
    // A record merged from two edits is a version past both files; write it for the others.
    const { written } = await exportSnapshot(ctx, dir, { only: result.imported });
    // A skipped copy stays unseen, so its warning comes back until someone deletes it.
    for (const path of result.skipped) delete now[path];
    for (const path of written) {
      const stamp = fileStamp(join(dir, path));
      if (stamp !== undefined) now[path] = stamp;
    }
    writeFileAtomic(seenFile(db), JSON.stringify(now));
  } catch (err) {
    report(err);
  }
}

/** Records that this machine wrote these files itself, so the next look does not load them back. */
export async function markSeen(dir: string, db: string, written: readonly string[]): Promise<void> {
  if (written.length === 0) return;
  const { fileStamp, writeFileAtomic } = await import("@sati/sync");
  const seen = readSeen(db);
  for (const path of written) {
    const stamp = fileStamp(join(dir, path));
    if (stamp !== undefined) seen[path] = stamp;
  }
  writeFileAtomic(seenFile(db), JSON.stringify(seen));
}

/**
 * For a process that stays up (the board, the MCP server): loads the folder now and then every
 * few seconds, one run at a time. Returns the function that stops it.
 */
export function watchFolder(
  ctx: ServiceContext,
  dir: string,
  db: string,
  report: (err: unknown) => void,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await loadFolder(ctx, dir, db, report);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), CHECK_MS);
  // The check must not keep a finished process alive.
  timer.unref();
  return () => clearInterval(timer);
}
