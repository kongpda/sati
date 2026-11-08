import { chmodSync, renameSync, statSync, writeFileSync } from "node:fs";

/**
 * Writes `text` to a temp file beside `path`, then renames it over `path`, so a crash or a
 * concurrent reader never sees a half-written file. An existing file keeps its mode (hooks stay
 * executable); `mode` sets one for a new file.
 */
export function writeFileAtomic(path: string, text: string, mode?: number): void {
  let keep = mode;
  try {
    keep = statSync(path).mode & 0o777;
  } catch {
    // New file: the default mode (or `mode`) applies.
  }
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  if (keep !== undefined) chmodSync(tmp, keep);
  renameSync(tmp, path);
}
