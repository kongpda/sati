import { execFileSync } from "node:child_process";
import { checkChanges, listRecords, SatiError } from "@sati/core";
import { defineCommand } from "citty";
import micromatch from "micromatch";
import { json } from "../args.js";
import { execute } from "../runtime.js";

export default defineCommand({
  meta: {
    name: "review",
    description: "Features, decisions and guard warnings for a branch range",
  },
  args: {
    range: {
      type: "positional",
      required: false,
      description: "Git revision range (default origin/main...HEAD)",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async (rt) => {
        if (rt.location.mode !== "git") {
          throw new SatiError("USAGE", "sati review needs a git checkout.");
        }
        const range = args.range ?? "origin/main...HEAD";
        let names = "";
        try {
          names = execFileSync("git", ["diff", "--name-only", range], {
            cwd: rt.location.root,
            encoding: "utf8",
          });
        } catch {
          throw new SatiError("USAGE", `Could not diff ${range}.`, {
            hint: "Pass a range git can resolve, such as main...HEAD.",
          });
        }
        const paths = names
          .split("\n")
          .map((p) => p.trim())
          .filter(Boolean);
        const guard = paths.length
          ? await checkChanges(rt.ctx, {
              changes: paths.map((path) => ({ path, kind: "modified" as const })),
            })
          : { verdict: "ok" as const, findings: [] };
        const features = await listRecords(rt.ctx, "feature", { limit: 500 });
        const touched = features.filter((f) =>
          paths.some((path) => micromatch.isMatch(path, f.paths, { dot: true })),
        );
        const decisions = await listRecords(rt.ctx, "decision", { limit: 20 });
        return {
          range,
          paths,
          features: touched.map((f) => ({ id: f.id, title: f.title })),
          guard,
          decisions: decisions.map((d) => ({ id: d.id, title: d.title })),
        };
      },
      (report) =>
        [
          `${report.range}: ${report.paths.length} files`,
          report.features.length
            ? `features:\n${report.features.map((f) => `- ${f.title}`).join("\n")}`
            : "features: none matched",
          `guard: ${report.guard.verdict} (${report.guard.findings.length} findings)`,
          report.decisions.length
            ? `decisions:\n${report.decisions.map((d) => `- ${d.title}`).join("\n")}`
            : "decisions: none",
        ].join("\n"),
    ),
});
