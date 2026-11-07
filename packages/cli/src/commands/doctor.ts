import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { CLI_NAME, type DoctorCheck, doctorChecks } from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { runHint } from "../install.js";
import { closeRuntime, openRuntime, output } from "../runtime.js";

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
            const integrity = String(store.db.pragma("integrity_check", { simple: true }));
            checks.push({ name: "integrity", ok: integrity === "ok", detail: integrity });
            if (args.vacuum) store.db.exec("VACUUM");
          }
          if (rt.location.mode !== "standalone") checks.push(hooksCheck(rt.location.root));
          return { ok: checks.every((c) => c.ok), checks };
        } finally {
          await closeRuntime();
        }
      },
      (report: { ok: boolean; checks: DoctorCheck[] }) =>
        report.checks.map((c) => `${c.ok ? "ok" : "fail"} ${c.name}: ${c.detail}`).join("\n"),
    ),
});
