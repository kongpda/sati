import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_NAME,
  type ListTasksInput,
  listTasks,
  SatiError,
  type ServiceContext,
  shortHandle,
} from "@sati/core";
import { clean, dim } from "./term.js";

type Env = Record<string, string | undefined>;
interface Tty {
  isTTY?: boolean | undefined;
}

/**
 * Whether a question may be put to the caller. Only a person at a terminal is asked: a script, a
 * pipe, an agent's tool (even one that runs commands in a pseudo-terminal) and `--json` get the
 * same output and exit code as before any prompt existed. `SATI_NO_INPUT=1` and `--no-input` turn
 * questions off for a person as well.
 */
export function canAsk(
  json?: boolean,
  env: Env = process.env,
  stdin: Tty = process.stdin,
  stdout: Tty = process.stdout,
): boolean {
  if (json === true || stdin.isTTY !== true || stdout.isTTY !== true) return false;
  if (env.TERM === "dumb" || (env.SATI_NO_INPUT ?? "") !== "") return false;
  // The same variables as `detect` in term.ts.
  return env.CLAUDECODE !== "1" && (env.AI_AGENT ?? "").trim() === "";
}

/**
 * The person pressed Ctrl-C or Esc at a question. Nothing was written: every question is asked
 * before the write it leads to. `output` prints the message and exits 0.
 */
export class Cancelled extends Error {
  constructor(message = "Nothing changed.") {
    super(message);
    this.name = "Cancelled";
  }
}

/** The usage error a command without its `<id>` gives where nobody can be asked. */
export function missing(name: string, command: string): SatiError {
  return new SatiError("USAGE", `Missing <${name}>: ${CLI_NAME} ${command} <${name}>`, {
    hint: `Run \`${CLI_NAME} ${command} --help\` for usage.`,
  });
}

/** The usage error a command without a required flag gives where nobody can be asked. */
export function missingFlag(flag: string, command: string): SatiError {
  return new SatiError("USAGE", `Missing --${flag}.`, {
    hint: `Run \`${CLI_NAME} ${command} --help\` for usage.`,
  });
}

/** Stored text on one line, safe to show inside a prompt. */
const oneLine = (text: string): string => clean(text).replace(/\s+/gu, " ").trim();

/** More rows than this and the list filters as the person types. */
const SHORT_LIST = 10;
const MAX_ROWS = 200;

/**
 * A person chooses one task from those `filter` matches, in the order `task list` prints them.
 * Each row shows the title, then the handle, status and priority; typing filters a long list by
 * any of them. Throws `Cancelled` when the person leaves, and `empty` when nothing matches.
 */
export async function pickTask(
  ctx: ServiceContext,
  filter: ListTasksInput,
  message: string,
  opts: { empty: SatiError; cancelled?: string },
): Promise<string> {
  const tasks = await listTasks(ctx, { ...filter, limit: MAX_ROWS });
  if (tasks.length === 0) throw opts.empty;
  const options = tasks.map((t) => ({
    value: t.id,
    label: oneLine(t.title),
    hint: `${shortHandle(t.id)} ${t.status} ${t.priority}`,
  }));
  const clack = await import("@clack/prompts");
  const chosen =
    options.length <= SHORT_LIST
      ? await clack.select<string>({ message, options })
      : await clack.autocomplete<string>({
          message: tasks.length === MAX_ROWS ? `${message} (first ${MAX_ROWS})` : message,
          options,
          maxItems: SHORT_LIST,
          placeholder: "Type to filter",
          filter: (search, o) =>
            `${o.label ?? ""} ${o.hint ?? ""}`.toLowerCase().includes(search.toLowerCase()),
        });
  if (clack.isCancel(chosen)) throw new Cancelled(opts.cancelled);
  return chosen;
}

/** One line of text from the person. Throws `Cancelled` when they leave. */
export async function askText(message: string, placeholder?: string): Promise<string> {
  const clack = await import("@clack/prompts");
  const typed = await clack.text({
    message,
    ...(placeholder === undefined ? {} : { placeholder }),
    validate: (v) =>
      (v ?? "").trim() === "" ? "Type some text, or press Esc to cancel." : undefined,
  });
  if (clack.isCancel(typed)) throw new Cancelled();
  return typed.trim();
}

/** One of a few fixed values, with `initial` selected. Throws `Cancelled` when they leave. */
export async function askSelect<T extends string>(
  message: string,
  values: readonly T[],
  initial: T,
): Promise<T> {
  const clack = await import("@clack/prompts");
  const chosen = await clack.select<string>({
    message,
    options: values.map((v) => ({ value: v, label: v })),
    initialValue: initial,
  });
  if (clack.isCancel(chosen)) throw new Cancelled();
  return chosen as T;
}

/** More paths than this are not offered one by one: the person types them. */
const MAX_FILES = 100;

/**
 * The files a task touched: ticked from `candidates` (what git says changed, all selected to
 * start), or typed as a comma-separated list when git has nothing to offer.
 */
export async function askFiles(message: string, candidates: readonly string[]): Promise<string[]> {
  const clack = await import("@clack/prompts");
  if (candidates.length === 0 || candidates.length > MAX_FILES) {
    const typed = await clack.text({ message: `${message} (comma-separated; Enter for none)` });
    if (clack.isCancel(typed)) throw new Cancelled();
    return (typed ?? "")
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f !== "");
  }
  const paths = candidates.map(oneLine);
  const chosen = await clack.multiselect<string>({
    message,
    options: paths.map((f) => ({ value: f, label: f })),
    initialValues: paths,
    required: false,
  });
  if (clack.isCancel(chosen)) throw new Cancelled();
  return chosen;
}

/** The line that explains the editor's empty file. Cut from what is saved. */
const EDIT_HELP =
  "<!-- Write the text above in Markdown. Save and close to go on; leave the file empty to cancel. -->";

/**
 * A longer text written in the person's editor (`$VISUAL`, then `$EDITOR`), as git does for a
 * commit message. Undefined when neither is set, so the caller asks for one line instead. The
 * file is private to the user, lives in a folder of its own, and is removed whatever happens.
 * An empty file is `Cancelled`.
 */
function editBody(env: Env = process.env): string | undefined {
  const editor = (env.VISUAL ?? "").trim() || (env.EDITOR ?? "").trim();
  if (editor === "") return undefined;
  // mkdtemp makes the folder 0700; the file is 0600 inside it.
  const dir = mkdtempSync(join(tmpdir(), `${CLI_NAME}-edit-`));
  const file = join(dir, "TEXT.md");
  try {
    writeFileSync(file, `\n\n${EDIT_HELP}\n`, { mode: 0o600 });
    // The editor is the user's own setting and may carry flags (`code --wait`): run it as git
    // does, through the shell.
    const r = spawnSync(`${editor} "${file}"`, { shell: true, stdio: "inherit" });
    if (r.error !== undefined || r.status !== 0) {
      throw new SatiError("USAGE", `The editor (${editor}) did not finish; nothing was saved.`, {
        hint: "Check $VISUAL and $EDITOR, or pass the text as a flag.",
      });
    }
    const text = readFileSync(file, "utf8").replace(EDIT_HELP, "").trim();
    if (text === "") throw new Cancelled();
    return text;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A body: from the editor when one is set, else one line typed at the prompt. */
export async function askBody(message: string): Promise<string> {
  return editBody() ?? (await askText(message));
}

/** A word as the shell needs it typed: quoted when it has anything but plain characters. */
const shellWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/**
 * After a person answered questions: the command that does the same with flags, so they learn it
 * and can paste it into a script. `output` prints it on stderr once the command has succeeded, so
 * stdout stays the result.
 */
export function sameAs(...words: string[]): void {
  same = [CLI_NAME, ...words].map(shellWord).join(" ");
}

let same: string | undefined;

/** Prints the line `sameAs` left, below the command's result. */
export function printSameAs(): void {
  if (same !== undefined) process.stderr.write(`${dim(`Same as: ${oneLine(same)}`)}\n`);
  same = undefined;
}
