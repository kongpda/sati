import {
  CLI_NAME,
  checkChanges,
  type Decision,
  listRecords,
  listTasks,
  reviewDrift,
  SatiError,
  type ServiceContext,
  shortHandle,
} from "@sati/core";
import { defineCommand } from "citty";
import micromatch from "micromatch";
import { json } from "../args.js";
import { defaultBase, rangeChanges, rangeStart } from "../git.js";
import { execute } from "../runtime.js";

const SNAPSHOT = ".sati/";

/**
 * Decisions that belong to the range: made since it started, or about a feature it touches.
 * Newest first, at most 50, so an old project does not list its whole history.
 */
async function rangeDecisions(
  ctx: ServiceContext,
  since: string | undefined,
  features: ReadonlySet<string>,
): Promise<Decision[]> {
  const out: Decision[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await listRecords(ctx, "decision", { limit: 500, offset });
    for (const d of page) {
      const recent = since !== undefined && d.createdAt >= since;
      if (recent || d.featureIds.some((id) => features.has(id))) out.push(d);
    }
    // Pages run oldest first.
    if (page.length < 500) return out.reverse().slice(0, 50);
  }
}

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
        // The `.sati/` snapshot changes with every write; it is not the code under review.
        const paths = changes.map((c) => c.path).filter((p) => !p.startsWith(SNAPSHOT));
        const guard = changes.length
          ? await checkChanges(rt.ctx, { changes })
          : { verdict: "ok" as const, findings: [] };
        const features = await listRecords(rt.ctx, "feature", { limit: 500 });
        const touched = features.filter((f) =>
          paths.some((path) => micromatch.isMatch(path, f.paths, { dot: true })),
        );
        const decisions = await rangeDecisions(
          rt.ctx,
          rangeStart(rt.location.root, span),
          new Set(touched.map((f) => f.id)),
        );
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
          // A blocked guard with no reason gives the reviewer nothing to act on.
          ...report.guard.findings.map((f) => `- ${f.level}: ${f.message}`),
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
