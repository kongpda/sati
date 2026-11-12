import {
  BRIEF_TOOLS,
  type BriefTools,
  CLI_NAME,
  readSettings,
  SatiError,
  shortHandle,
  type Task,
  warningLines,
  worktreeWarnings,
} from "@sati/core";
import { defineCommand } from "citty";
import { readStdin } from "../runtime/input.js";
import { closeRuntime, openRuntime } from "../runtime/location.js";
import { printError } from "../runtime/output.js";

/** The part of Claude Code's hook input we read. */
interface HookInput {
  hook_event_name?: string;
  stop_hook_active?: boolean;
}

function readHookInput(): HookInput {
  try {
    const value: unknown = JSON.parse(readStdin() || "{}");
    return value && typeof value === "object" ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

/** Tasks this caller still holds a live claim on, plus the idle hint when auto-continue is on. */
async function heldTasks(): Promise<{ held: Task[]; idle: string | null; warnings: string[] }> {
  const { ctx, project, actor } = await openRuntime();
  const now = ctx.clock.now().toISOString();
  const tasks = await ctx.store.read((r) =>
    r.list("task", ctx.projectId, { status: ["in_progress", "review", "blocked"], limit: 500 }),
  );
  const held = tasks.filter((t) => t.claim?.actorId === ctx.actorId && t.claim.leaseUntil > now);
  const settings = readSettings(project.settings);
  const idle =
    held.length === 0 && settings.autoContinue && actor.kind === "agent"
      ? `No claim. Run \`${CLI_NAME} next\` to take the top ready task.`
      : null;
  // Before the agent stops is the last cheap moment to hear that its edits collide.
  const warnings =
    held.length > 0 && actor.kind === "agent" && settings.kind !== "general"
      ? warningLines(await worktreeWarnings(ctx))
      : [];
  return { held, idle, warnings };
}

/** What to do with a held task, in the tools the agent has. */
function finishHint(tools: BriefTools, held: Task[]): string {
  if (tools === "mcp") {
    return (
      "If the work is finished, call task_complete with a summary and the files touched; " +
      "otherwise call task_update to set its status."
    );
  }
  const id = held.length === 1 && held[0] ? shortHandle(held[0].id) : "<id>";
  return (
    `If the work is finished, run \`${CLI_NAME} task complete ${id} --summary "..." --files a,b\`; ` +
    `otherwise run \`${CLI_NAME} task update ${id} --status <status>\`.`
  );
}

export default defineCommand({
  meta: {
    name: "nudge",
    description:
      "Stop hook: remind the agent to complete or update the tasks it holds, and an idle agent to run next",
  },
  args: {
    tools: {
      type: "string",
      description: "How the reminder says to finish: mcp (default) names tools, cli names commands",
    },
  },
  run: async ({ args }) => {
    const tools = (args.tools ?? "mcp") as BriefTools;
    if (!BRIEF_TOOLS.includes(tools)) {
      printError(new SatiError("USAGE", "--tools must be mcp or cli."), false);
      // Exit 1, not 2: Claude Code treats exit 2 from a Stop hook as "block".
      process.exitCode = 1;
      return;
    }
    const input = readHookInput();
    let held: Task[];
    let idle: string | null = null;
    let warnings: string[] = [];
    try {
      const found = await heldTasks();
      held = found.held;
      idle = found.idle;
      warnings = found.warnings;
    } catch (err) {
      // Exit 1, not the usual code: Claude Code treats exit 2 from a Stop hook as "block".
      printError(err, false);
      process.exitCode = 1;
      return;
    } finally {
      await closeRuntime();
    }
    if (held.length === 0) {
      if (!idle) return;
      if (input.hook_event_name === "Stop" && !input.stop_hook_active) {
        process.stdout.write(`${JSON.stringify({ decision: "block", reason: idle })}\n`);
      } else {
        process.stdout.write(`${idle}\n`);
      }
      return;
    }
    const list = held.map((t) => `${shortHandle(t.id)} (${t.title})`).join(", ");
    const reason =
      `You still hold ${list}. ${finishHint(tools, held)}` +
      (warnings.length ? ` Before you commit: ${warnings.join(" ")}` : "");
    // Block the stop once; `stop_hook_active` means we already did, so let it end.
    if (input.hook_event_name === "Stop" && !input.stop_hook_active) {
      process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    } else {
      process.stdout.write(`${reason}\n`);
    }
  },
});
