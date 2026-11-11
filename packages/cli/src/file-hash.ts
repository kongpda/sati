import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * SHA-256 of a file's bytes, or undefined when there is no file there. Read in pieces: a
 * deliverable may be a video of several gigabytes. The bytes are hashed and dropped, never kept.
 */
export function fileSha256(path: string): string | undefined {
  let fd: number;
  try {
    if (!statSync(path).isFile()) return undefined;
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** Above this a file is not hashed for a brief or a board refresh; the guard still checks it. */
const WATCH_BYTES = 256 * 1024 * 1024;

/**
 * The `sha256` of a project file for the brief and the board, which ask on every run or refresh:
 * `null` when there is no file, `undefined` when it is too large to read each time. A hash is
 * kept while the file's size and change time stay the same, so the board reads a file once.
 */
export function watchedSha256(root: string): (path: string) => Promise<string | null | undefined> {
  const seen = new Map<string, { size: number; mtimeMs: number; hash: string }>();
  return async (path) => {
    const full = resolve(root, path);
    let stat: { size: number; mtimeMs: number };
    try {
      const s = statSync(full);
      if (!s.isFile()) return null;
      stat = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
    if (stat.size > WATCH_BYTES) return undefined;
    const kept = seen.get(full);
    if (kept && kept.size === stat.size && kept.mtimeMs === stat.mtimeMs) return kept.hash;
    const hash = fileSha256(full);
    if (hash === undefined) return null;
    seen.set(full, { ...stat, hash });
    return hash;
  };
}
