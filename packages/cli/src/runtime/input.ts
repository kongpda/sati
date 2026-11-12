import { readFileSync } from "node:fs";
import {
  CLI_NAME,
  isSatiError,
  listAll,
  listTasks,
  resolveId,
  SatiError,
  type ServiceContext,
  type StoredEntity,
  shortHandle,
} from "@sati/core";

/**
 * Piped stdin, or "" when stdin is a terminal. Hooks read their JSON input this way, so running
 * one by hand in a terminal does not wait for Ctrl-D (review 5.4).
 */
export function readStdin(): string {
  return process.stdin.isTTY ? "" : readFileSync(0, "utf8");
}

/**
 * Text from a file, or from stdin for `-`. A bad path is a usage error, not a crash, and so is
 * `-` with nothing on stdin: an empty body was almost always a mistaken pipe (review 5.3).
 */
export function readText(path: string): string {
  try {
    if (path !== "-") return readFileSync(path, "utf8");
    const text = readFileSync(0, "utf8");
    if (text.length === 0) {
      throw new SatiError("USAGE", "- reads stdin, and stdin was empty.", {
        hint: "Nothing arrived on stdin. Pipe the text in, or pass it as the value.",
      });
    }
    return text;
  } catch (err) {
    if (isSatiError(err)) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SatiError("NOT_FOUND", `There is no file ${path}.`, {
        hint: "Check the path. It is relative to the folder you run the command in.",
      });
    }
    if (code === "EISDIR") {
      throw new SatiError("USAGE", `${path} is a folder, not a file.`);
    }
    throw new SatiError("USAGE", `Cannot read ${path}: ${(err as Error).message}`);
  }
}

/** A Markdown body flag: `-` reads it from stdin, so long or multi-line text needs no quoting. */
export const bodyText = (value: string | undefined): string | undefined =>
  value === "-" ? readText("-") : value;

/**
 * Splits a comma-separated flag. citty keeps only the last value of a repeated flag. A comma
 * inside `{}` belongs to a glob such as `src/{a,b}/**`, so it does not split.
 */
export function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

export function int(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  // Number() would take "", "1e3" and "0x10"; a flag is a plain decimal integer.
  const n = Number(value);
  if (!/^-?\d+$/.test(value.trim()) || !Number.isSafeInteger(n)) {
    throw new SatiError("USAGE", `--${flag} must be a whole number, got "${value}".`);
  }
  return n;
}

/** `JSON.parse` for user input and files: bad JSON is the caller's mistake, not a bug in sati. */
export function parseJson(
  text: string,
  what: string,
  code: "USAGE" | "VALIDATION" = "VALIDATION",
  opts: { hint?: string } = {},
): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SatiError(
      code,
      `${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      {
        hint:
          opts.hint ??
          (code === "USAGE"
            ? "Check the quoting of the value."
            : "Fix the file, or restore it from git."),
      },
    );
  }
}

export async function ref(
  ctx: ServiceContext,
  entity: StoredEntity,
  value: string | undefined,
): Promise<string | undefined> {
  return value === undefined ? undefined : resolveId(ctx, entity, value);
}

/** An actor id, or the id of the actor with this name; an unknown name is passed through. */
export async function actorRef(
  ctx: ServiceContext,
  value: string | undefined,
): Promise<string | undefined> {
  if (!value) return value;
  if (value.startsWith("actr_")) return resolveId(ctx, "actor", value);
  const actors = await ctx.store.read((r) => listAll(r, ctx, "actor"));
  const found = actors.find((a) => a.name === value || a.displayName === value);
  if (found) return found.id;
  // An unknown name used to filter by itself and quietly return nothing.
  throw new SatiError("NOT_FOUND", `No actor is named ${value}.`, {
    hint: "Check the spelling, or pass the actor's id or handle (actr_8f3k2a).",
  });
}

export async function refs(
  ctx: ServiceContext,
  entity: StoredEntity,
  value: string | undefined,
): Promise<string[] | undefined> {
  const items = list(value);
  return items && Promise.all(items.map((v) => resolveId(ctx, entity, v)));
}

/**
 * `update` with no option wrote a new version and an activity row that changed nothing. `keep`
 * names the fields that say how to write (a version, a token), not what to write.
 */
export function someChange<T extends Record<string, unknown>>(
  input: T,
  command: string,
  keep: readonly string[] = ["expectedVersion", "token"],
): T {
  if (Object.entries(input).some(([k, v]) => v !== undefined && !keep.includes(k))) return input;
  throw new SatiError("USAGE", "Nothing to change: pass at least one option.", {
    hint: `See the options with \`${CLI_NAME} ${command} --help\`.`,
  });
}

/**
 * The task a command is about when no id was typed: the one task the caller holds. With none or
 * several it refuses and lists them, because a guess could finish the wrong task.
 */
export async function heldTask(ctx: ServiceContext, typed: string | undefined): Promise<string> {
  if (typed !== undefined) return resolveId(ctx, "task", typed);
  const mine = (await listTasks(ctx, { status: ["in_progress"], limit: 500 })).filter(
    (t) => t.claim?.actorId === ctx.actorId,
  );
  const [only] = mine;
  if (only !== undefined && mine.length === 1) return only.id;
  if (only === undefined) {
    throw new SatiError("USAGE", "You hold no task, so say which one.", {
      hint: `List them with \`${CLI_NAME} task list\`, or claim one with \`${CLI_NAME} next\`.`,
    });
  }
  throw new SatiError("USAGE", `You hold ${mine.length} tasks, so say which one.`, {
    hint: mine.map((t) => `${shortHandle(t.id)} ${t.title}`).join("; "),
  });
}
