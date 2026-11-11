import { basename } from "node:path";
import { CLI_NAME, SatiError } from "@sati/core";
import { type CommandDef, defineCommand } from "citty";
import { output } from "../runtime.js";

type Resolvable<T> = T | Promise<T> | (() => T | Promise<T>);
const resolveValue = async <T>(v: Resolvable<T>): Promise<T> =>
  typeof v === "function" ? (v as () => T | Promise<T>)() : v;

/** A command, its flags and its subcommands, as the shell scripts need them. */
export interface Node {
  name: string;
  description: string;
  flags: { name: string; description: string }[];
  subs: Node[];
}

const GLOBAL_FLAGS = [
  { name: "project", description: "Run against another project" },
  { name: "no-color", description: "Plain text without colour" },
  { name: "help", description: "Show help" },
];

/** Walks the command tree. Hidden commands are run by tools, not typed. */
export async function tree(cmd: CommandDef, name: string): Promise<Node> {
  const meta = (await resolveValue(cmd.meta ?? {})) as { description?: string };
  const args = (await resolveValue(cmd.args ?? {})) as Record<
    string,
    { type?: string; description?: string }
  >;
  const subs: Node[] = [];
  const defs = (await resolveValue(cmd.subCommands)) as
    | Record<string, Resolvable<CommandDef>>
    | undefined;
  for (const [sub, def] of Object.entries(defs ?? {})) {
    const resolved = await resolveValue(def);
    const m = (await resolveValue(resolved.meta ?? {})) as { hidden?: boolean };
    if (!m.hidden) subs.push(await tree(resolved, sub));
  }
  return {
    name,
    description: meta.description ?? "",
    flags: [
      ...Object.entries(args)
        .filter(([, a]) => a.type !== "positional")
        .map(([flag, a]) => ({ name: flag, description: a.description ?? "" })),
      ...GLOBAL_FLAGS,
    ],
    subs,
  };
}

/** Descriptions go inside single quotes in every shell: one line, no quote, no control text. */
const plain = (text: string): string =>
  text
    .replace(/[^\x20-\x7e]|['`$\\[\]:]/gu, " ")
    .replace(/ +/gu, " ")
    .trim();

/** Every command path with the words that may follow it: `task` → `create list … --json`. */
function paths(node: Node, path: string[] = []): { path: string[]; node: Node }[] {
  return [{ path, node }, ...node.subs.flatMap((s) => paths(s, [...path, s.name]))];
}

function bash(root: Node): string {
  const cases = paths(root)
    .map(({ path, node }) => {
      const words = [...node.subs.map((s) => s.name), ...node.flags.map((f) => `--${f.name}`)];
      return `    "${path.join(" ")}") words="${words.join(" ")}" ;;`;
    })
    .join("\n");
  return `# ${CLI_NAME} completion for bash. Load it with: eval "$(${CLI_NAME} completion bash)"
_${CLI_NAME}() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" cmd="" words="" w i
  for ((i = 1; i < COMP_CWORD; i++)); do
    w="\${COMP_WORDS[i]}"
    case "$w" in -*) continue ;; esac
    case "$cmd" in
      "") case " ${root.subs.map((s) => s.name).join(" ")} " in *" $w "*) cmd="$w" ;; esac ;;
      *" "*) ;;
      *) cmd="$cmd $w" ;;
    esac
  done
  while :; do
    case "$cmd" in
${cases}
    esac
    [ -n "$words" ] || [ -z "$cmd" ] && break
    case "$cmd" in *" "*) cmd="\${cmd% *}" ;; *) cmd="" ;; esac
  done
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
complete -o default -F _${CLI_NAME} ${CLI_NAME}
`;
}

function zsh(root: Node): string {
  const cases = paths(root)
    .map(({ path, node }) => {
      const subs = node.subs.map((s) => `'${s.name}:${plain(s.description)}'`);
      const flags = node.flags.map((f) => `'--${f.name}:${plain(f.description)}'`);
      return `    "${path.join(" ")}") subs=(${subs.join(" ")}); flags=(${flags.join(" ")}) ;;`;
    })
    .join("\n");
  return `#compdef ${CLI_NAME}
# ${CLI_NAME} completion for zsh. Load it with: eval "$(${CLI_NAME} completion zsh)"
_${CLI_NAME}() {
  local -a subs flags
  local cmd="" w i top=" ${root.subs.map((s) => s.name).join(" ")} "
  for ((i = 2; i < CURRENT; i++)); do
    w="\${words[i]}"
    [[ "$w" == -* ]] && continue
    if [[ -z "$cmd" ]]; then
      [[ "$top" == *" $w "* ]] && cmd="$w"
    elif [[ "$cmd" != *" "* ]]; then
      cmd="$cmd $w"
    fi
  done
  while :; do
    case "$cmd" in
${cases}
    esac
    (( \${#flags} )) || [[ -z "$cmd" ]] && break
    if [[ "$cmd" == *" "* ]]; then cmd="\${cmd% *}"; else cmd=""; fi
  done
  if [[ "\${words[CURRENT]}" == -* ]]; then
    _describe -t options option flags
  else
    (( \${#subs} )) && _describe -t commands command subs
    _files
  fi
}
if [ "\${funcstack[1]}" = "_${CLI_NAME}" ]; then _${CLI_NAME} "$@"; else compdef _${CLI_NAME} ${CLI_NAME}; fi
`;
}

function fish(root: Node): string {
  const lines = [
    `# ${CLI_NAME} completion for fish. Load it with: ${CLI_NAME} completion fish | source`,
  ];
  const tops = root.subs.map((s) => s.name).join(" ");
  for (const s of root.subs) {
    lines.push(
      `complete -c ${CLI_NAME} -n "not __fish_seen_subcommand_from ${tops}" -f -a ${s.name} -d '${plain(s.description)}'`,
    );
    const inner = s.subs.map((x) => x.name).join(" ");
    for (const x of s.subs) {
      lines.push(
        `complete -c ${CLI_NAME} -n "__fish_seen_subcommand_from ${s.name}; and not __fish_seen_subcommand_from ${inner}" -f -a ${x.name} -d '${plain(x.description)}'`,
      );
      for (const f of x.flags) {
        lines.push(
          `complete -c ${CLI_NAME} -n "__fish_seen_subcommand_from ${s.name}; and __fish_seen_subcommand_from ${x.name}" -l ${f.name} -d '${plain(f.description)}'`,
        );
      }
    }
    const before = inner ? `; and not __fish_seen_subcommand_from ${inner}` : "";
    for (const f of s.flags) {
      lines.push(
        `complete -c ${CLI_NAME} -n "__fish_seen_subcommand_from ${s.name}${before}" -l ${f.name} -d '${plain(f.description)}'`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

const SHELLS = { bash, zsh, fish } as const;

/** The script for one shell, from the commands as they are defined: it cannot go out of date. */
export function script(shell: string, root: Node): string {
  const make = SHELLS[shell as keyof typeof SHELLS];
  if (make === undefined) {
    const what =
      shell === "" ? "Which shell?" : `No completion for the shell ${JSON.stringify(shell)}.`;
    throw new SatiError("USAGE", what, {
      hint: `Run \`${CLI_NAME} completion bash\`, \`zsh\` or \`fish\`.`,
    });
  }
  return make(root).trimEnd();
}

/** `root` is asked for when the command runs, because the root lists this command too. */
export const completionCommand = (root: () => CommandDef) =>
  defineCommand({
    meta: {
      name: "completion",
      description: `Print a tab-completion script: eval "$(${CLI_NAME} completion zsh)"`,
    },
    args: {
      shell: {
        type: "positional",
        description: "bash, zsh or fish (default: your shell, from $SHELL)",
        required: false,
      },
    },
    run: ({ args }) =>
      output(
        false,
        async () =>
          script(args.shell ?? basename(process.env.SHELL ?? ""), await tree(root(), CLI_NAME)),
        (text) => text,
      ),
  });
