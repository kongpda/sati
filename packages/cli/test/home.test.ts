import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type BoardColumn, boardText } from "../src/board.js";
import { bin, sati, satiJson, tempRepo } from "./helpers.js";

interface Task {
  id: string;
  title: string;
  status: string;
}

const card = (n: number, status: string, priority = "medium") => ({
  id: `tsk_01M778NEE0KJ2N97KDPZ8GDX${String(n).padStart(2, "0")}`,
  title: `Task number ${n}`,
  status,
  priority,
});

describe("boardText", () => {
  const columns: BoardColumn[] = [
    {
      status: "todo",
      tasks: [card(1, "todo", "urgent"), card(2, "todo"), card(3, "todo")],
      capped: false,
    },
    { status: "in_progress", tasks: [card(4, "in_progress")], capped: false },
    { status: "done", tasks: [], capped: false },
  ];

  // The point of the board is to see the columns next to each other. A line must hold one card
  // of each column, and no line may be wider than the terminal, or it wraps and the columns break.
  it("puts the columns side by side when they fit", () => {
    const text = boardText(columns, { rich: true, width: 100, perColumn: 10 });
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/To do 3\s+In progress 1\s+Done 0/u);
    expect(lines[2]).toMatch(/8gdx01.*8gdx04.*none/u);
    expect(lines[2]).toContain("! Task number 1");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("stacks the columns in a narrow terminal", () => {
    const text = boardText(columns, { rich: true, width: 50, perColumn: 10 });
    const lines = text.split("\n");
    expect(lines[0]).toContain("To do");
    expect(lines.findIndex((l) => l.includes("In progress"))).toBeGreaterThan(3);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(50);
  });

  // A column of 300 done tasks must not push the rest off the screen, and must not look like 2.
  it("shows the first rows of a long column and counts the rest", () => {
    const text = boardText(columns, { rich: true, width: 100, perColumn: 2 });
    expect(text).not.toContain("Task number 3");
    expect(text).toContain("+1 more");
    const capped = boardText([{ ...columns[0], capped: true } as BoardColumn], {
      rich: true,
      width: 100,
      perColumn: 2,
    });
    expect(capped).toContain("To do 3+");
    expect(capped).toContain("+1 or more more");
  });

  // An agent or a pipe gets every task whole, one per line, with the status to grep for.
  it("prints one whole line per task where the layout is plain", () => {
    const text = boardText(columns, { rich: false, width: 40, perColumn: 1 });
    expect(text.split("\n")).toHaveLength(4);
    expect(text).toContain("in_progress");
  });
});

describe("sati task list --board", () => {
  it("lists tasks in the board's column order, without cancelled ones", async () => {
    const dir = await tempRepo({ init: true });
    const todo = satiJson<Task>(dir, "task", "create", "Todo one").data;
    const gone = satiJson<Task>(dir, "task", "create", "Dropped").data;
    satiJson<Task>(dir, "task", "create", "Later", "--status", "backlog");
    expect(sati(dir, "task", "update", gone.id, "--status", "cancelled").code).toBe(0);
    const r = sati(dir, "task", "list", "--board");
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Later");
    expect(lines[1]).toContain("Todo one");

    const grouped = satiJson<{ status: string; tasks: Task[] }[]>(dir, "task", "list", "--board");
    expect(grouped.data.map((c) => c.status)).toEqual([
      "backlog",
      "todo",
      "in_progress",
      "review",
      "blocked",
      "done",
    ]);
    expect(grouped.data[1]?.tasks.map((t) => t.id)).toEqual([todo.id]);
  });

  it("refuses flags that mean a different list", async () => {
    const dir = await tempRepo({ init: true });
    const r = sati(dir, "task", "list", "--board", "--ready");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--board does not go with --ready.");
  });
});

/** Starts `sati` and collects what it prints; `until` resolves once the text matches. */
function start(dir: string, args: string[]) {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SATI_ACTOR: "tester", CLAUDECODE: "", AI_AGENT: "" },
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  const until = async (want: RegExp) => {
    const end = Date.now() + 5000;
    while (!want.test(out)) {
      if (Date.now() > end) throw new Error(`No ${want} in:\n${out}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { child, closed, until, text: () => out };
}

describe("sati activity --follow", () => {
  // The live view for a person with no board open: a write by another process must show up
  // without a restart, and Ctrl-C is the normal way out, not an error.
  it("prints rows written after it started, and stops on Ctrl-C with exit 0", async () => {
    const dir = await tempRepo({ init: true });
    satiJson<Task>(dir, "task", "create", "Before");
    const f = start(dir, ["activity", "--follow"]);
    await f.until(/create task/u);
    const later = satiJson<Task>(dir, "task", "create", "After").data;
    await f.until(new RegExp(later.id, "u"));
    // Each row is printed once.
    expect(f.text().split(later.id)).toHaveLength(2);
    f.child.kill("SIGINT");
    expect(await f.closed).toBe(0);
  });

  it("prints one JSON object per line with --json, for the task asked for", async () => {
    const dir = await tempRepo({ init: true });
    const mine = satiJson<Task>(dir, "task", "create", "Mine").data;
    const other = satiJson<Task>(dir, "task", "create", "Other").data;
    const f = start(dir, ["activity", "--follow", "--json", "--task", mine.id]);
    await f.until(/"verb":"create"/u);
    expect(sati(dir, "task", "update", other.id, "--priority", "low").code).toBe(0);
    expect(sati(dir, "task", "update", mine.id, "--priority", "high").code).toBe(0);
    await f.until(/"verb":"update"/u);
    f.child.kill("SIGINT");
    expect(await f.closed).toBe(0);
    const rows = f
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { entityId: string; verb: string });
    expect(rows.map((r) => r.verb)).toEqual(["create", "update"]);
    expect(rows.every((r) => r.entityId === mine.id)).toBe(true);
  });

  it("reports a bad flag and exits, instead of following nothing", async () => {
    const dir = await tempRepo({ init: true });
    const r = sati(dir, "activity", "--follow", "--since", "soon");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--since must be a time");
  });
});

const PTY = fileURLToPath(new URL("./support/pty-run.py", import.meta.url));
const python =
  process.platform !== "win32" &&
  spawnSync("python3", ["-c", "import pty, os; os.waitstatus_to_exitcode"]).status === 0;

const typed = (dir: string, prompt: string, keys: string, args: string[], env = {}) =>
  spawnSync("python3", [PTY, prompt, keys, process.execPath, bin, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, SATI_ACTOR: "tester", CLAUDECODE: "", AI_AGENT: "", ...env },
  });

const UP_ENTER = "\\x1b[A\\r";

describe.skipIf(!python)("a bare sati", () => {
  // A person who types `sati` wants to know what waits and what to do next. The menu runs the
  // same commands they could type, so what it shows is what those commands show.
  it("shows a person the status and a menu, runs the choice, and comes back", async () => {
    const dir = await tempRepo({ init: true });
    satiJson<Task>(dir, "task", "create", "Ready one");
    const r = typed(dir, "What next|||What next", `\\r|||${UP_ENTER}`, []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Needs you");
    expect(r.stdout).toMatch(/Ready\s+.*1/u);
    expect(r.stdout).toContain("sati --help for commands");
    // Enter on the first entry ran the inbox; the menu then showed again and Quit left.
    expect(r.stdout).toContain("Inbox for");
    expect(r.stdout.split("What next").length).toBeGreaterThan(2);
  });

  it("leaves on Ctrl-C with exit 0", async () => {
    const dir = await tempRepo({ init: true });
    const r = typed(dir, "What next", "\\x03", []);
    expect(r.status).toBe(0);
  });

  // Agents run `sati` in pseudo-terminals. A menu there would hang their tool call.
  it("prints help and exit code 2 for an agent, with --no-input, or outside a project", async () => {
    const dir = await tempRepo({ init: true });
    const outside = await tempRepo();
    const cases: [string, string[], Record<string, string>][] = [
      [dir, [], { CLAUDECODE: "1" }],
      [dir, [], { AI_AGENT: "codex" }],
      [dir, ["--no-input"], {}],
      [outside, [], {}],
    ];
    for (const [cwd, args, env] of cases) {
      const r = typed(cwd, "What next", "\\x03", args, env);
      expect(r.status, JSON.stringify(env)).toBe(2);
      expect(r.stdout).not.toContain("What next");
      expect(r.stdout).toMatch(/usage/iu);
    }
  });
});
