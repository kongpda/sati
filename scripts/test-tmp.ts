import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vitest global setup: every temp folder a test run makes goes under one run folder, removed
 * when the run ends. Tests never cleaned up after themselves, and thousands of leftover repos
 * and databases filled the temp disk. The run folder sits in `/tmp` where there is one: the
 * per-user temp folder on macOS is so long that a `sati.sock` under it nears the limit for a
 * Unix socket path.
 */
export default function setup(): () => void {
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  const run = mkdtempSync(join(base, "sati-t-"));
  // Workers start after this and inherit the environment; `os.tmpdir()` reads these.
  for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = run;
  return () => {
    try {
      // A process a test started may still be writing as the run ends: retry for a few seconds.
      rmSync(run, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows may still hold a database file open; the folder is then left for the OS.
    }
  };
}
