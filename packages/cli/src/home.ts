import { spawnSync } from "node:child_process";
import { CLI_NAME, inbox, isSatiError, listTasks } from "@sati/core";
import { askText, Cancelled, canAsk } from "./prompt.js";
import { closeRuntime, currentBranch, openRuntime, printError } from "./runtime.js";
import { bold, clean, dim } from "./term.js";

/** A list is read up to this many rows; a longer one is shown as "500+". */
const CAP = 500;

const count = (n: number) => (n >= CAP ? `${CAP}+` : String(n));
const some = (n: number, one: string, many: string) => (n ? [`${n} ${n === 1 ? one : many}`] : []);

/** The lines above the menu: what waits for the person, what is being worked on, what is ready. */
async function status(): Promise<string> {
  const rt = await openRuntime();
  try {
    const mine = await inbox(rt.ctx);
    const working = await listTasks(rt.ctx, { status: ["in_progress"], limit: CAP });
    const ready = await listTasks(rt.ctx, { ready: true, limit: CAP });
    const now = rt.ctx.clock.now().toISOString();
    const live = working.filter((t) => t.claim && t.claim.leaseUntil > now).length;
    const needs = [
      ...some(mine.approval.length, "to approve", "to approve"),
      ...some(mine.needsAnswer.length, "to answer", "to answer"),
      ...some(mine.mentions.length, "mention", "mentions"),
      ...some(mine.assigned.length, "assigned", "assigned"),
      ...some(mine.due.length, "due this week", "due this week"),
    ];
    const branch = currentBranch(rt.location);
    const head = [bold(CLI_NAME), clean(rt.project.name), ...(branch ? [dim("·"), branch] : [])];
    return [
      `${head.join("  ")}  ${dim(`${CLI_NAME} --help for commands`)}`,
      "",
      `  ${bold("Needs you  ")}  ${needs.length ? needs.join(", ") : dim("nothing")}`,
      `  ${bold("In progress")}  ${count(working.length)}${
        working.length ? dim(` (${live} with a live claim)`) : ""
      }`,
      `  ${bold("Ready      ")}  ${count(ready.length)}`,
      "",
      "",
    ].join("\n");
  } finally {
    await closeRuntime();
  }
}

/**
 * Runs one command as its own process, with this terminal: its questions, its pager and its exit
 * code behave exactly as when it is typed. Ctrl-C stops the command (the board, a long list) and
 * comes back to the menu.
 */
function run(args: string[]): void {
  const script = process.argv[1];
  if (!script) return;
  const ignore = () => undefined;
  process.on("SIGINT", ignore);
  try {
    process.stdout.write(`${dim(`${CLI_NAME} ${args.join(" ")}`)}\n`);
    spawnSync(process.execPath, [...process.execArgv, script, ...args], { stdio: "inherit" });
  } finally {
    process.off("SIGINT", ignore);
  }
}

const MENU = [
  { value: "inbox", label: "Inbox", hint: "what waits for you" },
  { value: "claim", label: "Claim a task" },
  { value: "create", label: "New task" },
  { value: "search", label: "Search" },
  { value: "activity", label: "Recent activity" },
  { value: "board", label: "Open the board", hint: "in a browser; Ctrl-C comes back" },
  { value: "quit", label: "Quit" },
];

/**
 * What a bare `sati` shows a person at a terminal: a short status and a menu of the common
 * commands. False when there is nobody to ask or no project here; the caller then prints help,
 * as it always did. Nothing is drawn on an alternate screen: the output stays in the scrollback.
 */
export async function home(): Promise<boolean> {
  if (!canAsk()) return false;
  const clack = await import("@clack/prompts");
  for (let first = true; ; first = false) {
    try {
      process.stdout.write(await status());
    } catch (err) {
      if (first && isSatiError(err) && err.code === "NOT_INITIALIZED") return false;
      process.exitCode = printError(err, false);
      return true;
    }
    const choice = await clack.select<string>({ message: "What next", options: MENU });
    if (clack.isCancel(choice) || choice === "quit") return true;
    if (choice === "inbox") run(["inbox"]);
    if (choice === "claim") run(["task", "claim"]);
    if (choice === "create") run(["task", "create"]);
    if (choice === "activity") run(["activity", "--limit", "15"]);
    if (choice === "board") run(["ui"]);
    if (choice === "search") {
      try {
        run(["search", await askText("Search for")]);
      } catch (err) {
        // Leaving the question goes back to the menu.
        if (!(err instanceof Cancelled)) throw err;
      }
    }
    process.stdout.write("\n");
  }
}
