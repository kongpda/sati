import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Actor,
  actorIdentity,
  CONFIG_DIR,
  CONFIG_FILE,
  createIdFactory,
  initProject,
  isSatiError,
  type Project,
  SatiError,
  type ServiceContext,
  systemClock,
} from "@sati/core";
import { SqliteStore, syncedFolder } from "@sati/store-sqlite";
import { importSnapshot, writeFileAtomic } from "@sati/sync";
import { applyMergeDriver, type PlannedHook } from "../../hooks.js";
import { isLocalInstall, runHint } from "../../install.js";
import {
  excludeFileFor,
  type FileAction,
  type FileChange,
  warnIfNotOnPath,
  writePlanned,
} from "../../integrations.js";
import { writeConfigKind } from "../../runtime/config.js";
import { currentBranch } from "../../runtime/git.js";
import { osUser } from "../../runtime/identity.js";
import { warn } from "../../term.js";
import type { InitPlan } from "./plan.js";

export interface InitResult {
  project: Project;
  actor: Actor;
  db: string;
  tools: string[];
  files: FileChange[];
  /** Records loaded from a committed `.sati/` snapshot, as in a teammate's fresh clone. */
  imported: number;
  /** Hooks that were skipped and why, or what the user must do next. */
  notes: string[];
}

export const LABEL: Record<FileAction, string> = {
  create: "created",
  update: "updated",
  keep: "kept",
  skip: "skipped",
};

export const notes = (hooks: PlannedHook[]) =>
  hooks.flatMap((h) => (h.note ? [`(${h.path}: ${h.note})`] : []));

/** Writes the hooks, the merge driver and the agent files that `p` plans. */
function writeManaged(p: InitPlan): void {
  for (const h of p.hooks) {
    if (h.action !== "create" && h.action !== "update") continue;
    mkdirSync(join(h.abs, ".."), { recursive: true });
    if (h.action === "create") {
      writeFileSync(h.abs, h.content, { flag: "wx" });
      chmodSync(h.abs, 0o755);
    } else {
      writeFileAtomic(h.abs, h.content, 0o755);
      chmodSync(h.abs, 0o755);
    }
  }
  if (p.mergeDriver) applyMergeDriver(p.root, p.mergeDriver);
  writePlanned(p.root, p.agentFiles, p.mode === "stealth" ? excludeFileFor(p.db) : undefined);
}

export interface UpgradeResult {
  upgraded: Project;
  files: FileChange[];
  notes: string[];
}

/**
 * What to tell the user when the database sits in a folder a file-sync app keeps, or undefined.
 * Standalone projects are safe: their database is under `~/.sati`, outside the project folder.
 */
export function syncedDbWarning(db: string): string | undefined {
  const app = syncedFolder(db);
  if (!app) return undefined;
  return `The database (${db}) is in a folder ${app} keeps in sync. A file-sync app copies the database while it is written, which can corrupt it. Move the project out of the synced folder, or pause syncing for it.`;
}

const warnIfSynced = (db: string) => {
  const warning = syncedDbWarning(db);
  if (warning) warn(warning);
};

function applyUpgrade(p: InitPlan & { upgrade: Project }): UpgradeResult {
  writeManaged(p);
  warnIfNotOnPath(p.tools, isLocalInstall(p.root));
  warnIfSynced(p.db);
  return { upgraded: p.upgrade, files: p.files, notes: notes(p.hooks) };
}

/** Loads the committed snapshot. The project is already set up, so a failure says how to retry. */
async function importClone(root: string, ctx: ServiceContext): Promise<number> {
  const dir = join(root, CONFIG_DIR);
  try {
    return (await importSnapshot(ctx, dir)).imported.length;
  } catch (err) {
    if (!isSatiError(err)) throw err;
    throw new SatiError(err.code, `The project is set up, but ${err.message}`, {
      hint: `${err.hint ?? "Fix the snapshot files."} Then run \`${runHint(root, "sync import")}\`.`,
      ...(err.details ? { details: err.details } : {}),
    });
  }
}

export async function apply(p: InitPlan): Promise<InitResult | UpgradeResult> {
  if (p.upgrade) return applyUpgrade({ ...p, upgrade: p.upgrade });
  const store = await SqliteStore.open(p.db);
  const ids = createIdFactory();
  // The project id is chosen before the DB exists, so the config file and the row agree.
  const deps = {
    store,
    clock: systemClock,
    ids: (entity: Parameters<typeof ids>[0]) => (entity === "project" ? p.projectId : ids(entity)),
    branch:
      p.mode === "standalone" ? null : currentBranch({ path: p.db, mode: "git", root: p.root }),
  };
  try {
    const { project, actor } = await initProject(
      deps,
      { slug: p.slug, name: p.name, mode: p.mode, kind: p.kind },
      actorIdentity({ env: process.env, worktree: p.root, user: osUser() }),
    );
    // Planned paths use `/` on every platform (`shownPath`), so compare with `/` too.
    const config = p.files.find((f) => f.path === `${CONFIG_DIR}/${CONFIG_FILE}`);
    if (config?.action === "create") {
      const abs = join(p.root, config.path);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, `${JSON.stringify(p.config, null, 2)}\n`, { flag: "wx" });
    } else if (config) {
      // An explicit --kind in a clone wins over the committed one; record it so the next
      // `sync import` (run by git hooks) does not switch the project back.
      writeConfigKind(p.root, p.kind);
    }
    writeManaged(p);
    warnIfNotOnPath(p.tools, isLocalInstall(p.root));
    warnIfSynced(p.db);
    // Register first: if the snapshot import below fails, the project still exists and is known.
    const { rememberProject } = await import("../../projects.js");
    rememberProject({
      slug: project.slug,
      name: project.name,
      projectId: project.id,
      root: p.root,
      mode: project.mode,
      db: p.db,
    });
    // A fresh clone, or a shared folder someone else set up, already has teammates' records in
    // .sati/; without this it starts empty.
    const imported =
      (p.mode === "git" || p.config.share === true) && config?.action === "keep"
        ? await importClone(p.root, { ...deps, projectId: project.id, actorId: actor.id })
        : 0;
    return {
      project,
      actor,
      db: p.db,
      tools: p.tools,
      files: p.files,
      imported,
      notes: notes(p.hooks),
    };
  } finally {
    await store.close();
  }
}
