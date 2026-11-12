import { plainIssue, type SatiError } from "@sati/core";

/** Core fields whose flag is not the field name in kebab case. */
const FLAG_NAMES: Record<string, string> = {
  actorId: "actor",
  approvedCommit: "commit",
  assigneeIds: "assign",
  dependsOn: "depends",
  dueDate: "due",
  featureId: "feature",
  featureIds: "features",
  filesTouched: "files",
  leaseMinutes: "lease",
  markdown: "file",
  milestoneId: "milestone",
  parentId: "parent",
  sourceSeen: "seen",
  sourceTokens: "tokens",
  targetDate: "date",
  taskId: "task",
};

/** Fields typed as an argument, not a flag, keep their name. */
const BARE = new Set(["input", "title"]);

const flagName = (field: string): string =>
  BARE.has(field)
    ? field
    : `--${FLAG_NAMES[field] ?? field.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)}`;

interface Issue {
  path?: unknown;
  message?: unknown;
}

/**
 * A core VALIDATION error worded for the command line: `--max-tokens` instead of `maxTokens`, and
 * one reason per flag (a bad day failed two checks and was reported twice). Undefined when the
 * error carries no issues. `--json` output keeps the raw issues.
 */
export function cliValidationMessage(e: SatiError): string | undefined {
  if (e.code !== "VALIDATION") return undefined;
  const issues = (e.details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  const byFlag = new Map<string, string>();
  for (const issue of issues as Issue[]) {
    const path = Array.isArray(issue.path) ? issue.path : [];
    const first = path.find((p): p is string => typeof p === "string") ?? "input";
    const flag = flagName(first);
    if (!byFlag.has(flag) && typeof issue.message === "string") {
      byFlag.set(flag, plainIssue(issue.message));
    }
  }
  if (byFlag.size === 0) return undefined;
  const parts = [...byFlag].slice(0, 3).map(([flag, why]) => `${flag}: ${why}`);
  return `Invalid input: ${parts.join("; ")}`;
}
