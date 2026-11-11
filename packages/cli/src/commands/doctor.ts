import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  CLI_NAME,
  type DoctorCheck,
  doctorChecks,
  ERROR_EXIT_CODES,
  type LinkedWorktree,
  markReviewed,
  removableWorktrees,
  type ServiceContext,
  shortHandle,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { defaultBase, samePath } from "../git.js";
import { installedSelf } from "../hooks.js";
import { runHint } from "../install.js";
import { closeRuntime, execute, openRuntime, output, worktreePaths } from "../runtime.js";
import { pendingUpgrade, syncedDbWarning } from "./init.js";

/**
 * The git hooks of this clone: the pre-commit runner init writes under the git common dir, and
 * the binary it starts. Each clone needs its own `init`, so a fresh clone fails here.
 */
function hooksCheck(root: string): DoctorCheck {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const runner = resolve(
    isAbsolute(common) ? common : resolve(root, common),
    CLI_NAME,
    "hooks",
    "pre-commit",
  );
  const fix = `Run \`${runHint(root, "init --upgrade --yes")}\`.`;
  if (!existsSync(runner)) {
    return { name: "hooks", ok: false, detail: `This clone has no ${CLI_NAME} git hooks. ${fix}` };
  }
  // Every word of the command the hooks start is a path: node and the script, or the binary.
  const self = installedSelf(root) ?? [];
  const bin = self.at(-1);
  const gone = self.find((word) => !existsSync(resolve(root, word)));
  if (gone !== undefined) {
    return {
      name: "hooks",
      ok: false,
      detail: `The git hooks start ${gone}, which is gone. ${fix}`,
    };
  }
  return { name: "hooks", ok: true, detail: `The git hooks start ${bin ?? CLI_NAME}.` };
}

/**
 * Whether the hooks, merge driver (git mode) and agent files match this version. After an
 * update they lag behind until `init --upgrade` runs, and nothing else would say so.
 */
async function upgradeCheck(root: string): Promise<DoctorCheck> {
  let files: Awaited<ReturnType<typeof pendingUpgrade>>;
  try {
    files = await pendingUpgrade(root);
  } catch (err) {
    // A failed plan is one failed check, not a lost report.
    return { name: "setup", ok: false, detail: `Cannot check: ${(err as Error).message}` };
  }
  if (files.length === 0) {
    return { name: "setup", ok: true, detail: "The git hooks and agent files are current." };
  }
  return {
    name: "setup",
    ok: false,
    detail: [
      `${files.length} managed file(s) are out of date. Run \`${runHint(root, "init --upgrade --yes")}\`.`,
      ...files.map((f) => `  ${f.action === "create" ? "missing" : "stale  "} ${f.path}`),
    ].join("\n"),
  };
}

const quiet = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/**
 * Linked worktrees that are finished: clean, merged into the base branch and not used by any
 * open task. Lists the command to remove each; never removes one. Informational, so always ok.
 */
async function worktreesCheck(ctx: ServiceContext, root: string): Promise<DoctorCheck | null> {
  const base = defaultBase(root);
  let linked: { path: string; branch: string | null }[];
  try {
    // The first entry is the main worktree. The one doctor runs in is in use, so it is left out
    // too: inside a linked worktree it is not the first.
    linked = worktreePaths(root)
      .slice(1)
      .filter((w) => !samePath(w.path, root));
  } catch {
    // `git worktree list -z` needs git 2.36; older git just skips this check.
    return null;
  }
  if (!base || linked.length === 0) return null;
  const seen: LinkedWorktree[] = [];
  for (const w of linked) {
    try {
      const clean = quiet(w.path, ["status", "--porcelain=v1", "-z"]) === "";
      let merged = false;
      try {
        quiet(w.path, ["merge-base", "--is-ancestor", "HEAD", base]);
        merged = true;
      } catch {
        // Exit 1: HEAD has commits the base does not.
      }
      seen.push({ ...w, clean, merged });
    } catch {
      // A worktree whose folder is gone: `git worktree prune` is git's own business.
    }
  }
  const removable = await removableWorktrees(ctx, seen);
  return {
    name: "worktrees",
    ok: true,
    detail:
      removable.length === 0
        ? `No finished worktrees to remove (${linked.length} linked).`
        : [
            `${removable.length} finished worktree(s), clean and merged into ${base}. Remove with:`,
            ...removable.map((r) => `  ${r.command}`),
          ].join("\n"),
  };
}

export default defineCommand({
  meta: {
    name: "doctor",
    description:
      "Check leases, locks, integrity, hooks, setup files and finished worktrees. Exit 5 if a check fails",
  },
  args: {
    vacuum: { type: "boolean", description: "Run VACUUM after the checks" },
    reviewed: {
      type: "string",
      description: "Clear needsReview on the record with this id, once you have looked at it",
    },
    ...json,
  },
  run: ({ args }) => {
    if (args.reviewed !== undefined) {
      const id = args.reviewed;
      return execute(
        args.json,
        ({ ctx }) => markReviewed(ctx, id),
        (r) => `Cleared needsReview on ${shortHandle(r.id)}.`,
      );
    }
    return output(
      args.json,
      async () => {
        const rt = await openRuntime();
        try {
          const checks: DoctorCheck[] = await doctorChecks(rt.ctx);
          const store = rt.ctx.store;
          if (store instanceof SqliteStore) {
            const integrity = await store.integrityCheck();
            checks.push({ name: "integrity", ok: integrity === "ok", detail: integrity });
            if (args.vacuum) await store.vacuum();
          }
          const synced = syncedDbWarning(rt.location.path);
          if (synced) checks.push({ name: "synced folder", ok: false, detail: synced });
          if (rt.location.mode !== "standalone") {
            const hooks = hooksCheck(rt.location.root);
            checks.push(hooks);
            if (hooks.ok) checks.push(await upgradeCheck(rt.location.root));
            const worktrees = await worktreesCheck(rt.ctx, rt.location.root);
            if (worktrees) checks.push(worktrees);
          }
          const ok = checks.every((c) => c.ok);
          // A failed check fails the command, or CI and scripts read a broken project as healthy.
          if (!ok) process.exitCode = ERROR_EXIT_CODES.VALIDATION;
          return { ok, checks };
        } finally {
          await closeRuntime();
        }
      },
      (report: { ok: boolean; checks: DoctorCheck[] }) =>
        report.checks.map((c) => `${c.ok ? "ok" : "fail"} ${c.name}: ${c.detail}`).join("\n"),
    );
  },
});
