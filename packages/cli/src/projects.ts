import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLI_NAME, SatiError } from "@sati/core";
import type { DbLocation } from "@sati/store-sqlite";
import { writeFileAtomic } from "@sati/sync";
import { parseJson } from "./runtime.js";

interface KnownProject {
  slug: string;
  name: string;
  projectId: string;
  root: string;
  mode: "git" | "stealth" | "standalone";
  db: string;
}

/**
 * The registry of projects on this machine. `SATI_REGISTRY` points it elsewhere, so test runs
 * do not fill the real one (review 5.7); an explicit `home` wins over it.
 */
function file(home?: string): string {
  const override = process.env.SATI_REGISTRY;
  if (home === undefined && override) return override;
  return join(home ?? homedir(), ".sati", "projects.json");
}

export function readProjects(home?: string): KnownProject[] {
  const path = file(home);
  if (!existsSync(path)) return [];
  const parsed = parseJson(readFileSync(path, "utf8"), path);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row): row is KnownProject => {
    if (row === null || typeof row !== "object") return false;
    const rec = row as Partial<KnownProject>;
    return (
      typeof rec.slug === "string" && typeof rec.db === "string" && typeof rec.root === "string"
    );
  });
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;

/**
 * Runs `change` while holding a lock folder next to the registry. Two `init` runs at once would
 * each read the list, add one entry and write: the second write dropped the first entry.
 * A lock older than 10 seconds belongs to a process that died, so it is taken over.
 */
function withRegistryLock<T>(path: string, change: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age > LOCK_STALE_MS || Date.now() > deadline) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return change();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function rememberProject(project: KnownProject, home?: string): void {
  const path = file(home);
  withRegistryLock(path, () => {
    const all = readProjects(home).filter(
      (p) => p.slug !== project.slug && p.projectId !== project.projectId,
    );
    all.push(project);
    writeFileAtomic(path, `${JSON.stringify(all, null, 2)}\n`);
  });
}

/**
 * Drops entries whose folder or database is gone, such as deleted temp repos. Returns what it
 * dropped. Only on request: a folder on an unmounted drive also looks gone.
 */
export function pruneProjects(home?: string): KnownProject[] {
  if (!existsSync(file(home))) return [];
  return withRegistryLock(file(home), () => {
    const all = readProjects(home);
    const gone = all.filter((p) => !existsSync(p.root) || !existsSync(p.db));
    if (gone.length === 0) return [];
    writeFileAtomic(
      file(home),
      `${JSON.stringify(
        all.filter((p) => !gone.includes(p)),
        null,
        2,
      )}\n`,
    );
    return gone;
  });
}

export function projectLocation(slug: string, home?: string): DbLocation {
  const found = readProjects(home).find((p) => p.slug === slug);
  if (!found) {
    throw new SatiError("NOT_FOUND", `No project named ${slug} on this machine.`, {
      hint: `Run \`${CLI_NAME} projects\` to see them, or \`${CLI_NAME} init\` in the repository.`,
    });
  }
  return {
    path: found.db,
    root: found.root,
    mode: found.mode === "standalone" ? "standalone" : "git",
  };
}
