import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { run, sati, satiJson, tempRepo } from "./helpers.js";

const ESC = "\x1b";
/** What a person sees: the layout for a terminal, 80 columns wide. */
const rich = { FORCE_COLOR: "1", COLUMNS: "80" };

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
    // An alias sits beside its command instead of taking a second row.
    expect(r.stdout).toMatch(/^ {2}card, context\s/mu);
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
});
