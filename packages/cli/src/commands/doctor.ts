import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DoctorCheck, doctorChecks } from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { closeRuntime, openRuntime, output } from "../runtime.js";

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
          const hook = join(rt.location.root, ".git", "hooks", "pre-commit");
          if (rt.location.mode === "git") {
            const text = existsSync(hook) ? readFileSync(hook, "utf8") : "";
            checks.push({
              name: "hooks",
              ok: text.includes("sati"),
              detail: text.includes("sati")
                ? "pre-commit calls sati."
                : "pre-commit does not call sati.",
            });
          }
          return { ok: checks.every((c) => c.ok), checks };
        } finally {
          await closeRuntime();
        }
      },
      (report: { ok: boolean; checks: DoctorCheck[] }) =>
        report.checks.map((c) => `${c.ok ? "ok" : "fail"} ${c.name}: ${c.detail}`).join("\n"),
    ),
});
