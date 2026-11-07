import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIdFactory, initProject, systemClock } from "@sati/core";
import { clearLocateCache, locateDb, SqliteStore } from "@sati/store-sqlite";

export const bin = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));

/** A temp git repo. `init: true` also creates the project through core, skipping `sati init`. */
export async function tempRepo(opts: { init?: boolean } = {}): Promise<string> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "sati-cli-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  if (opts.init) {
    clearLocateCache();
    const store = await SqliteStore.open(locateDb(dir).path);
    await initProject(
      { store, clock: systemClock, ids: createIdFactory() },
      { slug: "demo", name: "Demo" },
      { name: "setup@test", kind: "human" },
    );
    await store.close();
  }
  return dir;
}

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built CLI. `SATI_ACTOR` defaults to "tester" so actor names are predictable. A `HOME`
 * override also sets `USERPROFILE`, which is where Node finds the home folder on Windows.
 */
export function run(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  input?: string,
): Result {
  const overrides: NodeJS.ProcessEnv = {
    SATI_ACTOR: "tester",
    CLAUDECODE: "",
    AI_AGENT: "",
    ...env,
  };
  if (env.HOME !== undefined) overrides.USERPROFILE = env.HOME;
  const full: NodeJS.ProcessEnv = { ...process.env };
  // Windows env names ignore case: drop `Path` before setting `PATH`, or the child sees both.
  if (process.platform === "win32") {
    const names = new Set(Object.keys(overrides).map((k) => k.toUpperCase()));
    for (const key of Object.keys(full)) if (names.has(key.toUpperCase())) delete full[key];
  }
  Object.assign(full, overrides);
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: full,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export const sati = (cwd: string, ...args: string[]): Result => run(cwd, args);

/** Runs with `--json` and parses stdout (data on success, `{ error }` on failure). */
export function satiJson<T = unknown>(cwd: string, ...args: string[]): { code: number; data: T } {
  const r = sati(cwd, ...args, "--json");
  return { code: r.code, data: JSON.parse(r.stdout) as T };
}
