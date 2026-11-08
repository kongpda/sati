import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  CLI_NAME,
  type DoctorCheck,
  doctorChecks,
  ERROR_EXIT_CODES,
  type LinkedWorktree,
  removableWorktrees,
  type ServiceContext,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { defaultBase } from "../git.js";
import { runHint } from "../install.js";
import { closeRuntime, openRuntime, output, worktreePaths } from "../runtime.js";

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
  const fix = `Run \`${runHint(root, "init --upgrade")}\`.`;
  if (!existsSync(runner)) {
    return { name: "hooks", ok: false, detail: `This clone has no ${CLI_NAME} git hooks. ${fix}` };
  }
  // The runner checks for its binary with `[ ! -e '<path>' ]`.
  const bin = readFileSync(runner, "utf8").match(/^if \[ ! -e '(.+)' \]; then$/m)?.[1];
  if (bin !== undefined && !existsSync(bin)) {
    return {
      name: "hooks",
      ok: false,
      detail: `The git hooks start ${bin}, which is gone. ${fix}`,
    };
  }
  return { name: "hooks", ok: true, detail: `The git hooks start ${bin ?? CLI_NAME}.` };
}

const quiet = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/**
 * Linked worktrees that are finished: clean, merged into the base branch and not used by any
 * open task. Lists the command to remove each; never removes one. Informational, so always ok.
 */
async function worktreesCheck(ctx: ServiceContext, root: string): Promise<DoctorCheck | null> {
  const base = defaultBase(root);
  const [, ...linked] = worktreePaths(root);
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
  meta: { name: "doctor", description: "Check leases, locks, integrity and hooks" },
  args: {
    vacuum: { type: "boolean", description: "Run VACUUM after the checks" },
    ...json,
  },
  run: ({ args }) =>
    output(
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
          if (rt.location.mode !== "standalone") {
            checks.push(hooksCheck(rt.location.root));
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
    ),
});
