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

function fromArgv(argv: readonly string[]): ShellChange[] {
  let wordsLeft = [...argv];
  while (wordsLeft[0]?.includes("=") && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(wordsLeft[0])) {
    wordsLeft = wordsLeft.slice(1);
  }
  while (wordsLeft[0] && WRAPPERS.has(wordsLeft[0])) wordsLeft = wordsLeft.slice(1);
  const [cmd, sub, ...rest] = wordsLeft;
  if (cmd === "rm") {
    return operands(wordsLeft.slice(1)).map((path) => ({ path, kind: "deleted" as const }));
  }
  if (cmd === "git" && sub === "rm") {
    return operands(rest).map((path) => ({ path, kind: "deleted" as const }));
  }
  if (cmd === "mv") {
    const paths = operands(wordsLeft.slice(1));
    if (paths.length < 2) return [];
    const dest = paths[paths.length - 1] as string;
    const sources = paths.slice(0, -1);
    return sources.map((source) => ({
      path: destination(dest, source, sources.length > 1),
      kind: "renamed" as const,
      from: source,
    }));
  }
  return [];
}

/**
 * Deletes and renames implied by `rm`, `git rm` and `mv`, including flags, quoted paths and
 * `&&` chains. Any other command contributes nothing, so the guard lets it through.
 */
export function parseShellChanges(command: string): ShellChange[] {
  return segments(command).flatMap((segment) => fromArgv(words(segment)));
}
