import { stripVTControlCharacters } from "node:util";
import { CLI_NAME } from "@sati/core/name";
import { type CommandDef, runCommand } from "citty";
import { type HelpLayout, usage } from "./help.js";
import { errorText, setTerm } from "./term.js";

const HELP = new Set(["--help", "-h"]);
/** `-v` as node, npm and pnpm print it; `-V` as many other tools do. No command has a verbose flag. */
const VERSION_FLAGS = new Set(["--version", "-v", "-V"]);

type Resolvable<T> = T | Promise<T> | (() => T | Promise<T>);
const resolveValue = async <T>(v: Resolvable<T>): Promise<T> =>
  typeof v === "function" ? (v as () => T | Promise<T>)() : v;

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Edit distance, for "did you mean". Flag names are short, so the plain table is fine. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

/**
 * citty silently drops flags a command does not declare, so `task list --stauts backlog` would
 * list everything. Walk to the command that will run and refuse flags it does not know. Names
 * are accepted in kebab and camel case, as aliases, and with citty's `--no-` negation.
 */
async function unknownFlag(root: CommandDef, argv: readonly string[]): Promise<string | undefined> {
  let cmd = root;
  let rest = [...argv];
  for (;;) {
    const subs = (await resolveValue(cmd.subCommands)) as
      | Record<string, Resolvable<CommandDef>>
      | undefined;
    if (!subs || Object.keys(subs).length === 0) break;
    const at = rest.findIndex((a) => !a.startsWith("-"));
    const name = rest[at];
    const next = name === undefined ? undefined : subs[name];
    if (next === undefined) return undefined; // citty reports the unknown or missing command
    cmd = await resolveValue(next);
    rest = rest.slice(at + 1);
  }
  const defs = (await resolveValue(cmd.args ?? {})) as Record<
    string,
    { type?: string; alias?: string | string[] }
  >;
  const known = new Map<string, boolean>(); // name -> takes a value
  for (const [name, def] of Object.entries(defs)) {
    if (def.type === "positional") continue;
    const takesValue = def.type !== "boolean";
    const aliases = def.alias === undefined ? [] : [def.alias].flat();
    for (const n of [name, kebab(name), camel(name), ...aliases]) known.set(n, takesValue);
  }
  let valueNext = false;
  for (const token of rest) {
    if (token === "--") return undefined;
    if (valueNext) {
      valueNext = false;
      continue;
    }
    if (!token.startsWith("-") || token === "-") continue;
    if (/^-\d/.test(token)) continue; // a negative number
    const body = token.replace(/^--?/, "");
    const [flag = "", ...value] = body.split("=");
    const negated = token.startsWith("--no-") ? known.has(flag.slice(3)) : false;
    if (known.has(flag) || negated) {
      valueNext = value.length === 0 && !negated && known.get(flag) === true;
      continue;
    }
    if (HELP.has(token) || VERSION_FLAGS.has(token)) continue;
    const pool = [...known.keys()].filter((n) => n.length > 1);
    const best = pool.map((n) => ({ n, d: distance(flag, n) })).sort((a, b) => a.d - b.d)[0];
    const hint = best && best.d <= 2 ? ` Did you mean --${best.n}?` : "";
    return `Unknown option ${token.startsWith("--") ? `--${flag}` : `-${flag}`}.${hint}`;
  }
  return undefined;
}

/** The leading words of `typed` that name commands, e.g. `merge-driver` of `merge-driver a`. */
async function commandWords(root: CommandDef, typed: readonly string[]): Promise<string[]> {
  const path: string[] = [];
  let cmd = root;
  for (const word of typed) {
    const subs = (await resolveValue(cmd.subCommands)) as
      | Record<string, Resolvable<CommandDef>>
      | undefined;
    const next = subs?.[word];
    if (next === undefined) break;
    path.push(word);
    cmd = await resolveValue(next);
  }
  return path;
}

/**
 * `--project slug` or `--project=slug`; removes it from argv. Returns false on a missing slug.
 * The value may also be the project folder as an absolute path (see `resolveLocation`).
 */
function takeProject(argv: string[]): boolean {
  const at = argv.findIndex((a) => a === "--project" || a.startsWith("--project="));
  if (at === -1) return true;
  const arg = argv[at] as string;
  const eq = arg.indexOf("=");
  const slug = eq === -1 ? argv[at + 1] : arg.slice(eq + 1);
  if (!slug || slug.startsWith("-")) return false;
  process.env.SATI_PROJECT = slug;
  argv.splice(at, eq === -1 ? 2 : 1);
  return true;
}

/** The command words before the first flag, e.g. `task create`. */
function words(argv: readonly string[]): string[] {
  const end = argv.findIndex((a) => a.startsWith("-"));
  return argv.slice(0, end === -1 ? argv.length : end);
}

/** What people type for a command that has another name here. */
const SYNONYMS: Record<string, string> = {
  get: "show",
  view: "show",
  ls: "list",
  new: "create",
  add: "create",
  rm: "delete",
  remove: "delete",
  done: "complete",
  finish: "complete",
  edit: "update",
};

/** The command under `path` closest to the unknown word, for "did you mean". */
async function nearCommand(
  root: CommandDef,
  path: readonly string[],
  typed: string,
): Promise<string | undefined> {
  let cmd = root;
  for (const word of path) {
    const subs = (await resolveValue(cmd.subCommands)) as
      | Record<string, Resolvable<CommandDef>>
      | undefined;
    const next = subs?.[word];
    if (next === undefined) return undefined;
    cmd = await resolveValue(next);
  }
  const names = Object.keys(
    ((await resolveValue(cmd.subCommands)) as Record<string, unknown> | undefined) ?? {},
  );
  const synonym = SYNONYMS[typed];
  if (synonym !== undefined && names.includes(synonym)) return synonym;
  const best = names.map((n) => ({ n, d: distance(typed, n) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d <= 2 ? best.n : undefined;
}

/** Removes a boolean flag from argv; true if it was there. */
function takeFlag(argv: string[], flag: string): boolean {
  const at = argv.indexOf(flag);
  // After `--`, the word is an argument, not a flag.
  const end = argv.indexOf("--");
  if (at === -1 || (end !== -1 && at > end)) return false;
  argv.splice(at, 1);
  return true;
}

/**
 * Parses and runs. Bad usage exits 2 (USAGE), where citty's own runner exits 1, and `--json`
 * callers get the error as JSON. Help and the version are printed here, so they need no core.
 */
export async function main(root: CommandDef, layout: HelpLayout): Promise<void> {
  const argv = process.argv.slice(2);
  // `sati task list | head` closes the pipe early; that is not an error.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  if (takeFlag(argv, "--no-color")) {
    process.env.NO_COLOR = "1";
    setTerm();
  }
  if (!takeProject(argv)) {
    process.stderr.write(errorText("--project needs a slug.", `Run \`${CLI_NAME} projects\`.`));
    process.exitCode = 2;
    return;
  }
  if (argv.length === 1 && VERSION_FLAGS.has(argv[0] ?? "")) {
    const meta = (await resolveValue(root.meta ?? {})) as { version?: string };
    process.stdout.write(`${meta.version ?? ""}\n`);
    return;
  }
  if (argv.length === 0 || argv.some((a) => HELP.has(a))) {
    const path = await commandWords(root, words(argv));
    process.stdout.write(`${await usage(root, path, layout)}\n`);
    // Asked-for help is a success; a bare `sati` is a command left unfinished.
    if (argv.length === 0) process.exitCode = 2;
    return;
  }
  try {
    const bad = await unknownFlag(root, argv);
    if (bad) throw new Error(bad);
    await runCommand(root, { rawArgs: argv });
  } catch (err) {
    // Loaded only here: the core and SQLite stay out of `--version` and `--help`.
    const [{ SatiError, isSatiError }, { printError }] = await Promise.all([
      import("@sati/core"),
      import("./runtime.js"),
    ]);
    // A command that does not wrap its own errors (e.g. `serve`) keeps their code and hint.
    if (isSatiError(err)) {
      process.exitCode = printError(err, argv.includes("--json"));
      return;
    }
    // Anything else is a parsing error from citty.
    const message = stripVTControlCharacters(err instanceof Error ? err.message : String(err));
    // An unknown subcommand is not worth repeating in the hint.
    const typed = words(argv);
    const unknown = /^Unknown command (\S+)/u.exec(message)?.[1];
    const at = unknown === undefined ? -1 : typed.indexOf(unknown);
    const known = at === -1 ? await commandWords(root, typed) : typed.slice(0, at);
    const near = unknown === undefined ? undefined : await nearCommand(root, known, unknown);
    const usageError = new SatiError(
      "USAGE",
      near === undefined
        ? message
        : `${message}. Did you mean \`${[CLI_NAME, ...known, near].join(" ")}\`?`,
      { hint: `Run \`${[CLI_NAME, ...known, "--help"].join(" ")}\` for usage.` },
    );
    process.exitCode = printError(usageError, argv.includes("--json"));
  }
}
