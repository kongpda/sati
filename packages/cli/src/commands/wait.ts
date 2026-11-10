import { readFileSync } from "node:fs";
import { CLI_NAME, markWaiting, resolveId, SatiError, shortHandle, type Task } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { closeRuntime, execute, openRuntime, printError, withExport } from "../runtime.js";

/** The part of Claude Code's Notification and UserPromptSubmit hook input we read. */
interface HookInput {
  hook_event_name?: string;
  message?: string;
  notification_type?: string;
}

/**
 * What a hook event means for the caller's claims: a permission prompt or a question waits on a
 * person, the person's next prompt answers it. Other notifications (auth, idle after the agent
 * finished its turn with no claim) change nothing.
 */
export function hookWaiting(
  input: HookInput,
): { kind: "question" | "permission"; text: string } | null | undefined {
  if (input.hook_event_name === "UserPromptSubmit") return null;
  if (input.hook_event_name !== "Notification") return undefined;
  const text = (input.message ?? "").trim().slice(0, 500) || "Waiting for your input.";
  const type = input.notification_type;
  if (type === "permission_prompt" || (!type && /permission/i.test(text))) {
    return { kind: "permission", text };
  }
  if (type === "idle_prompt" || type === "elicitation_dialog" || !type) {
    return { kind: "question", text };
  }
  return undefined;
}

/**
 * Claude Code hook: never blocks and prints nothing, so a broken project cannot stall the agent;
 * errors go to stderr with exit 1, which Claude Code shows but does not treat as a block.
 */
async function runHook(): Promise<void> {
  try {
    const raw = process.stdin.isTTY ? "{}" : readFileSync(0, "utf8");
    const parsed: unknown = JSON.parse(raw || "{}");
    const input = parsed && typeof parsed === "object" ? (parsed as HookInput) : {};
    const waiting = hookWaiting(input);
    if (waiting === undefined) return;
    // No task: every task the caller holds. With none held, nothing is written. Exported like
    // any other command's write, so .sati/ never lags behind the database.
    await withExport(await openRuntime(), ({ ctx }) => markWaiting(ctx, { waiting }));
  } catch (err) {
    printError(err, false);
    process.exitCode = 1;
  } finally {
    await closeRuntime();
  }
}

export default defineCommand({
  meta: {
    name: "wait",
    description: "Say you are waiting on a person (a question), or that they answered (--clear)",
  },
  args: {
    question: {
      type: "positional",
      required: false,
      description: "What you need answered (required unless --clear)",
    },
    task: { type: "string", description: "Task id or handle (default: every task you hold)" },
    clear: { type: "boolean", description: "The person answered; stop waiting" },
    hook: {
      type: "boolean",
      description:
        "Claude Code Notification / UserPromptSubmit hook (prints nothing; other flags are ignored)",
    },
    ...json,
  },
  run: async ({ args }) => {
    if (args.hook) return runHook();
    return execute(
      args.json,
      async ({ ctx }) => {
        if (!args.clear && !args.question) {
          throw new SatiError("USAGE", "Say what you are waiting for, or pass --clear.", {
            hint: `Run \`${CLI_NAME} wait "Which region should we deploy to?"\`.`,
          });
        }
        const taskId = args.task ? await resolveId(ctx, "task", args.task) : undefined;
        return markWaiting(ctx, {
          taskId,
          waiting: args.clear ? null : { kind: "question", text: args.question },
        });
      },
      (tasks: Task[]) => {
        if (tasks.length === 0) return "You hold no task, so nothing is waiting.";
        const ids = tasks.map((t) => shortHandle(t.id)).join(", ");
        return args.clear ? `No longer waiting: ${ids}.` : `Waiting on a person: ${ids}.`;
      },
    );
  },
});
