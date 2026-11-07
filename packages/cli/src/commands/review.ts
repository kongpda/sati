import {
  CLI_NAME,
  checkChanges,
  listRecords,
  listTasks,
  reviewDrift,
  SatiError,
  shortHandle,
} from "@sati/core";
import { defineCommand } from "citty";
import micromatch from "micromatch";
import { json } from "../args.js";
import { defaultBase, rangeChanges } from "../git.js";
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
          throw new SatiError("USAGE", `${CLI_NAME} review needs a git checkout.`);
        }
        const range = args.range ?? defaultBase(rt.location.root);
        if (range === undefined) {
          throw new SatiError("USAGE", "No origin/HEAD or origin/main to compare with.", {
            hint: `Pass a range: \`${CLI_NAME} review main...HEAD\`.`,
          });
        }
        // The default is a branch, not a range: compare it with HEAD from their merge-base.
        const span = args.range === undefined ? `${range}...HEAD` : range;
        // rangeChanges validates the range, reads names with -z and tells deletions from edits,
        // as `guard --range` does.
        const changes = rangeChanges(rt.location.root, span);
        const paths = changes.map((c) => c.path);
        const guard = changes.length
          ? await checkChanges(rt.ctx, { changes })
          : { verdict: "ok" as const, findings: [] };
        const features = await listRecords(rt.ctx, "feature", { limit: 500 });
        const touched = features.filter((f) =>
          paths.some((path) => micromatch.isMatch(path, f.paths, { dot: true })),
        );
        const decisions = await listRecords(rt.ctx, "decision", { limit: 20 });
        const inReview = await listTasks(rt.ctx, { status: ["review"], limit: 500 });
        const drift = await reviewDrift(rt.ctx, inReview);
        return {
          range: span,
          paths,
          features: touched.map((f) => ({ id: f.id, title: f.title })),
          guard,
          decisions: decisions.map((d) => ({ id: d.id, title: d.title })),
          // Work sent for approval whose branch has commits the reviewer has not been shown.
          moved: inReview
            .filter((t) => drift.get(t.id)?.moved)
            .map((t) => ({ id: t.id, title: t.title, ...drift.get(t.id) })),
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
          ...(report.moved.length
            ? [
                `changed after it was sent for approval:\n${report.moved
                  .map(
                    (t) =>
                      `- ${shortHandle(t.id)} ${t.title}: ${t.branch} ${t.commit?.slice(0, 12)} -> ${t.head?.slice(0, 12)}`,
                  )
                  .join("\n")}`,
              ]
            : []),
        ].join("\n"),
    ),
});
