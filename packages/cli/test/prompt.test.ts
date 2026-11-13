import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canAsk } from "../src/prompt.js";
import { bin, sati, satiJson, tempRepo } from "./helpers.js";

interface Task {
  id: string;
  status: string;
  priority: string;
  reviewNote?: string | null;
}

const tty = { isTTY: true };
const pipe = { isTTY: false };

describe("canAsk", () => {
  // Scripts and agents rely on a command never waiting for a key. One wrong case here and a CI
  // job or an agent's tool call hangs until its timeout.
  it("asks only a person at a terminal who did not turn questions off", () => {
    expect(canAsk(false, {}, tty, tty)).toBe(true);
    expect(canAsk(true, {}, tty, tty)).toBe(false);
    expect(canAsk(false, {}, pipe, tty)).toBe(false);
    expect(canAsk(false, {}, tty, pipe)).toBe(false);
    expect(canAsk(false, { CLAUDECODE: "1" }, tty, tty)).toBe(false);
    expect(canAsk(false, { AI_AGENT: "codex" }, tty, tty)).toBe(false);
    expect(canAsk(false, { SATI_NO_INPUT: "1" }, tty, tty)).toBe(false);
    expect(canAsk(false, { TERM: "dumb" }, tty, tty)).toBe(false);
    // A forced rich layout is about colour, not about who is there to answer.
    expect(canAsk(false, { FORCE_COLOR: "1" }, pipe, pipe)).toBe(false);
  });
});

/** Two tasks in review, as an agent's finished work waits for a person. */
async function reviewRepo(): Promise<{ dir: string; first: Task; second: Task }> {
  const dir = await tempRepo({ init: true });
  expect(sati(dir, "settings", "--review", "all").code).toBe(0);
  const make = (title: string) => {
    const t = satiJson<Task>(dir, "task", "create", title).data;
    expect(sati(dir, "task", "claim", t.id).code).toBe(0);
    expect(sati(dir, "task", "complete", t.id, "--summary", "done", "--files", "a.ts").code).toBe(
      0,
    );
    return t;
  };
  return { dir, first: make("First"), second: make("Second") };
}

const status = (dir: string, id: string) => satiJson<Task>(dir, "task", "show", id).data.status;

describe("without a terminal, a command never waits for an answer", () => {
  // The whole of Phase 10 rests on this: a prompt added for people must not reach a script. Each
  // command runs with stdin closed and five seconds to finish.
  // About 3.5 s alone: it starts the CLI about twenty times. On a loaded machine that passed
  // 15 s and took over 80 s, so it states 90 s. Each command still has its own 5 s limit below.
  it("gives a usage error or does what it did before, within the limit", async () => {
    const { dir, first } = await reviewRepo();
    satiJson<Task>(dir, "task", "create", "Ready one");
    satiJson<Task>(dir, "task", "create", "Ready two");
    const closed = (...args: string[]) => {
      const r = spawnSync(process.execPath, [bin, ...args], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
        env: { ...process.env, SATI_ACTOR: "tester", CLAUDECODE: "", AI_AGENT: "" },
      });
      expect(r.signal, `${args.join(" ")} was still running`).toBeNull();
      return r;
    };
    const cases: [string[], number, string][] = [
      [["task", "approve"], 2, "sati task approve <id>"],
      [["task", "send-back"], 2, "Missing --reason."],
      [["task", "send-back", "--reason", "x"], 2, "sati task send-back <id>"],
      [["task", "send-back", first.id], 2, "Missing --reason."],
      [["task", "update"], 2, "sati task update <id>"],
      [["task", "update", "--priority", "high"], 2, "sati task update <id>"],
      [["task", "show"], 2, "You hold no task"],
      [["task", "claim", "--pick"], 2, "task list --ready"],
      [["task", "create"], 2, "sati task create <title>"],
      [["task", "complete"], 2, "Missing --summary."],
      [["comment", "add"], 2, "sati comment add <on>"],
      [["comment", "add", first.id], 2, "sati comment add <on> <body>"],
      [["note", "create"], 2, "sati note create <title>"],
      [["feature", "create"], 2, "sati feature create <title>"],
      [["milestone", "create"], 2, "sati milestone create <title>"],
      [["decision", "record"], 2, "sati decision record <title>"],
      [["decision", "record", "Title"], 2, "Missing --decision."],
    ];
    for (const [args, code, text] of cases) {
      const r = closed(...args);
      expect(r.status, args.join(" ")).toBe(code);
      expect(r.stderr).toContain(text);
    }
    // With several ready tasks, a script still gets the top one without a question.
    const claimed = closed("task", "claim");
    expect(claimed.status).toBe(0);
    expect(claimed.stdout).toContain("Ready one");
    expect(status(dir, first.id)).toBe("review");
    // About 3.5 s alone: it starts the CLI about twenty times. On a loaded machine that passed
    // 15 s and took over 80 s, so it states 90 s. Each command still has its own 5 s limit above.
  }, 90_000);
});

describe("review verbs", () => {
  // The verbs are names for writes that already exist. If they wrote anything else, the board,
  // `task update` and the terminal would disagree about what approving means.
  it("approve and send-back write what task update writes", async () => {
    const { dir, first, second } = await reviewRepo();
    const approved = sati(dir, "task", "approve", first.id);
    expect(approved.code).toBe(0);
    expect(approved.stdout).toContain("Approved");
    expect(status(dir, first.id)).toBe("done");

    const back = satiJson<Task>(dir, "task", "send-back", second.id, "--reason", "Add a test");
    expect(back.code).toBe(0);
    expect(back.data.status).toBe("todo");
    expect(back.data.reviewNote).toBe("Add a test");
  });

  // Approving is a person's word. The verb must not be a way round the rule in the core.
  it("refuses an agent, as task update does", async () => {
    const { dir, first } = await reviewRepo();
    const r = spawnSync(process.execPath, [bin, "task", "approve", first.id], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, SATI_ACTOR: "", CLAUDECODE: "1", AI_AGENT: "" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Only a person can approve");
    expect(status(dir, first.id)).toBe("review");
  });
});

const PTY = fileURLToPath(new URL("./support/pty-run.py", import.meta.url));
const python =
  process.platform !== "win32" &&
  spawnSync("python3", ["-c", "import pty, os; os.waitstatus_to_exitcode"]).status === 0;

/**
 * Runs in a pseudo-terminal and types `keys` once `prompt` shows. Several questions: join the
 * prompts, and the keys, with `|||`. See output.test.ts.
 */
const typed = (dir: string, prompt: string, keys: string, args: string[], env = {}) =>
  spawnSync("python3", [PTY, prompt, keys, process.execPath, bin, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, SATI_ACTOR: "tester", CLAUDECODE: "", AI_AGENT: "", ...env },
  });

const DOWN_ENTER = "\\x1b[B\\r";
const CTRL_C = "\\x03";

// Skips without python3's pty module (always on Windows); the Linux and macOS CI cells have it.
describe.skipIf(!python)("a person at a terminal", () => {
  // The choice has to reach the write. Approving the top task when the person moved to the
  // second would approve work nobody looked at.
  it("approves the task picked, and prints the command that does the same", async () => {
    const { dir, first, second } = await reviewRepo();
    const r = typed(dir, "Approve which task?", DOWN_ENTER, ["task", "approve"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Approved");
    expect(r.stdout).toMatch(/Same as: sati task approve tsk_[0-9a-z]{6}/u);
    expect(status(dir, second.id)).toBe("done");
    expect(status(dir, first.id)).toBe("review");
  });

  it("writes nothing when the person leaves the list", async () => {
    const { dir, first, second } = await reviewRepo();
    const r = typed(dir, "Approve which task?", CTRL_C, ["task", "approve"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Nothing changed.");
    expect(r.stdout).not.toContain("Same as");
    expect(status(dir, first.id)).toBe("review");
    expect(status(dir, second.id)).toBe("review");
  });

  // A reason typed at the prompt is the note the next claimer reads.
  it("asks for the reason when sending back, and stores what was typed", async () => {
    const { dir, first } = await reviewRepo();
    const r = typed(dir, "What should change?", "Add a test\\r", ["task", "send-back", first.id]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Sent back");
    expect(r.stdout).toContain("--reason 'Add a test'");
    const after = satiJson<Task>(dir, "task", "show", first.id).data;
    expect(after.status).toBe("todo");
    expect(after.reviewNote).toBe("Add a test");
  });

  it("offers the tasks for update and show when no id is typed", async () => {
    const { dir, first, second } = await reviewRepo();
    const updated = typed(dir, "Update which task?", DOWN_ENTER, [
      "task",
      "update",
      "--priority",
      "urgent",
    ]);
    expect(updated.status).toBe(0);
    expect(updated.stdout).toMatch(/Same as: sati task update tsk_[0-9a-z]{6} --priority urgent/u);
    const shown = [first, second].map((t) => satiJson<Task>(dir, "task", "show", t.id).data);
    expect(shown.filter((t) => t.priority === "urgent")).toHaveLength(1);

    const show = typed(dir, "Show which task?", "\\r", ["task", "show"]);
    expect(show.status).toBe(0);
    expect(show.stdout).toMatch(/Same as: sati task show tsk_/u);
  });

  // `task claim` took the top ready task; Enter still does. The list is there for the other one.
  it("lets a person choose among several ready tasks on claim", async () => {
    const dir = await tempRepo({ init: true });
    const top = satiJson<Task>(dir, "task", "create", "Top", "--priority", "high").data;
    const other = satiJson<Task>(dir, "task", "create", "Other").data;
    const r = typed(dir, "Claim which task?", DOWN_ENTER, ["task", "claim"]);
    expect(r.status).toBe(0);
    expect(status(dir, other.id)).toBe("in_progress");
    expect(status(dir, top.id)).toBe("todo");
  });

  // Some agent tools run commands in a pseudo-terminal. They, and a person who asked for no
  // questions, get the error a script gets.
  it("asks nothing of an agent, or with --no-input or SATI_NO_INPUT", async () => {
    const { dir, first } = await reviewRepo();
    const quiet: [string[], Record<string, string>][] = [
      [["task", "approve"], { CLAUDECODE: "1" }],
      [["task", "approve"], { AI_AGENT: "codex" }],
      [["task", "approve"], { SATI_NO_INPUT: "1" }],
      [["task", "approve", "--no-input"], {}],
      [["--no-input", "task", "update", "--priority", "low"], {}],
    ];
    for (const [args, env] of quiet) {
      const r = typed(dir, "which task?", CTRL_C, args, env);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout).toContain("Missing <id>");
      expect(r.stdout).not.toContain("which task?");
    }
    expect(status(dir, first.id)).toBe("review");
  });
});

interface Stored {
  id: string;
  title: string;
  body?: string;
  decision?: string;
  priority?: string;
}

/** An editor that writes `text` to the file it is given, as a person would and then save. */
const editor = (text: string) => `sh -c 'echo "${text}" > "$1"' --`;

/** An empty folder for the editor's temp file, so a test can see that nothing is left in it. */
function tempFolder(dir: string): string {
  const tmp = join(dir, ".tmp-edit");
  mkdirSync(tmp);
  return tmp;
}

// Skips without python3's pty module (always on Windows); the Linux and macOS CI cells have it.
describe.skipIf(!python)("a person who left an argument out", () => {
  // What is typed at the questions must be what a flag would have stored, and the line printed
  // after must be a command that stores the same.
  it("is asked for a task's title and priority", async () => {
    const dir = await tempRepo({ init: true });
    const r = typed(dir, "Task title|||Priority", `Fix login\\r|||${DOWN_ENTER}`, [
      "task",
      "create",
      "--labels",
      "auth",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      "Same as: sati task create 'Fix login' --priority high --labels auth",
    );
    const [task] = satiJson<(Stored & { labels: string[] })[]>(dir, "task", "list").data;
    expect(task).toMatchObject({ title: "Fix login", priority: "high", labels: ["auth"] });
  });

  // The files are the record of what a task changed; the guard and the next agent read them.
  // Offering what git saw keeps a person from typing paths, and from leaving them out.
  it("is asked for the summary and offered the changed files on complete", async () => {
    const dir = await tempRepo({ init: true });
    const task = satiJson<Stored>(dir, "task", "create", "Work").data;
    expect(sati(dir, "task", "claim", task.id).code).toBe(0);
    writeFileSync(join(dir, "changed.txt"), "x");
    const r = typed(dir, "What was done?|||Files touched", "Did it\\r|||\\r", ["task", "complete"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--summary 'Did it'");
    const after = satiJson<{ status: string; completion: { filesTouched: string[] } }>(
      dir,
      "task",
      "show",
      task.id,
    ).data;
    expect(after.status).toBe("done");
    expect(after.completion.filesTouched).toContain("changed.txt");
    expect(after.completion.filesTouched.some((f) => f.startsWith(".sati/"))).toBe(false);
  });

  it("writes nothing when the summary question is left", async () => {
    const dir = await tempRepo({ init: true });
    const task = satiJson<Stored>(dir, "task", "create", "Work").data;
    expect(sati(dir, "task", "claim", task.id).code).toBe(0);
    const r = typed(dir, "What was done?", CTRL_C, ["task", "complete"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Nothing changed.");
    expect(status(dir, task.id)).toBe("in_progress");
  });

  it("is asked which task and what to say for a comment", async () => {
    const dir = await tempRepo({ init: true });
    const task = satiJson<Stored>(dir, "task", "create", "Work").data;
    const r = typed(dir, "Comment on which task?|||Comment", "\\r|||Looks good\\r", [
      "comment",
      "add",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Same as: sati comment add tsk_[0-9a-z]{6} 'Looks good'/u);
    const listed = sati(dir, "comment", "list", task.id);
    expect(listed.stdout).toContain("Looks good");
  });

  // A note's text is often several lines. It is written in the person's editor, and the file it
  // was written in must not outlive the command: it can hold what a private note holds.
  it("opens the editor for a note's text and removes the file", async () => {
    const dir = await tempRepo({ init: true });
    const tmp = tempFolder(dir);
    const r = typed(dir, "Note title", "Deploy steps\\r", ["note", "create"], {
      EDITOR: editor("Run the script"),
      VISUAL: "",
      TMPDIR: tmp,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Same as: sati note create 'Deploy steps' --body 'Run the script'");
    const [note] = satiJson<Stored[]>(dir, "note", "list").data;
    const full = satiJson<Stored>(dir, "note", "show", note?.id ?? "").data;
    expect(full.body).toBe("Run the script");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("asks for one line when no editor is set", async () => {
    const dir = await tempRepo({ init: true });
    const r = typed(
      dir,
      "Decision title|||What was decided?",
      "Store\\r|||Use SQLite\\r",
      ["decision", "record"],
      { EDITOR: "", VISUAL: "" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Same as: sati decision record Store --decision 'Use SQLite'");
    const [decision] = satiJson<Stored[]>(dir, "decision", "list").data;
    expect(decision?.title).toBe("Store");
  });

  // An editor that crashes, or a file saved empty, must store nothing and leave nothing behind.
  it("stores nothing and leaves no file when the editor fails or the text is empty", async () => {
    const dir = await tempRepo({ init: true });
    const tmp = tempFolder(dir);
    const record = (EDITOR: string) =>
      typed(dir, "Decision title", "Store\\r", ["decision", "record"], {
        EDITOR,
        VISUAL: "",
        TMPDIR: tmp,
      });
    const failed = record("false");
    expect(failed.status).toBe(2);
    expect(failed.stdout).toContain("did not finish");
    expect(readdirSync(tmp)).toEqual([]);

    const empty = record("true");
    expect(empty.status).toBe(0);
    expect(empty.stdout).toContain("Nothing changed.");
    expect(readdirSync(tmp)).toEqual([]);
    expect(satiJson<Stored[]>(dir, "decision", "list").data).toEqual([]);
  });

  it("asks nothing of an agent in a pseudo-terminal", async () => {
    const dir = await tempRepo({ init: true });
    const r = typed(dir, "Task title", CTRL_C, ["task", "create"], { CLAUDECODE: "1" });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("Missing <title>");
    expect(r.stdout).not.toContain("Task title");
  });
});

// Skips without python3's pty module (always on Windows); the Linux and macOS CI cells have it.
// Review 7.8 (D26): one rule. A command that needs a title asks for it at a terminal and gives a
// usage error to a script, as `note create` and `decision record` do.
describe.skipIf(!python)("a title left out of feature create and milestone create", () => {
  it.each([
    ["feature", "Feature title", "feature"],
    ["milestone", "Milestone title", "milestone"],
  ])("%s create asks for it at a terminal", async (command, question) => {
    const dir = await tempRepo({ init: true });
    const r = typed(dir, question, "Asked for\r", [command, "create"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toContain("Same as: sati");
    const made = satiJson<{ title: string }[]>(dir, command, "list").data;
    expect(made.map((x) => x.title)).toEqual(["Asked for"]);
  });
});
