import { chmodSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

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
  // Flushed before the rename: without it a power cut can leave the new name on an empty file.
  writeFileSync(tmp, text, { flush: true });
  if (keep !== undefined) chmodSync(tmp, keep);
  rename(tmp, path);
}

/** Codes Windows gives for a rename over a file another process has open for a moment. */
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRIES = 10;

/** Renames, retrying for about a second while the target is busy; removes `tmp` if it fails. */
function rename(tmp: string, path: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!BUSY.has(code) || attempt >= RETRIES) {
        rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}
