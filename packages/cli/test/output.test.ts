import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { bin, run, sati, satiJson, tempRepo } from "./helpers.js";

const ESC = "\x1b";
/**
 * What a person sees: the layout for a terminal, 80 columns wide. `WT_SESSION` is what Windows
 * Terminal sets; without it a Windows run takes the legacy console and gets `...` and `ok`.
 */
const rich = { FORCE_COLOR: "1", COLUMNS: "80", WT_SESSION: "1" };

describe("help", () => {
  // PLAN Terminal UX: colour only on a TTY. citty coloured help even into a pipe.
  it("prints no colour codes into a pipe and groups the commands", async () => {
    const dir = await tempRepo();
    const r = sati(dir, "--help");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(ESC);
    expect(r.stdout).toContain(`sati ${pkg.version}`);
    for (const heading of ["START", "WORK", "MEMORY", "HISTORY", "PROJECT", "GLOBAL OPTIONS"]) {
      expect(r.stdout).toContain(heading);
    }
    // A hidden name (review 6.5) takes no row and sits beside no command.
    expect(r.stdout).toMatch(/^ {2}card\s/mu);
    expect(r.stdout).not.toMatch(/^ {2}context\s/mu);
    expect(r.stdout).toContain("--no-color");
    for (const line of r.stdout.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("colours help for a person, and --no-color and NO_COLOR turn that off", async () => {
    const dir = await tempRepo();
    expect(run(dir, ["--help"], rich).stdout).toContain(`${ESC}[1m`);
    expect(run(dir, ["--help", "--no-color"], rich).stdout).not.toContain(ESC);
    expect(run(dir, ["--help"], { ...rich, NO_COLOR: "1" }).stdout).not.toContain(ESC);
  });

  it("shows a command's own flags, arguments and subcommands", async () => {
    const dir = await tempRepo();
    const task = sati(dir, "task", "--help").stdout;
    expect(task).toContain("USAGE  sati task <command>");
    expect(task).toMatch(/^ {2}create\s/mu);
    const create = sati(dir, "task", "create", "--help").stdout;
    expect(create).toContain("ARGUMENTS");
    expect(create).toMatch(/--priority <\w+>/u);
    expect(create).toContain("--json");
  });

  // No command is a usage mistake (exit 2), but the reader still gets the command list.
  it("prints help and exits 2 when no command is given", async () => {
    const dir = await tempRepo();
    const r = sati(dir);
    expect(r.code).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain("USAGE");
  });

  it("suggests the command when a word from another tool is used", async () => {
    const dir = await tempRepo({ init: true });
    const get = sati(dir, "task", "get", "x");
    expect(get.code).toBe(2);
    expect(get.stderr).toContain("Did you mean `sati task show`?");
    const typo = sati(dir, "tsk");
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain("Did you mean `sati task`?");
  });
});

describe("stored text is printed safely", () => {
  // A title written by a teammate's agent reaches every terminal that lists it. An escape
  // sequence in it must not run there; --json keeps the stored text, escaped by JSON.
  it("strips terminal control characters from text output, piped or not", async () => {
    const dir = await tempRepo({ init: true });
    const evil = `Fix${ESC}]52;c;ZXZpbA==\x07 login${ESC}[2J‮`;
    const made = satiJson<{ id: string; title: string }>(dir, "task", "create", evil).data;
    expect(made.title).toContain(ESC);
    for (const env of [{}, { ...rich, NO_COLOR: "1" }]) {
      for (const args of [
        ["task", "list"],
        ["task", "show", made.id],
        ["search", "login"],
      ]) {
        const r = run(dir, args, env);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("Fix login");
        expect(r.stdout).not.toContain(ESC);
        expect(r.stdout).not.toContain("‮");
      }
    }
    expect(sati(dir, "task", "list", "--json").stdout).toContain("\\u001b");
  });

  it("strips them from error messages too", async () => {
    const dir = await tempRepo({ init: true });
    const r = sati(dir, "task", "show", `tsk_${ESC}[2Jnope`);
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toContain(ESC);
  });
});

describe("output for a person", () => {
  it("lays out lists, records and doctor for a terminal and keeps the pipe format", async () => {
    const dir = await tempRepo({ init: true });
    const a = satiJson<{ id: string }>(dir, "task", "create", "Alpha", "--priority", "high").data;
    sati(dir, "task", "create", `Beta ${"long ".repeat(40)}`);
    const person = { ...rich, NO_COLOR: "1" };

    const list = run(dir, ["task", "list"], person).stdout.trimEnd().split("\n");
    expect(list).toHaveLength(2);
    for (const line of list) expect(line.length).toBeLessThanOrEqual(80);
    expect(list.some((l) => l.endsWith("…"))).toBe(true);
    // Piped: one compact row each, nothing cut.
    const plain = sati(dir, "task", "list").stdout;
    expect(plain).toMatch(/^tsk_\w+ {2}todo {2}high {2}Alpha$/mu);
    expect(plain).toContain("long long long");
    expect(plain).not.toContain("…");

    const show = run(dir, ["task", "show", a.id], person).stdout;
    expect(show).toMatch(/^Alpha$/mu);
    expect(show).toMatch(/^ {2}createdBy {2}actr_/mu);
    expect(sati(dir, "task", "show", a.id).stdout).toMatch(/^ {2}createdBy: actr_/mu);

    const made = run(dir, ["task", "create", "Gamma"], person).stdout;
    expect(made).toMatch(/^✔ Created tsk_/u);
    expect(sati(dir, "task", "create", "Delta").stdout).toMatch(/^Created tsk_/u);

    const doctor = run(dir, ["doctor"], person).stdout;
    expect(doctor).toMatch(/^[✔✖] claims\s/mu);
    expect(doctor).toMatch(/\d+ (checks passed|failed, \d+ passed)\.\n$/u);
    expect(sati(dir, "doctor").stdout).toMatch(/^(ok|fail) claims: /mu);
  });
});

describe("completion", () => {
  // The script is built from the command definitions, so a new command or flag is in it
  // without anyone remembering to add it.
  it("prints a script for each shell that names the commands and their flags", async () => {
    const dir = await tempRepo();
    for (const shell of ["bash", "zsh", "fish"]) {
      const r = sati(dir, "completion", shell);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain(ESC);
      for (const word of ["task", "claim", "priority", "no-color"]) {
        expect(r.stdout).toContain(word);
      }
    }
    // With no shell named it follows $SHELL, so one line in a profile is enough.
    expect(run(dir, ["completion"], { SHELL: "/bin/zsh" }).stdout).toContain("#compdef");
    expect(run(dir, ["completion"], { SHELL: "" }).code).toBe(2);
    const bad = sati(dir, "completion", "tcsh");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("bash");
  });

  it.skipIf(process.platform === "win32")("completes commands and flags in bash", async () => {
    const dir = await tempRepo();
    const script = sati(dir, "completion", "bash").stdout;
    const complete = (...words: string[]) =>
      spawnSync(
        "bash",
        [
          "-c",
          `${script}\nCOMP_WORDS=(sati "$@"); COMP_CWORD=$#; _sati; echo "\${COMPREPLY[@]}"`,
          "bash",
          ...words,
        ],
        { encoding: "utf8" },
      ).stdout.trim();
    expect(complete("ta")).toBe("task");
    expect(complete("task", "cl")).toBe("claim");
    expect(complete("task", "create", "A title", "--pri")).toBe("--priority");
    // A word that is no subcommand (an argument) falls back to the command's own flags.
    expect(complete("recall", "question", "--js")).toBe("--json");
  });

  const fish = spawnSync("fish", ["--version"]).status === 0;
  it.skipIf(!fish)("completes commands and flags in fish, without offering files", async () => {
    const dir = await tempRepo();
    const script = sati(dir, "completion", "fish").stdout;
    const complete = (line: string) =>
      spawnSync("fish", ["--no-config", "-c", `${script}\ncomplete -C '${line}'`], {
        encoding: "utf8",
        cwd: dir,
      })
        .stdout.split("\n")
        .filter(Boolean)
        .map((l) => l.split("\t")[0]);
    expect(complete("sati ta")).toEqual(["task"]);
    expect(complete("sati task cl")).toEqual(["claim"]);
    expect(complete("sati task create x --pri")).toEqual(["--priority"]);
    expect(complete("sati task --he")).toEqual(["--help"]);
  });
});

describe("task claim --pick", () => {
  // The picker asks a question; without a terminal it must say what to run, not hang.
  it("refuses without a terminal and names the two commands that do the same", async () => {
    const dir = await tempRepo();
    expect(sati(dir, "init", "--yes").code).toBe(0);
    const r = sati(dir, "task", "claim", "--pick");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("task list --ready");
  });
});

/**
 * Runs a command inside a pseudo-terminal 100 columns wide, types the keys once the prompt shows,
 * and prints what the terminal showed. Python ships a pty module; Node has none without a native
 * add-on. The script gives up after 30 s, so a prompt that never shows fails instead of hanging.
 */
const PTY = fileURLToPath(new URL("./support/pty-run.py", import.meta.url));

describe("task claim --pick in a terminal", () => {
  interface Task {
    id: string;
    status: string;
  }
  const python =
    process.platform !== "win32" &&
    spawnSync("python3", ["-c", "import pty, os; os.waitstatus_to_exitcode"]).status === 0;
  const pick = (dir: string, keys: string) =>
    spawnSync(
      "python3",
      [PTY, "Claim which task?", keys, process.execPath, bin, "task", "claim", "--pick"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, SATI_ACTOR: "tester", CLAUDECODE: "", AI_AGENT: "" },
      },
    );

  // The picker exists so a person can take a task that is not the top one. If the choice did not
  // reach the claim, `--pick` would be `task claim` with extra steps.
  it.skipIf(!python)("claims the task the person moved to, not the top one", async () => {
    const dir = await tempRepo({ init: true });
    const first = satiJson<Task>(dir, "task", "create", "First", "--priority", "high").data;
    const second = satiJson<Task>(dir, "task", "create", "Second").data;

    const r = pick(dir, "\\x1b[B\\r");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Claimed");
    expect(satiJson<Task>(dir, "task", "show", second.id).data.status).toBe("in_progress");
    expect(satiJson<Task>(dir, "task", "show", first.id).data.status).toBe("todo");
  });

  it.skipIf(!python)("claims nothing when the person cancels", async () => {
    const dir = await tempRepo({ init: true });
    const only = satiJson<Task>(dir, "task", "create", "Only").data;
    const r = pick(dir, "\\x03");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Nothing claimed.");
    expect(satiJson<Task>(dir, "task", "show", only.id).data.status).toBe("todo");
  });
});

describe("usage errors teach the command", () => {
  // Each of these used to answer "No command specified" or name citty's parts; a person had to
  // run a second command to learn what to type.
  it("answers a group typed alone, the help word and a missing argument", async () => {
    const dir = await tempRepo();
    const group = sati(dir, "task");
    expect(group.code).toBe(2);
    expect(group.stdout).toContain("sati task <command>");
    expect(group.stdout).toContain("claim");
    expect(sati(dir, "help", "task", "claim").stdout).toBe(
      sati(dir, "task", "claim", "--help").stdout,
    );
    expect(sati(dir, "help").stdout).toBe(sati(dir, "--help").stdout);
    expect(sati(dir, "task", "update").stderr).toContain("sati task update <id>");
    expect(sati(dir, "task", "complete", "x").stderr).toContain("Missing --summary.");
    expect(sati(dir, "--bogus").stderr).toContain("Unknown option --bogus.");
    // Scripts keep the error as JSON.
    const json = satiJson<{ error: { code: string } }>(dir, "task");
    expect(json.code).toBe(2);
    expect(json.data.error.code).toBe("USAGE");
  });

  // WP16 / 16.5: the root help is how a person finds a command. A command that falls in no
  // group lands under "Other", and two commands with one description read as one job twice.
  it("every visible command is in exactly one help group, and no two visible commands share a description", async () => {
    const dir = await tempRepo();
    const lines = run(dir, ["--help"], { COLUMNS: "100" }).stdout.split("\n");
    // Group heading -> its rows, in the order printed (a repeated name stays repeated).
    const sections = new Map<string, { name: string; text: string }[]>();
    let rows: { name: string; text: string }[] | undefined;
    for (const line of lines) {
      if (/^[A-Z][A-Z ]+$/u.test(line)) {
        rows = ["USAGE", "GLOBAL OPTIONS"].includes(line) ? undefined : [];
        if (rows) sections.set(line, rows);
      } else if (rows && /^ {2}\S/u.test(line)) {
        // A label, two or more spaces, then the first sentence; a long one wraps below it.
        const [label = "", text = ""] = line.trim().split(/ {2,}/u, 2);
        rows.push({ name: label.split(",")[0] ?? label, text });
      } else if (rows && rows.length > 0 && /^ {4}\S/u.test(line)) {
        const row = rows[rows.length - 1];
        if (row) row.text = `${row.text} ${line.trim()}`;
      }
    }
    const all = [...sections.values()].flat();
    expect(all.length).toBeGreaterThan(20);
    // The layout names the groups; a command it does not name is listed under OTHER.
    const other = sections.get("OTHER")?.map((r) => r.name) ?? [];
    expect(other, "commands in no help group").toEqual([]);
    const names = new Map<string, number>();
    for (const { name } of all) names.set(name, (names.get(name) ?? 0) + 1);
    for (const [name, count] of names) expect(count, `${name} is listed once`).toBe(1);
    const texts = new Map<string, string[]>();
    for (const { name, text } of all) texts.set(text, [...(texts.get(text) ?? []), name]);
    for (const [text, who] of texts) expect(who, `commands described as "${text}"`).toHaveLength(1);
  });

  // Review 6.4, 6.6, 6.11, 6.12: commands run by hooks, shortcuts and old scripts stay out of the
  // help and the completion list, so a person sees the commands meant for them; they still run.
  it("keeps export, import, app and the --hook flags out of help and completion, and doctor under Project", async () => {
    const dir = await tempRepo({ init: true });
    const root = run(dir, ["--help"], { COLUMNS: "100" }).stdout;
    for (const name of ["export", "import", "app"]) {
      expect(root, `${name} in root help`).not.toMatch(new RegExp(`^ {2}${name}[ ,]`, "mu"));
      // Only the top-level word list: `sync export` and `plan import` are other commands.
      const top = /^ {4}""\) words="([^"]*)"/mu.exec(sati(dir, "completion", "bash").stdout)?.[1];
      expect(top?.split(" "), `${name} in completion`).not.toContain(name);
    }
    expect(sati(dir, "export").code).toBe(0);
    expect(sati(dir, "import").code).toBe(0);
    expect(sati(dir, "app", "--help").code).toBe(0);
    for (const cmd of ["guard", "wait"]) {
      expect(sati(dir, cmd, "--help").stdout, `${cmd} --hook in help`).not.toContain("--hook");
    }
    // Root help lists doctor under Project, and completion closes Start.
    const at = (re: RegExp) => root.search(re);
    const inside = (name: string, heading: string, next: string) =>
      at(new RegExp(`^ {2}${name} `, "mu")) > at(new RegExp(`^${heading}$`, "mu")) &&
      at(new RegExp(`^ {2}${name} `, "mu")) < at(new RegExp(`^${next}$`, "mu"));
    expect(inside("doctor", "PROJECT", "RUN BY TOOLS"), "doctor under Project").toBe(true);
    expect(inside("completion", "START", "WORK"), "completion under Start").toBe(true);
  });

  // Review 6.5: `card show` was `card get` under another name, and `context` the same card
  // command under another top-level name. One spelling is listed; the old ones still run.
  it("lists card get, not card show or context, and the old names still run", async () => {
    const dir = await tempRepo({ init: true });
    const root = run(dir, ["--help"], { COLUMNS: "100" }).stdout;
    expect(root).not.toMatch(/^ {2}card,/mu);
    expect(root).not.toContain("sati context");
    const help = sati(dir, "card", "--help").stdout;
    expect(help).toMatch(/^ {2}get /mu);
    expect(help).not.toMatch(/^ {2}show /mu);
    const words = /^ {4}""\) words="([^"]*)"/mu.exec(sati(dir, "completion", "bash").stdout)?.[1];
    expect(words?.split(" ")).not.toContain("context");
    expect(sati(dir, "card", "put", "a.ts", "--summary", "A file").code).toBe(0);
    const shown = sati(dir, "card", "show", "a.ts");
    expect(shown.code).toBe(0);
    expect(shown.stdout).toBe(sati(dir, "card", "get", "a.ts").stdout);
    expect(sati(dir, "context", "get", "a.ts").stdout).toBe(shown.stdout);
  });

  // Review 6.8, 6.9: `scan` proposes features, so it lives under `feature`; templates start a
  // plan, so `plan` holds them. The old top-level names still run for old scripts.
  it("feature scan and plan list, show, apply replace scan and template, which still run", async () => {
    const dir = await tempRepo({ init: true });
    const root = run(dir, ["--help"], { COLUMNS: "100" }).stdout;
    for (const name of ["scan", "template"]) {
      expect(root, `${name} in root help`).not.toMatch(new RegExp(`^ {2}${name}[ ,]`, "mu"));
    }
    const top = /^ {4}""\) words="([^"]*)"/mu.exec(sati(dir, "completion", "bash").stdout)?.[1];
    expect(top?.split(" ")).not.toContain("scan");
    expect(top?.split(" ")).not.toContain("template");
    expect(sati(dir, "feature", "--help").stdout).toMatch(/^ {2}scan /mu);
    const plan = sati(dir, "plan", "--help").stdout;
    for (const name of ["import", "list", "show", "apply"]) {
      expect(plan, `plan ${name}`).toMatch(new RegExp(`^ {2}${name} `, "mu"));
    }
    expect(sati(dir, "feature", "scan").stdout).toBe(sati(dir, "scan").stdout);
    expect(sati(dir, "plan", "list").stdout).toBe(sati(dir, "template", "list").stdout);
    expect(sati(dir, "plan", "show", "event").stdout).toBe(
      sati(dir, "template", "show", "event").stdout,
    );
    const names = (...cmd: string[]) =>
      satiJson<{ milestone: { title: string } | null; tasks: { title: string }[] }>(
        dir,
        ...cmd,
        "event",
        "--dry-run",
      ).data;
    expect(names("plan", "apply")).toEqual(names("template", "apply"));
  });

  // The root list is scanned; exit codes and flag lists belong in the command's own help.
  it("lists commands by their first sentence and keeps the rest for the command's help", async () => {
    const dir = await tempRepo();
    expect(sati(dir, "--help").stdout).not.toContain("Exit 5 if a check fails");
    expect(sati(dir, "doctor", "--help").stdout).toContain("Exit 5 if a check fails");
  });
});

describe("a task command without an id", () => {
  interface Task {
    id: string;
    status: string;
  }

  // An agent holds one task at a time, and typing its id again on every command is the long way
  // round. A guess is not allowed: completing the wrong task loses work.
  it("uses the one task the caller holds, for show, handoff, complete and release", async () => {
    const dir = await tempRepo({ init: true });
    const one = satiJson<Task>(dir, "task", "create", "One").data;
    const two = satiJson<Task>(dir, "task", "create", "Two").data;
    expect(sati(dir, "task", "claim", one.id).code).toBe(0);

    expect(satiJson<Task>(dir, "task", "show").data.id).toBe(one.id);
    expect(sati(dir, "handoff", "--done", "half of it").code).toBe(0);
    expect(sati(dir, "handoff").stdout).toContain("half of it");

    const done = sati(dir, "task", "complete", "--summary", "shipped", "--files", "a.ts");
    expect(done.code).toBe(0);
    expect(satiJson<Task>(dir, "task", "show", one.id).data.status).not.toBe("in_progress");
    expect(satiJson<Task>(dir, "task", "show", two.id).data.status).toBe("todo");

    expect(sati(dir, "task", "claim", two.id).code).toBe(0);
    expect(sati(dir, "task", "release").code).toBe(0);
    expect(satiJson<Task>(dir, "task", "show", two.id).data.status).toBe("todo");
  });

  it("refuses to guess with no held task, and with several it lists them", async () => {
    const dir = await tempRepo({ init: true });
    const one = satiJson<Task>(dir, "task", "create", "One").data;
    const two = satiJson<Task>(dir, "task", "create", "Two").data;

    const none = sati(dir, "task", "complete", "--summary", "x");
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("You hold no task");

    // Another agent's claim is not the caller's: it must not be picked up.
    expect(run(dir, ["task", "claim", one.id], { SATI_ACTOR: "codex" }).code).toBe(0);
    expect(sati(dir, "task", "release").code).toBe(2);
    expect(satiJson<Task>(dir, "task", "show", one.id).data.status).toBe("in_progress");

    expect(sati(dir, "task", "claim", two.id).code).toBe(0);
    const three = satiJson<Task>(dir, "task", "create", "Three").data;
    expect(sati(dir, "task", "claim", three.id).code).toBe(0);
    const several = sati(dir, "task", "release");
    expect(several.code).toBe(2);
    expect(several.stderr).toContain("You hold 2 tasks");
    expect(several.stderr).toContain("Two");
    expect(several.stderr).toContain("Three");
    expect(satiJson<Task>(dir, "task", "show", two.id).data.status).toBe("in_progress");
  });
});

describe("a command that would do the wrong thing says so", () => {
  interface Task {
    id: string;
    version: number;
  }

  // citty drops a word it has no place for, so an unquoted title made a task named "Fix".
  it("refuses words it has no place for instead of dropping them", async () => {
    const dir = await tempRepo({ init: true });
    const r = sati(dir, "task", "create", "Fix", "the", "bug");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unexpected argument "the"');
    expect(r.stderr).toContain("quotes");
    expect(satiJson<Task[]>(dir, "task", "list").data).toEqual([]);
    // A flag's value and a negative number are not surplus words.
    expect(sati(dir, "task", "create", "Fix the bug", "--priority", "high").code).toBe(0);
  });

  // The parser kept the last value of a repeated option: `--add a --add b` added only b.
  it("refuses an option given twice instead of dropping the first value", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Task>(dir, "task", "create", "One").data;
    const r = sati(dir, "task", "checklist", t.id, "--add", "a", "--add", "b");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--add was given twice");
    expect(sati(dir, "task", "show", t.id).stdout).not.toContain("[ ] b");
  });

  // An update with no option wrote a new version and an audit row that changed nothing.
  it("refuses an update that changes nothing, and writes nothing", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Task>(dir, "task", "create", "One").data;
    const r = sati(dir, "task", "update", t.id);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Nothing to change");
    expect(satiJson<Task>(dir, "task", "show", t.id).data.version).toBe(t.version);
  });

  // The store compares times as text: "yesterday" matched every row without a word.
  it("refuses a --since it cannot read and a --limit below 1", async () => {
    const dir = await tempRepo({ init: true });
    const since = sati(dir, "activity", "--since", "yesterday");
    expect(since.code).toBe(2);
    expect(since.stderr).toContain("--since must be a time");
    expect(sati(dir, "activity", "--limit", "0").code).toBe(2);
    expect(sati(dir, "activity", "--since", "2020-01-01").code).toBe(0);
  });

  // Why: `changes --since 7d` worked and `activity --since 7d` failed, so the same words meant
  // a time on one command and a usage error on the next.
  it("activity --since accepts 7d as changes does", async () => {
    const dir = await tempRepo({ init: true });
    satiJson<Task>(dir, "task", "create", "One");
    const week = satiJson<unknown[]>(dir, "activity", "--since", "7d");
    expect(week.data.length).toBeGreaterThan(0);
    expect(satiJson<unknown[]>(dir, "activity", "--since", "2099-01-01").data).toEqual([]);
    const session = sati(dir, "activity", "--since", "last-session");
    expect(session.code).toBe(2);
    expect(session.stderr).toContain("changes");
  });

  // "Claim it" is wrong advice when someone else holds the task: the claim would be refused too.
  it("tells a second actor that the task is held, not to claim it", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Task>(dir, "task", "create", "One").data;
    expect(run(dir, ["task", "claim", t.id], { SATI_ACTOR: "codex" }).code).toBe(0);
    const r = sati(dir, "task", "update", t.id, "--title", "Mine");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Another actor holds it");
    expect(r.stderr).not.toContain("Claim it with");
  });

  it("prints undo as one line and a checklist as numbered steps, not JSON", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Task>(dir, "task", "create", "One").data;
    expect(sati(dir, "task", "checklist", t.id, "--add", "step one").code).toBe(0);
    const shown = sati(dir, "task", "show", t.id).stdout;
    expect(shown).toContain("1. [ ] step one");
    expect(shown).not.toContain('"done"');

    expect(sati(dir, "task", "delete", t.id).code).toBe(0);
    const last = satiJson<{ id: string }[]>(dir, "activity", "--limit", "1").data[0];
    const undone = sati(dir, "undo", last?.id ?? "");
    expect(undone.code).toBe(0);
    expect(undone.stdout.trim().split("\n")).toHaveLength(1);
    expect(undone.stdout).toContain("One");
  });

  // Activity printed no row id, so a person could not undo from what they saw. The first column
  // is now the short handle, and undo takes it.
  it("undo takes the short handle that activity prints", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Task>(dir, "task", "create", "Two").data;
    expect(sati(dir, "task", "delete", t.id).code).toBe(0);
    const first = sati(dir, "activity", "--limit", "1").stdout.trim().split(" ")[0] ?? "";
    expect(first).toMatch(/^act_[0-9a-z]{6}$/u);
    const undone = sati(dir, "undo", first);
    expect(undone.code).toBe(0);
    expect(undone.stdout).toContain("Two");
    expect(sati(dir, "undo", "act_zzzzzz").code).toBe(3);
    expect(sati(dir, "undo", "tsk_zzzzzz").code).toBe(3);
  });
});

describe("validation errors", () => {
  // Zod's own text repeated "Invalid" twice and listed options as "a"|"b".
  it("name the field and the allowed values once", async () => {
    const dir = await tempRepo({ init: true });
    const r = sati(dir, "task", "create", "x", "--priority", "hi");
    expect(r.code).toBe(5);
    expect(r.stderr).toContain(
      "Invalid input: --priority: expected one of low, medium, high, urgent",
    );
    expect(sati(dir, "task", "list", "--status", "nope").stderr).toContain(
      "--status: expected one of backlog, todo,",
    );
    expect(sati(dir, "task", "create", "").stderr).toContain("title: must not be empty");
  });

  // Why: the message named the core field (`maxTokens`, `targetDate`), which is not what the
  // person typed, so they could not tell which flag to fix.
  it("a bad --max-tokens names the flag, not maxTokens", async () => {
    const dir = await tempRepo({ init: true });
    const r = sati(dir, "recall", "x", "--max-tokens", "1");
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("--max-tokens: must be 200 or more");
    expect(r.stderr).not.toContain("maxTokens");
    expect(sati(dir, "changes", "--format", "xx").stderr).toContain("--format: expected one of");
    // --json keeps the core's field names for scripts.
    const json = satiJson<unknown>(dir, "recall", "x", "--max-tokens", "1");
    expect(JSON.stringify(json)).toContain("maxTokens");
  });

  // Why: a day that is not real failed two checks, and the same field was reported twice.
  it("a bad milestone date is reported once", async () => {
    const dir = await tempRepo({ init: true });
    const m = sati(dir, "milestone", "create", "M", "--date", "2026-13-45").stderr;
    expect(m).toContain("--date: not a real day");
    expect(m.match(/--date/gu)).toHaveLength(1);
    const due = sati(dir, "task", "list", "--due-by", "2026-1-1").stderr;
    expect(due.match(/--due-by/gu)).toHaveLength(1);
  });
});
