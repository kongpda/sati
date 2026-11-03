import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIdFactory, initProject, systemClock } from "@brain/core";
import { clearLocateCache, locateDb, SqliteStore } from "@brain/store-sqlite";

export const bin = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));

/** A temp git repo. `init: true` also creates the project through core, skipping `brain init`. */
export async function tempRepo(opts: { init?: boolean } = {}): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "brain-cli-")));
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

/** Runs the built CLI. `BRAIN_ACTOR` defaults to "tester" so actor names are predictable. */
export function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Result {
  const full: NodeJS.ProcessEnv = { ...process.env, BRAIN_ACTOR: "tester", CLAUDECODE: "", ...env };
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, env: full, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export const brain = (cwd: string, ...args: string[]): Result => run(cwd, args);

/** Runs with `--json` and parses stdout (data on success, `{ error }` on failure). */
export function brainJson<T = unknown>(cwd: string, ...args: string[]): { code: number; data: T } {
  const r = brain(cwd, ...args, "--json");
  return { code: r.code, data: JSON.parse(r.stdout) as T };
}
