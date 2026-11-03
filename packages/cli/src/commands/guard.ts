import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  BrainConfigSchema,
  BrainError,
  CONFIG_DIR,
  CONFIG_FILE,
  checkChanges,
  ERROR_EXIT_CODES,
  type GuardResult,
  recordGuard,
} from "@brain/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { type Change, stagedChanges } from "../git.js";
import { closeRuntime, list, openRuntime, printError, type Runtime } from "../runtime.js";

/** `BRAIN_GUARD=off` lets one blocked run through; the override is logged. */
const overridden = () => process.env.BRAIN_GUARD === "off";

function maxRemovalRatio(root: string): number | undefined {
  const file = join(root, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = BrainConfigSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new BrainError("VALIDATION", `Invalid ${file}.`);
  return parsed.data.guard?.maxRemovalRatio;
}

/** Repo-relative form of a path given relative to `cwd`; undefined when it is outside the repo. */
function inRepo(root: string, cwd: string, path: string): string | undefined {
  const rel = relative(root, resolve(cwd, path));
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
}

async function check(rt: Runtime, changes: Change[], record: boolean): Promise<GuardResult> {
  if (changes.length === 0) return { verdict: "ok", findings: [] };
  const ratio = maxRemovalRatio(rt.location.root);
  const result = await checkChanges(rt.ctx, {
    changes,
    ...(ratio === undefined ? {} : { maxRemovalRatio: ratio }),
  });
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
        ? "Blocked changes let through by BRAIN_GUARD=off; the override is logged."
        : "Record a decision on the feature (`brain decision record --feature <id>`), ask the lock holder, or override once with BRAIN_GUARD=off (logged).",
    );
  }
  return lines.join("\n");
}

/** The part of Claude Code's PreToolUse input we read. */
interface HookInput {
  cwd?: string;
  tool_input?: { file_path?: unknown; notebook_path?: unknown };
}

/**
 * PreToolUse hook for Edit / Write: exit 2 with the reason on stderr blocks the edit, and Claude
 * Code shows the reason to the agent. Warnings go back as `additionalContext`.
 */
async function runHook(): Promise<void> {
  let rt: Runtime | undefined;
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (typeof target !== "string") return;
    rt = await openRuntime(input.cwd ?? process.cwd());
    const path = inRepo(rt.location.root, input.cwd ?? process.cwd(), target);
    if (path === undefined) return;
    const result = await check(rt, [{ path, kind: "modified" }], false);
    if (result.verdict === "blocked" && !overridden()) {
      process.stderr.write(`${render(result)}\n`);
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
    description: "Check changes against shipped features and other agents' locks",
  },
  args: {
    staged: { type: "boolean", description: "Check the staged diff (the pre-commit hook)" },
    paths: { type: "string", description: "Check these comma-separated paths as edits" },
    hook: { type: "boolean", description: "Claude Code PreToolUse hook: read the edit from stdin" },
    ...json,
  },
  run: async ({ args }) => {
    if (args.hook) return runHook();
    const asJson = args.json ?? false;
    try {
      if (!args.staged && !args.paths) {
        throw new BrainError("USAGE", "Say what to check.", {
          hint: "Use `brain guard --staged`, or `brain guard --paths src/a.ts`.",
        });
      }
      const rt = await openRuntime();
      if (args.staged && rt.location.mode !== "git") {
        throw new BrainError("USAGE", "`--staged` needs a git repository.", {
          hint: "Use `brain guard --paths <file>` instead.",
        });
      }
      const cwd = process.cwd();
      const changes: Change[] = args.staged
        ? stagedChanges(rt.location.root)
        : (list(args.paths) ?? []).flatMap((p) => {
            const path = inRepo(rt.location.root, cwd, p);
            return path === undefined ? [] : [{ path, kind: "modified" as const }];
          });
      const result = await check(rt, changes, args.staged ?? false);
      process.stdout.write(asJson ? `${JSON.stringify(result, null, 2)}\n` : `${render(result)}\n`);
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
