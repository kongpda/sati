import type { CommandDef } from "citty";
import { bold, cyan, dim, pad, term, underline, width, wrap } from "./term.js";
import { versionLine } from "./version.js";

type Resolvable<T> = T | Promise<T> | (() => T | Promise<T>);
const resolveValue = async <T>(v: Resolvable<T>): Promise<T> =>
  typeof v === "function" ? (v as () => T | Promise<T>)() : v;

interface ArgDef {
  type?: string;
  description?: string;
  alias?: string | string[];
  required?: boolean;
  default?: unknown;
  valueHint?: string;
}

/** How the root help lists the commands: a heading and the commands under it, in order. */
export interface HelpLayout {
  groups: Record<string, readonly string[]>;
  /** Second names of a command, shown beside it instead of as their own row. */
  aliases: Record<string, string>;
  /** Root commands that still run but are not listed (one module served under two names). */
  hidden: readonly string[];
  /** Flags that still work but are not listed, by command path (`"init"`, `"task create"`). */
  hiddenFlags: Readonly<Record<string, readonly string[]>>;
}

/**
 * Flags kept for old scripts and installed hooks: accepted, but absent from help and completion.
 * Add a flag here when a newer name replaces it (review D8, D9, D24).
 */
export const HIDDEN_FLAGS: Readonly<Record<string, readonly string[]>> = {
  // `sati doctor --reviewed <id>` is the one documented way to clear needsReview (review 7.10).
  "task update": ["reviewed"],
  "feature update": ["reviewed"],
  "note update": ["reviewed"],
  // Replaced by `--md` (review 7.9).
  "feature list": ["format"],
};

/** True when `flag` of the command at `path` is kept for old callers and not listed. */
export const hiddenIn = (
  layout: HelpLayout | undefined,
  path: readonly string[],
  flag: string,
): boolean => layout?.hiddenFlags[path.join(" ")]?.includes(flag) === true;

/** Every command has these; `main` handles them before citty sees the arguments. */
const GLOBAL: [string, string][] = [
  ["--project <slug>", "Run against another project (a slug from `projects`, or a folder path)"],
  ["--no-color", "Plain text without colour (also NO_COLOR=1)"],
  ["--no-input", "Never ask a question; fail with a usage error (also SATI_NO_INPUT=1)"],
  ["-h, --help", "Show this help"],
];

/** Only `sati` itself answers this one. */
const VERSION_FLAG: [string, string] = [
  "-v, --version",
  "Show the version and the commit it was built from",
];

/** The flag column is at most this wide; a longer flag puts its description on the next line. */
const LEFT_MAX = 26;

function columns(lines: readonly (readonly [string, string])[]): string[] {
  const max = Math.min(term().width, 100);
  const left = Math.min(LEFT_MAX, Math.max(0, ...lines.map(([l]) => width(l))));
  const indent = " ".repeat(left + 4);
  return lines.map(([l, text]) => {
    if (text === "") return `  ${cyan(l)}`;
    return width(l) > left
      ? `  ${cyan(l)}\n${indent}${wrap(text, max, indent, indent.length)}`
      : `  ${cyan(pad(l, left))}  ${wrap(text, max, indent, indent.length)}`;
  });
}

const heading = (text: string) => bold(underline(text));

/** Help for the command at `path` (the words after the binary name). */
export async function usage(
  root: CommandDef,
  path: readonly string[],
  layout: HelpLayout,
): Promise<string> {
  let cmd = root;
  for (const word of path) {
    const subs = (await resolveValue(cmd.subCommands)) as
      | Record<string, Resolvable<CommandDef>>
      | undefined;
    const next = subs?.[word];
    if (next === undefined) break;
    cmd = await resolveValue(next);
  }
  const rootMeta = (await resolveValue(root.meta ?? {})) as { name?: string; version?: string };
  const meta = (await resolveValue(cmd.meta ?? {})) as { description?: string };
  const name = [rootMeta.name, ...path].join(" ");
  const atRoot = path.length === 0;
  const args = Object.entries((await resolveValue(cmd.args ?? {})) as Record<string, ArgDef>);
  const subs = (await resolveValue(cmd.subCommands)) as
    | Record<string, Resolvable<CommandDef>>
    | undefined;

  const positional: [string, string][] = [];
  const options: [string, string][] = [];
  const usageWords = [name];
  for (const [arg, def] of args) {
    if (hiddenIn(layout, path, arg)) continue;
    const note = def.default === undefined ? "" : ` (default: ${String(def.default)})`;
    if (def.type === "positional") {
      const required = def.required !== false && def.default === undefined;
      positional.push([arg.toUpperCase(), `${def.description ?? ""}${note}`]);
      usageWords.push(required ? `<${arg.toUpperCase()}>` : `[${arg.toUpperCase()}]`);
      continue;
    }
    const aliases = def.alias === undefined ? [] : [def.alias].flat();
    const short = aliases.filter((a) => a.length === 1).map((a) => `-${a}`);
    const value = def.type === "boolean" ? "" : ` <${def.valueHint ?? "value"}>`;
    const required = def.required === true && def.default === undefined;
    options.push([
      `${[...short, `--${arg}`].join(", ")}${value}`,
      `${def.description ?? ""}${note}${required ? " (required)" : ""}`,
    ]);
  }
  if (options.length > 0) usageWords.splice(1, 0, "[options]");
  if (subs && Object.keys(subs).length > 0) usageWords.push("<command>");

  const max = Math.min(term().width, 100);
  const out: string[] = [];
  // The same line `--version` prints, so the two never show different forms (review 7.12).
  const title = atRoot && rootMeta.version ? versionLine(name) : name;
  out.push(bold(title), wrap(meta.description ?? "", max), "");
  out.push(`${heading("USAGE")}  ${cyan(usageWords.join(" "))}`, "");
  if (positional.length > 0) out.push(heading("ARGUMENTS"), ...columns(positional), "");

  if (subs && Object.keys(subs).length > 0) {
    const described = new Map<string, string>();
    for (const [sub, def] of Object.entries(subs)) {
      if (atRoot && (layout.aliases[sub] !== undefined || layout.hidden.includes(sub))) continue;
      const m = (await resolveValue((await resolveValue(def)).meta ?? {})) as {
        description?: string;
        hidden?: boolean;
      };
      // A list of commands is scanned, not read: the first sentence. The rest is in the
      // command's own help.
      if (!m.hidden) described.set(sub, (m.description ?? "").replace(/\. .*$/su, ""));
    }
    const label = (sub: string) =>
      atRoot
        ? [sub, ...Object.keys(layout.aliases).filter((a) => layout.aliases[a] === sub)].join(", ")
        : sub;
    if (atRoot) {
      const grouped = new Set(Object.values(layout.groups).flat());
      const groups = { ...layout.groups };
      const rest = [...described.keys()].filter((s) => !grouped.has(s));
      if (rest.length > 0) groups.Other = rest;
      // One column width for every group, so the descriptions line up down the page.
      const rows = Object.entries(groups).map(
        ([group, names]) =>
          [
            group,
            names
              .filter((s) => described.has(s))
              .map((s) => [label(s), described.get(s) ?? ""] as const),
          ] as const,
      );
      const lines = columns(rows.flatMap(([, r]) => r));
      let at = 0;
      for (const [group, r] of rows) {
        out.push(heading(group.toUpperCase()), ...lines.slice(at, at + r.length), "");
        at += r.length;
      }
    } else {
      out.push(
        heading("COMMANDS"),
        ...columns([...described].map(([s, d]) => [label(s), d] as const)),
        "",
      );
    }
  }
  if (options.length > 0) out.push(heading("OPTIONS"), ...columns(options), "");
  out.push(heading("GLOBAL OPTIONS"), ...columns(atRoot ? [...GLOBAL, VERSION_FLAG] : GLOBAL), "");
  if (subs && Object.keys(subs).length > 0) {
    out.push(dim(`Run \`${name} <command> --help\` for a command's options.`), "");
  }
  return out.join("\n");
}
