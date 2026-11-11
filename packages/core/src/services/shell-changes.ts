import type { ChangeKind } from "./guard.js";

export interface ShellChange {
  path: string;
  kind: Extract<ChangeKind, "deleted" | "renamed">;
  from?: string;
}

/** Words that run the next word as the command; `then` and `do` open an `if` or loop body. */
const WRAPPERS = new Set([
  "sudo",
  "command",
  "exec",
  "env",
  "time",
  "nice",
  "nohup",
  "then",
  "do",
  "else",
]);

/** Wrapper flags that take the next word as their value (`sudo -u root`, `nice -n 5`). */
const WRAPPER_VALUE_FLAGS = new Set([
  "-u",
  "-g",
  "-h",
  "-p",
  "-C",
  "-D",
  "-r",
  "-t",
  "-U",
  "-n",
  "-f",
  "-o",
]);

/** A redirection such as `>out`, `2>&1` or `&>log`; a bare `>` takes the next word. */
const REDIRECT = /^(?:\d*|&)(?:>>?|<)/u;

/** Splits a command on `&&`, `||`, `;`, `|` and `&` without breaking quotes or `2>&1`. */
function segments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = undefined;
      continue;
    }
    if (ch === "\\" && quote !== '"') {
      current += ch + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(current);
      current = "";
      i++;
      continue;
    }
    // A lone `&` runs the left side in the background; in `2>&1` or `&>` it is a redirection.
    const lone =
      ch === "&" && command[i - 1] !== ">" && command[i - 1] !== "<" && command[i + 1] !== ">";
    if (ch === ";" || ch === "|" || ch === "\n" || lone) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function words(segment: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  const push = () => {
    if (current.length > 0) out.push(current);
    current = "";
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "\\") {
      current += segment[i + 1] ?? "";
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return out;
}

function operands(argv: readonly string[]): string[] {
  const out: string[] = [];
  let flags = true;
  for (const word of argv) {
    if (flags && word === "--") {
      flags = false;
      continue;
    }
    if (flags && word.startsWith("-") && word !== "-") continue;
    flags = false;
    out.push(word);
  }
  return out;
}

function baseName(path: string): string {
  // `mv src/a/ dest/` moves the folder `a`: a closing slash is not part of the name.
  const parts = path.replace(/\/+$/u, "").split("/");
  return parts[parts.length - 1] || path;
}

function destination(dest: string, source: string, many: boolean): string {
  if (dest.endsWith("/") || dest === "." || dest === ".." || many) {
    const dir = dest === "." ? "" : dest.replace(/\/+$/u, "");
    return dir.length > 0 ? `${dir}/${baseName(source)}` : baseName(source);
  }
  return dest;
}

/** `path` as seen from `dir`, the folder an earlier `cd` moved to; the guard resolves the rest. */
function under(dir: string | undefined, path: string): string {
  if (dir === undefined || path.startsWith("/")) return path;
  return `${dir.replace(/\/+$/u, "")}/${path}`;
}

/** git options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--config-env",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

interface Command {
  cmd: string;
  args: string[];
  /** For git: the folder `-C` points at, and every `-c key=value`. */
  dir: string | undefined;
  config: string[];
}

/**
 * The command a segment runs, past `VAR=value` prefixes, wrappers such as `sudo`, a subshell
 * `(`, a directory in the command word (`/bin/rm`) and git's global options.
 */
function command(argv: readonly string[], dir: string | undefined): Command | undefined {
  let rest = argv.map((w, i) => (i === argv.length - 1 ? w.replace(/\)+$/u, "") : w));
  rest = rest.map((w, i) => (i === 0 ? w.replace(/^[({]+/u, "") : w)).filter((w) => w !== "");
  // Redirections are not arguments: `rm a 2>&1` removes only `a`.
  rest = rest.filter(
    (w, i) => !REDIRECT.test(w) && !/^(?:\d*|&)(?:>>?|<)$/u.test(rest[i - 1] ?? ""),
  );
  for (;;) {
    while (rest[0] && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rest[0])) rest = rest.slice(1);
    if (!rest[0] || !WRAPPERS.has(baseName(rest[0]))) break;
    rest = rest.slice(1);
    // The wrapper's own flags: `env -i`, `sudo -u root`, `nice -n 5`.
    while (rest[0]?.startsWith("-")) {
      const flag = rest[0];
      rest = rest.slice(flag === "--" || !WRAPPER_VALUE_FLAGS.has(flag) ? 1 : 2);
      if (flag === "--") break;
    }
  }
  const first = rest[0];
  if (first === undefined) return undefined;
  const cmd = baseName(first);
  let args = rest.slice(1);
  const config: string[] = [];
  if (cmd === "git") {
    while (args[0]?.startsWith("-")) {
      const [opt = "", value] = args;
      if (GIT_VALUE_OPTIONS.has(opt)) {
        if (opt === "-C" && value !== undefined) dir = under(dir, value);
        if ((opt === "-c" || opt === "--config-env") && value !== undefined) config.push(value);
        args = args.slice(2);
      } else args = args.slice(1);
    }
  }
  return { cmd, args, dir, config };
}

/** `mv -t DIR src…` and `--target-directory=DIR`: the target and the remaining words. */
function targetDir(args: readonly string[]): { target?: string; rest: string[] } {
  const rest: string[] = [];
  let target: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    if (word === "-t" || word === "--target-directory") {
      target = args[i + 1];
      i++;
    } else if (word.startsWith("--target-directory=")) {
      target = word.slice("--target-directory=".length);
    } else rest.push(word);
  }
  return target === undefined ? { rest } : { target, rest };
}

function moves(args: readonly string[], dir: string | undefined): ShellChange[] {
  const { target, rest } = targetDir(args);
  const paths = operands(rest);
  const dest = target ?? paths[paths.length - 1];
  const sources = target === undefined ? paths.slice(0, -1) : paths;
  if (dest === undefined || sources.length === 0) return [];
  const many = sources.length > 1 || target !== undefined;
  return sources.map((source) => ({
    path: under(dir, destination(target === undefined ? dest : `${dest}/`, source, many)),
    kind: "renamed" as const,
    from: under(dir, source.replace(/(?<=.)\/+$/u, "")),
  }));
}

const deletes = (paths: readonly string[], dir: string | undefined): ShellChange[] =>
  paths.map((path) => ({ path: under(dir, path), kind: "deleted" as const }));

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** The script a shell runs with `-c`, also in combined flags such as `bash -lc`. */
function shellScript(args: readonly string[]): string | undefined {
  const at = args.findIndex((w) => /^-[a-z]*c[a-z]*$/u.test(w));
  return at < 0 ? undefined : args[at + 1];
}

function walk(commandLine: string, start: string | undefined): ShellChange[] {
  let dir = start;
  const out: ShellChange[] = [];
  for (const segment of segments(commandLine)) {
    const c = command(words(segment), dir);
    if (!c) continue;
    const { cmd, args } = c;
    if (cmd === "cd" || cmd === "pushd") {
      const to = operands(args)[0];
      // `cd`, `cd -` and `cd ~` go somewhere we cannot see; paths after them stay as written.
      dir = to === undefined || to === "-" || to.startsWith("~") ? start : under(dir, to);
    } else if (cmd === "rm" || cmd === "unlink") {
      out.push(...deletes(operands(args), dir));
    } else if (cmd === "mv") {
      out.push(...moves(args, dir));
    } else if (cmd === "git" && args[0] === "rm" && !args.includes("--cached")) {
      out.push(...deletes(operands(args.slice(1)), c.dir));
    } else if (cmd === "git" && args[0] === "mv") {
      out.push(...moves(args.slice(1), c.dir));
    } else if (SHELLS.has(cmd)) {
      const script = shellScript(args);
      if (script !== undefined) out.push(...walk(script, dir));
    }
  }
  return out;
}

/**
 * Deletes and renames implied by `rm`, `unlink`, `git rm`, `mv` and `git mv`, including flags,
 * quoted paths, `&&` chains, `cd` and `sh -c`. Any other command contributes nothing, so the
 * guard lets it through; the pre-commit and CI guards stay the backstop.
 */
export function parseShellChanges(commandLine: string): ShellChange[] {
  return walk(commandLine, undefined);
}

/** Short flags of `git commit` that take a value, so letters after them are that value. */
const COMMIT_VALUE_FLAGS = new Set(["m", "F", "C", "c", "t", "S", "u"]);
/**
 * Of those, the ones whose value may be the next word (`-m -n` commits with the message "-n").
 * `-S` and `-u` take a value only in the same word, so `-S -n` does skip the hooks.
 */
const COMMIT_NEXT_WORD_FLAGS = new Set(["m", "F", "C", "c", "t"]);
/** Long options of `git commit` whose value is the next word when written without `=`. */
const COMMIT_VALUE_OPTIONS = new Set([
  "--message",
  "--file",
  "--reuse-message",
  "--reedit-message",
  "--template",
  "--author",
  "--date",
  "--fixup",
  "--squash",
  "--cleanup",
  "--trailer",
  "--pathspec-from-file",
]);

/** `--no-verify` or a prefix git accepts for it; `--no-ver` could also be `--no-verbose`. */
const isNoVerify = (word: string) => word.startsWith("--no-veri") && "--no-verify".startsWith(word);

/** Commands that can remove or disable a git hook file. */
const HOOK_FILE_COMMANDS = new Set(["rm", "unlink", "mv", "cp", "ln", "chmod", "truncate"]);
const HOOK_FILE = /(?:^|\/)(?:\.git\/hooks|sati\/hooks)(?:\/|$)/u;
/**
 * husky's folder holds hook files that our block is chained into. Only removal counts there:
 * `chmod +x .husky/pre-commit` and `cp` into it are everyday husky setup.
 */
const HUSKY_REMOVERS = new Set(["rm", "unlink", "mv", "truncate"]);
const HUSKY_HOOK = /(?:^|\/)\.husky\/[^/_][^/]*$/u;

const HOOKS_PATH = "core.hookspath";

function skipsVerify(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const word = args[i] as string;
    // After `--` every word is a path.
    if (word === "--") return false;
    if (isNoVerify(word)) return true;
    if (COMMIT_VALUE_OPTIONS.has(word)) {
      i++;
      continue;
    }
    if (!/^-[A-Za-z]+$/u.test(word)) continue;
    const letters = word.slice(1);
    for (let at = 0; at < letters.length; at++) {
      const letter = letters[at] as string;
      if (letter === "n") return true;
      if (!COMMIT_VALUE_FLAGS.has(letter)) continue;
      // The value is the rest of this word, or the next word when the flag ends it.
      if (at === letters.length - 1 && COMMIT_NEXT_WORD_FLAGS.has(letter)) i++;
      break;
    }
  }
  return false;
}

/**
 * Why a command would skip git's hooks, or undefined: `git commit --no-verify` (or `-n`, or a
 * prefix such as `--no-verif`), `git push --no-verify`, a `core.hooksPath` override through
 * `-c`, `--config-env`, `git config` or `GIT_CONFIG_KEY_n`, or removing a hook file. The
 * pre-commit guard never runs after these, so the PreToolUse hook blocks them instead.
 */
export function hookBypass(commandLine: string): string | undefined {
  for (const segment of segments(commandLine)) {
    const argv = words(segment);
    if (argv.some((w) => /^GIT_CONFIG_KEY_\d+=core\.hookspath$/iu.test(w))) {
      return "Setting core.hooksPath through GIT_CONFIG_KEY skips the git hooks.";
    }
    const c = command(argv, undefined);
    if (!c) continue;
    const script = SHELLS.has(c.cmd) ? shellScript(c.args) : undefined;
    if (script !== undefined) {
      const inner = hookBypass(script);
      if (inner) return inner;
    }
    if (HOOK_FILE_COMMANDS.has(c.cmd) && operands(c.args).some((w) => HOOK_FILE.test(w))) {
      return `\`${c.cmd}\` on a git hook file turns the hooks off.`;
    }
    const husky = c.cmd === "mv" ? operands(c.args).slice(0, -1) : operands(c.args);
    if (HUSKY_REMOVERS.has(c.cmd) && husky.some((w) => HUSKY_HOOK.test(w))) {
      return `\`${c.cmd}\` on a husky hook file turns the hooks off.`;
    }
    if (c.cmd !== "git") continue;
    const [sub, ...rest] = c.args;
    const mentions = (w: string) => w.toLowerCase().includes(HOOKS_PATH);
    if (sub === "config") {
      // `git config core.hooksPath` and `git config get …` only read it; a value sets it.
      const plain = operands(rest).filter((w) => w !== "set");
      const reads = rest.some(
        (w) => w.startsWith("--get") || w.startsWith("--unset") || w === "--list",
      );
      const reading = reads || plain[0] === "get" || plain[0] === "unset" || plain.length < 2;
      if (!reading && plain.some(mentions)) return "Changing core.hooksPath skips the git hooks.";
      continue;
    }
    if (c.config.some(mentions) || argv.some((w) => w.startsWith("--config-env") && mentions(w))) {
      return `\`git ${sub ?? ""}\` with a core.hooksPath override skips the git hooks.`;
    }
    if (sub !== "commit" && sub !== "push") continue;
    const skips = sub === "commit" ? skipsVerify(rest) : rest.some(isNoVerify);
    if (skips) return `\`git ${sub} --no-verify\` skips the git hooks.`;
  }
  return undefined;
}
