import { z } from "zod";
import { normalizeLockPath, pathsOverlap } from "../domain/locks.js";
import { isGuardedFeature } from "../domain/rules.js";
import { type Feature, LIMITS, type Lock } from "../domain/schemas.js";
import { CLI_NAME } from "../name.js";
import { actorName, listAll, logActivity, parseInput, type ServiceContext } from "./context.js";
import { othersLiveLocks } from "./lock.js";

export const CHANGE_KINDS = ["added", "modified", "deleted", "renamed"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

const RepoPath = z
  .string()
  .min(1)
  .max(LIMITS.path)
  .transform((raw, c) => {
    const p = normalizeLockPath(raw);
    if (p === undefined) {
      c.addIssue({ code: "custom", message: `"${raw}" is not a repo-relative path` });
      return z.NEVER;
    }
    return p;
  });

const Change = z
  .strictObject({
    path: RepoPath,
    kind: z.enum(CHANGE_KINDS).default("modified"),
    /** Lines this change removes from the file. */
    removedLines: z.number().int().min(0).optional(),
    /** Lines this change adds. With all base lines removed and none added, the file is emptied. */
    addedLines: z.number().int().min(0).optional(),
    /** Lines the file had before the change. */
    baseLines: z.number().int().min(0).optional(),
    /** Previous path. Required when `kind` is `renamed`. */
    from: RepoPath.optional(),
  })
  .refine((c) => c.kind !== "renamed" || c.from !== undefined, {
    message: "a rename needs from",
    path: ["from"],
  });

/** A staged diff can be much larger than an agent's input, so the usual 500-item cap is raised. */
const MAX_CHANGES = 100_000;
export const DEFAULT_MAX_REMOVAL_RATIO = 0.5;

export const CheckChangesInput = z.strictObject({
  changes: z.array(Change).min(1).max(MAX_CHANGES),
  maxRemovalRatio: z.number().min(0).max(1).default(DEFAULT_MAX_REMOVAL_RATIO),
});
export type CheckChangesInput = z.input<typeof CheckChangesInput>;

export type GuardVerdict = "ok" | "warn" | "blocked";
export type GuardRule =
  | "locked"
  | "locked-shared"
  | "protected-delete"
  | "protected-gutted"
  | "shipped-touched"
  | "renamed-out";

export interface GuardFinding {
  level: Exclude<GuardVerdict, "ok">;
  rule: GuardRule;
  message: string;
  /** Changed paths this finding is about. */
  paths: string[];
  featureId?: string;
  lockId?: string;
  /** A Decision on the feature that lets a removal through. */
  decisionId?: string;
}

export interface GuardResult {
  verdict: GuardVerdict;
  findings: GuardFinding[];
}

type ParsedChange = z.output<typeof Change>;

const covers = (globs: readonly string[], path: string) => globs.some((g) => pathsOverlap(g, path));

const touches = (globs: readonly string[], change: ParsedChange) =>
  covers(globs, change.path) ||
  (change.kind === "renamed" && change.from !== undefined && covers(globs, change.from));

function lockFinding(lock: Lock, holder: string, paths: string[]): GuardFinding {
  const exclusive = lock.mode === "exclusive";
  return {
    level: exclusive ? "blocked" : "warn",
    rule: exclusive ? "locked" : "locked-shared",
    message: `${paths.join(", ")} ${paths.length > 1 ? "are" : "is"} inside a ${lock.mode} lock held by ${holder} until ${lock.leaseUntil}.`,
    paths,
    lockId: lock.id,
  };
}

/**
 * Removed lines over lines before the change, across the feature's changed files. A deleted file
 * counts as fully removed. Files without line counts (binary, or `--paths` mode) are left out.
 */
function removalRatio(changes: ParsedChange[]): number {
  let removed = 0;
  let base = 0;
  for (const c of changes) {
    if (c.baseLines === undefined) continue;
    base += c.baseLines;
    removed += c.kind === "deleted" ? c.baseLines : Math.min(c.removedLines ?? 0, c.baseLines);
  }
  return base === 0 ? 0 : removed / base;
}

/** Every line of a file that had some was removed and none added. */
const isEmptied = (c: ParsedChange) =>
  c.kind === "modified" &&
  c.addedLines === 0 &&
  c.baseLines !== undefined &&
  c.baseLines > 0 &&
  (c.removedLines ?? 0) >= c.baseLines;

function featureFinding(
  f: Feature,
  touched: ParsedChange[],
  maxRatio: number,
  decisionId: string | undefined,
): GuardFinding {
  const paths = touched.map((c) => c.path);
  const base = { paths, featureId: f.id };
  const name = `"${f.title}"`;
  const movedOut = touched.filter(
    (c) =>
      c.kind === "renamed" &&
      c.from !== undefined &&
      covers(f.paths, c.from) &&
      !covers(f.paths, c.path),
  );
  const moveHint =
    movedOut.length === 0
      ? ""
      : ` ${movedOut.map((c) => `${c.from} → ${c.path}`).join(", ")} moved out of the feature. Update its paths with \`${CLI_NAME} feature update ${f.id} --paths <globs>\`.`;
  if (f.protected) {
    const deleted = touched.filter((c) => c.kind === "deleted").map((c) => c.path);
    // An emptied file loses all its behaviour, as a deleted one does. It is checked per file, so
    // a small edit to a big file in the same feature cannot dilute it (review WP10).
    const emptied = touched.filter(isEmptied).map((c) => c.path);
    const ratio = removalRatio(touched);
    const rule: GuardRule | undefined =
      deleted.length + emptied.length > 0
        ? "protected-delete"
        : ratio > maxRatio
          ? "protected-gutted"
          : undefined;
    if (rule) {
      const removals = [
        deleted.length > 0 ? `deletes ${deleted.join(", ")}` : "",
        emptied.length > 0 ? `empties ${emptied.join(", ")}` : "",
      ].filter(Boolean);
      const what =
        rule === "protected-delete"
          ? `${removals.join(" and ")} from shipped, protected feature ${name}`
          : `removes ${Math.round(ratio * 100)}% of the changed lines of shipped, protected feature ${name} (limit ${Math.round(maxRatio * 100)}%)`;
      if (decisionId) {
        return {
          ...base,
          level: "warn",
          rule,
          decisionId,
          message: `This ${what}; allowed by decision ${decisionId}.${moveHint}`,
        };
      }
      return { ...base, level: "blocked", rule, message: `This ${what}.${moveHint}` };
    }
  }
  if (
    movedOut.length > 0 &&
    touched.every((c) => c.kind === "renamed" && !covers(f.paths, c.path))
  ) {
    return {
      ...base,
      level: "warn",
      rule: "renamed-out",
      message: `${movedOut.map((c) => `${c.from} → ${c.path}`).join(", ")} moved out of shipped feature ${name}. Update its paths with \`${CLI_NAME} feature update ${f.id} --paths <globs>\`.`,
    };
  }
  return {
    ...base,
    level: "warn",
    rule: "shipped-touched",
    message: `${paths.join(", ")} belong${paths.length > 1 ? "" : "s"} to shipped feature ${name}.${moveHint}`,
  };
}

/**
 * Checks changed paths against shipped features and other agents' locks. Read-only.
 * - A path inside another actor's exclusive lock is blocked; a shared lock warns.
 * - Deleting a file of a shipped, protected feature, or removing more than `maxRemovalRatio` of
 *   its changed lines, is blocked unless a Decision lists that feature.
 * - Any other change to a shipped feature warns.
 */
export async function checkChanges(ctx: ServiceContext, input: unknown): Promise<GuardResult> {
  const { changes, maxRemovalRatio } = parseInput(CheckChangesInput, input);
  return ctx.store.read(async (r) => {
    const findings: GuardFinding[] = [];

    for (const lock of await othersLiveLocks(r, ctx)) {
      const paths = changes.filter((c) => touches(lock.paths, c)).map((c) => c.path);
      if (paths.length > 0)
        findings.push(lockFinding(lock, await actorName(r, lock.actorId), paths));
    }

    // This runs on every commit: read shipped features by index, and decisions only when the
    // change touches one of them.
    const shipped = await listAll(r, ctx, "feature", { status: ["shipped"] });
    const hit = shipped
      .filter(isGuardedFeature)
      .map((f) => ({ f, touched: changes.filter((c) => touches(f.paths, c)) }))
      .filter(({ touched }) => touched.length > 0);
    if (hit.length > 0) {
      // The newest Decision listing each feature wins.
      const decisions = new Map<string, string>();
      for (const d of await listAll(r, ctx, "decision")) {
        for (const id of d.featureIds) decisions.set(id, d.id);
      }
      for (const { f, touched } of hit) {
        findings.push(featureFinding(f, touched, maxRemovalRatio, decisions.get(f.id)));
      }
    }

    const verdict: GuardVerdict = findings.some((f) => f.level === "blocked")
      ? "blocked"
      : findings.length > 0
        ? "warn"
        : "ok";
    return { verdict, findings };
  });
}

/**
 * Writes one `guard` activity row per finding, so warnings and overrides are on record with the
 * actor. `override` marks a run where the caller let a blocked change through (`SATI_GUARD=off`).
 */
export async function recordGuard(
  ctx: ServiceContext,
  result: GuardResult,
  opts: { override?: boolean } = {},
): Promise<void> {
  if (result.findings.length === 0) return;
  await ctx.store.write(async (w) => {
    for (const f of result.findings) {
      const [entity, entityId] = f.featureId
        ? (["feature", f.featureId] as const)
        : (["lock", f.lockId as string] as const);
      await logActivity(w, ctx, "guard", entity, entityId, {
        rule: f.rule,
        level: f.level,
        paths: f.paths,
        override: opts.override ?? false,
      });
    }
  });
}
