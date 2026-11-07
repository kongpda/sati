import type { ChangeKind } from "./guard.js";

export interface ShellChange {
  path: string;
  kind: Extract<ChangeKind, "deleted" | "renamed">;
  from?: string;
}

const WRAPPERS = new Set(["sudo", "command", "exec", "env"]);

/** Splits a command on `&&`, `||`, `;` and `|` without breaking quotes. */
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
    if (ch === ";" || ch === "|" || ch === "\n") {
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
  const parts = path.split("/");
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
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

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
  while (rest[0] && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rest[0])) rest = rest.slice(1);
  while (rest[0] && WRAPPERS.has(baseName(rest[0]))) rest = rest.slice(1);
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
        if (opt === "-c" && value !== undefined) config.push(value);
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
    from: under(dir, source),
  }));
}

const deletes = (paths: readonly string[], dir: string | undefined): ShellChange[] =>
  paths.map((path) => ({ path: under(dir, path), kind: "deleted" as const }));

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

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
      const script = args[args.indexOf("-c") + 1];
      if (args.includes("-c") && script !== undefined) out.push(...walk(script, dir));
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

function skipsVerify(args: readonly string[]): boolean {
  for (const word of args) {
    if (word === "--no-verify") return true;
    if (!/^-[A-Za-z]+$/u.test(word)) continue;
    for (const letter of word.slice(1)) {
      if (letter === "n") return true;
      if (COMMIT_VALUE_FLAGS.has(letter)) break;
    }
  }
  return false;
}

/**
 * Why a command would skip git's hooks, or undefined: `git commit --no-verify` (or `-n`),
 * `git push --no-verify`, or a `-c core.hooksPath=` override. The pre-commit guard never runs
 * for these, so the PreToolUse hook blocks them instead.
 */
export function hookBypass(commandLine: string): string | undefined {
  for (const segment of segments(commandLine)) {
    const c = command(words(segment), undefined);
    if (!c) continue;
    if (SHELLS.has(c.cmd) && c.args.includes("-c")) {
      const inner = hookBypass(c.args[c.args.indexOf("-c") + 1] ?? "");
      if (inner) return inner;
    }
    if (c.cmd !== "git") continue;
    const [sub, ...rest] = c.args;
    if (sub !== "commit" && sub !== "push") continue;
    if (c.config.some((kv) => kv.toLowerCase().startsWith("core.hookspath="))) {
      return `\`git ${sub}\` with -c core.hooksPath skips the git hooks.`;
    }
    const skips = sub === "commit" ? skipsVerify(rest) : rest.includes("--no-verify");
    if (skips) return `\`git ${sub} --no-verify\` skips the git hooks.`;
  }
  return undefined;
}
