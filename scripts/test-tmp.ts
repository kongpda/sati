import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vitest global setup: every temp folder a test run makes goes under one run folder, removed
 * when the run ends. Tests never cleaned up after themselves, and thousands of leftover repos
 * and databases filled the temp disk. The run folder sits in `/tmp` where there is one: the
 * per-user temp folder on macOS is so long that a `sati.sock` under it nears the limit for a
 * Unix socket path. `SATI_KEEP_TMP=1` keeps the folder for debugging.
 */
export default function setup(): () => void {
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  const run = mkdtempSync(join(base, "sati-t-"));
  // Workers start after this and inherit the environment; `os.tmpdir()` reads these.
  for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = run;
  // Tests run `sati init` in temp repos, which chains into `core.hooksPath`. Ignoring the global
  // git config keeps a developer's own hooks folder out of the run. An empty file, not
  // `os.devNull`: git for Windows cannot open `\\.\nul` as a config file. It lives in the run
  // folder, so it goes with the run instead of one leftover folder per start.
  const emptyGitConfig = join(run, "gitconfig");
  writeFileSync(emptyGitConfig, "");
  process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  return () => {
    if (process.env.SATI_KEEP_TMP === "1") {
      console.log(`Kept the test folder: ${run}`);
      return;
    }
    try {
      // A process a test started may still be writing as the run ends: retry for a few seconds.
      rmSync(run, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows may still hold a database file open; the folder is then left for the OS.
    }
  };
}
