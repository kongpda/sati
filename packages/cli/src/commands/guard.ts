import { readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  approvedCards,
  CLI_NAME,
  checkChanges,
  ERROR_EXIT_CODES,
  type GuardResult,
  hookBypass,
  parseShellChanges,
  readSettings,
  recordGuard,
  SatiError,
} from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { fileSha256 } from "../file-hash.js";
import { type Change, rangeChanges, stagedChanges } from "../git.js";
import { readProjectConfig } from "../runtime/config.js";
import { list, parseJson, readStdin } from "../runtime/input.js";
import { closeRuntime, openRuntime, type Runtime } from "../runtime/location.js";
import { printError } from "../runtime/output.js";
import { clean, polish } from "../term.js";

/** `SATI_GUARD=off` lets one blocked run through; the override is logged. */
const overridden = () => process.env.SATI_GUARD === "off";

function maxRemovalRatio(root: string): number | undefined {
  return readProjectConfig(root)?.guard?.maxRemovalRatio;
}

/** realpath of `path`, or of its deepest existing parent plus the missing tail (a new file). */
function realish(path: string): string {
  const tail: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync.native(at), ...tail.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return path;
      tail.push(at.slice(up.length).replace(/^[\\/]+/, ""));
      at = up;
    }
  }
}

/**
 * Repo-relative form (with `/`) of a path given relative to `cwd`; undefined when it is outside
 * the repo. Both sides go through realpath: with a symlinked cwd (/tmp -> /private/tmp) a plain
 * `relative` calls everything outside the repo and the guard would pass silently.
 */
function inRepo(root: string, cwd: string, path: string): string | undefined {
  const rel = relative(realish(root), realish(resolve(cwd, path)));
  // A file may be named `..foo`; only `..` itself or `../x` leaves the repo.
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/**
 * A path typed in a subfolder, or an absolute one, as the project-relative form core expects.
 * From the project root a relative path is already that. One outside the project is passed on
 * unchanged, so core refuses it by name.
 */
export function projectPath(rt: Runtime, path: string, cwd: string = process.cwd()): string {
  if (!isAbsolute(path) && relative(realish(rt.location.root), realish(cwd)) === "") return path;
  return inRepo(rt.location.root, cwd, path) ?? path;
}

/** True when `path`, relative to `cwd`, is the repo root itself. */
const isRepoRoot = (root: string, cwd: string, path: string) =>
  relative(realish(root), realish(resolve(cwd, path))) === "";

/** A general project has no features or file locks to protect, so the guard has nothing to do. */
const guardOff = (rt: Runtime) => readSettings(rt.project.settings).kind === "general";

/**
 * The guard's verdict on `changes` with this project's settings; `review` shows the same one.
 * `made` says the changes are on disk already (a staged diff, a commit range) and not an edit
 * about to happen: only then can an approved file be compared with its approved bytes.
 */
export async function projectVerdict(
  rt: Runtime,
  changes: Change[],
  made = true,
): Promise<GuardResult> {
  if (changes.length === 0) return { verdict: "ok", findings: [] };
  // An approved file that still has its approved bytes did not change, whatever touched it.
  const approved = new Set((await approvedCards(rt.ctx)).map((c) => c.path));
  if (approved.size === 0 && guardOff(rt)) return { verdict: "ok", findings: [] };
  const hashed = changes.map((c): Change & { contentHash?: string } => {
    if (!made || c.kind === "deleted" || !approved.has(c.path)) return c;
    const contentHash = fileSha256(resolve(rt.location.root, c.path));
    return contentHash === undefined ? c : { ...c, contentHash };
  });
  const ratio = maxRemovalRatio(rt.location.root);
  return checkChanges(rt.ctx, {
    changes: hashed,
    approvedOnly: guardOff(rt),
    ...(ratio === undefined ? {} : { maxRemovalRatio: ratio }),
  });
}

async function check(
  rt: Runtime,
  changes: Change[],
  record: boolean,
  made: boolean,
): Promise<GuardResult> {
  const result = await projectVerdict(rt, changes, made);
  const override = result.verdict === "blocked" && overridden();
  if (record || override) await recordGuard(rt.ctx, result, { override });
  return result;
}

function render(r: GuardResult): string {
  if (r.verdict === "ok") return "Guard: ok.";
  const lines = r.findings.map(
    (f) => `${f.level === "blocked" ? "blocked" : "warning"}: ${f.message}`,
  );
  if (r.verdict === "blocked") {
    lines.push(
      overridden()
        ? "Blocked changes let through by SATI_GUARD=off; the override is logged."
        : r.findings.every((f) => f.level !== "blocked" || f.rule === "approved-changed")
          ? "Ask the person who approved it, or override once with SATI_GUARD=off (logged)."
          : r.findings.every((f) => f.level !== "blocked" || f.rule === "locked")
            ? "Ask the lock holder or wait for the lease to end, or override once with SATI_GUARD=off (logged)."
            : `Record a decision on the feature (\`${CLI_NAME} decision record --features <id>\`), ask the lock holder, or override once with SATI_GUARD=off (logged).`,
    );
  }
  return lines.join("\n");
}

/** The part of Claude Code's PreToolUse input we read. */
interface HookInput {
  cwd?: string;
  tool_input?: { file_path?: unknown; notebook_path?: unknown; command?: unknown };
}

/**
 * PreToolUse hook for Edit / Write: exit 2 with the reason on stderr blocks the edit, and Claude
 * Code shows the reason to the agent. Warnings go back as `additionalContext`.
 */
async function runHook(): Promise<void> {
  let rt: Runtime | undefined;
  try {
    const input = parseJson(readStdin(), "The hook input", "USAGE", {
      hint: "Claude Code pipes the edit as JSON on stdin; run --hook only from its PreToolUse hook.",
    }) as HookInput;
    const cwd = input.cwd ?? process.cwd();
    const command = input.tool_input?.command;
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    const bypass = typeof command === "string" ? hookBypass(command) : undefined;
    const shellChanges = typeof command === "string" ? parseShellChanges(command) : [];
    // Most Bash calls touch nothing we guard: skip opening the database for them.
    if (!bypass && shellChanges.length === 0 && typeof target !== "string") return;
    rt = await openRuntime(cwd);
    // A general project guards approved files only; a commit that skips hooks is its own business.
    if (bypass && !guardOff(rt) && !overridden()) {
      process.stderr.write(
        `blocked: ${bypass} Commit without it so the guard runs, or override once with SATI_GUARD=off (logged).\n`,
      );
      process.exitCode = 2;
      return;
    }
    const root = rt.location.root;
    const changes: Change[] =
      typeof command === "string"
        ? shellChanges.flatMap((change): Change[] => {
            // `rm -rf .` (or the root by name) removes everything at the top of the repo.
            if (isRepoRoot(root, cwd, change.from ?? change.path)) {
              return readdirSync(root)
                .filter((name) => name !== ".git")
                .map((name): Change => ({ path: name, kind: "deleted" }));
            }
            const path = inRepo(root, cwd, change.path);
            const from = change.from === undefined ? undefined : inRepo(root, cwd, change.from);
            // Moving a file out of the repo removes it from the repo.
            if (path === undefined)
              return from === undefined ? [] : [{ path: from, kind: "deleted" }];
            if (change.kind === "renamed" && from === undefined) return [];
            return [{ path, kind: change.kind, ...(from === undefined ? {} : { from }) }];
          })
        : typeof target === "string"
          ? [
              { path: inRepo(rt.location.root, cwd, target) ?? "", kind: "modified" as const },
            ].filter((c) => c.path !== "")
          : [];
    if (changes.length === 0) return;
    const result = await check(rt, changes, false, false);
    if (result.verdict === "blocked" && !overridden()) {
      process.stderr.write(`${clean(render(result))}\n`);
      process.exitCode = 2;
    } else if (result.verdict !== "ok") {
      const hookSpecificOutput = { hookEventName: "PreToolUse", additionalContext: render(result) };
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
    }
  } catch (err) {
    // Exit 1, not the usual code: Claude Code treats exit 2 as "block".
    printError(err, false);
    process.exitCode = 1;
  } finally {
    await closeRuntime();
  }
}

export default defineCommand({
  meta: {
    name: "guard",
    description:
      "Check changes against shipped features and other agents' locks. Pick one of --staged, --paths, --range. Exit 10 if blocked; SATI_GUARD=off lets one change through (logged)",
  },
  args: {
    staged: { type: "boolean", description: "Check the staged diff (the pre-commit hook)" },
    paths: { type: "string", description: "Check these comma-separated paths as edits" },
    hook: {
      type: "boolean",
      description: "Claude Code PreToolUse hook: read the edit from stdin. Exit 2 blocks the edit",
    },
    range: {
      type: "string",
      description: "Check a commit range, for example origin/main...HEAD",
    },
    ...json,
  },
  run: async ({ args }) => {
    if (args.hook) return runHook();
    const asJson = args.json ?? false;
    try {
      const chosen = [args.staged, args.paths, args.range].filter(Boolean).length;
      if (chosen !== 1) {
        throw new SatiError(
          "USAGE",
          chosen === 0 ? "Say what to check." : "Pick one thing to check.",
          {
            hint: `Use \`${CLI_NAME} guard --staged\`, \`${CLI_NAME} guard --paths src/a.ts\`, or \`${CLI_NAME} guard --range origin/main...HEAD\`.`,
          },
        );
      }
      const rt = await openRuntime();
      if ((args.staged || args.range) && rt.location.mode !== "git") {
        throw new SatiError("USAGE", "A commit range needs a git repository.", {
          hint: `Use \`${CLI_NAME} guard --paths <file>\` instead.`,
        });
      }
      const cwd = process.cwd();
      const changes: Change[] = args.staged
        ? stagedChanges(rt.location.root)
        : args.range
          ? rangeChanges(rt.location.root, args.range)
          : (list(args.paths) ?? []).map((p) => {
              const path = inRepo(rt.location.root, cwd, p);
              // Dropping it would print "allowed" for a path that was never checked.
              if (path === undefined) {
                throw new SatiError("USAGE", `${p} is outside this repository.`, {
                  hint: "Pass paths inside the repository, relative to it or to this folder.",
                });
              }
              return { path, kind: "modified" as const };
            });
      const result = await check(rt, changes, args.staged ?? false, !args.paths);
      process.stdout.write(
        asJson ? `${JSON.stringify(result, null, 2)}\n` : `${polish(clean(render(result)))}\n`,
      );
      if (result.verdict === "blocked" && !overridden()) {
        process.exitCode = ERROR_EXIT_CODES.BLOCKED;
      }
    } catch (err) {
      process.exitCode = printError(err, asJson);
    } finally {
      await closeRuntime();
    }
  },
});
