import { readFileSync } from "node:fs";
import { shortHandle, type Task } from "@brain/core";
import { defineCommand } from "citty";
import { closeRuntime, openRuntime, printError } from "../runtime.js";

/** The part of Claude Code's hook input we read. */
interface HookInput {
  hook_event_name?: string;
  stop_hook_active?: boolean;
}

function readHookInput(): HookInput {
  if (process.stdin.isTTY) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(0, "utf8"));
    return value && typeof value === "object" ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

/** Tasks this caller still holds a live claim on. */
async function heldTasks(): Promise<Task[]> {
  const { ctx } = await openRuntime();
  const now = ctx.clock.now().toISOString();
  const tasks = await ctx.store.read((r) =>
    r.list("task", ctx.projectId, { status: ["in_progress", "review", "blocked"], limit: 500 }),
  );
  return tasks.filter((t) => t.claim?.actorId === ctx.actorId && t.claim.leaseUntil > now);
}

export default defineCommand({
  meta: {
    name: "nudge",
    description: "Stop hook: remind the agent to complete or update the tasks it holds",
  },
  run: async () => {
    const input = readHookInput();
    let held: Task[];
    try {
      held = await heldTasks();
    } catch (err) {
      // Exit 1, not the usual code: Claude Code treats exit 2 from a Stop hook as "block".
      printError(err, false);
      process.exitCode = 1;
      return;
    } finally {
      await closeRuntime();
    }
    if (held.length === 0) return;
    const list = held.map((t) => `${shortHandle(t.id)} (${t.title})`).join(", ");
    const reason =
      `You still hold ${list}. If the work is finished, call task_complete with a summary ` +
      "and the files touched; otherwise call task_update with its status and a note.";
    // Block the stop once; `stop_hook_active` means we already did, so let it end.
    if (input.hook_event_name === "Stop" && !input.stop_hook_active) {
      process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    } else {
      process.stdout.write(`${reason}\n`);
    }
  },
});
