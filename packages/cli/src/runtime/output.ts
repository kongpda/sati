import { CLI_NAME, isSatiError, SatiError, type ServiceContext, withoutStamps } from "@sati/core";
import type { WrittenRecord } from "@sati/sync";
import { Cancelled, printSameAs } from "../prompt.js";
import { loadFolder, markSeen } from "../shared-folder.js";
import { cleanDeep, errorText, pager, pipeTo, polish, warn } from "../term.js";
import { cliValidationMessage } from "../validation.js";
import { sharedDir } from "./config.js";
import { closeRuntime, openRuntime, type Runtime } from "./location.js";

/** Errors of the machine, not of sati: the disk or its permissions. They need no bug report. */
const DISK: Record<string, string> = {
  EACCES: "permission denied",
  EPERM: "permission denied",
  EROFS: "the file system is read-only",
  ENOSPC: "the disk is full",
};

function unexpected(err: unknown): SatiError {
  const { code, path } = (err ?? {}) as { code?: unknown; path?: unknown };
  const why = typeof code === "string" ? DISK[code] : undefined;
  if (why !== undefined) {
    return new SatiError(
      "INTERNAL",
      `Cannot write${typeof path === "string" ? ` ${path}` : ""}: ${why}.`,
      {
        hint: "Check the folder's permissions and free space, then run the command again.",
      },
    );
  }
  return new SatiError("INTERNAL", err instanceof Error ? err.message : String(err), {
    hint: `This is a bug in ${CLI_NAME}. Please report it with the command you ran.`,
  });
}

export function printError(err: unknown, json: boolean): number {
  const e = isSatiError(err) ? err : unexpected(err);
  if (json) {
    const error = { code: e.code, message: e.message, hint: e.hint ?? null, details: e.details };
    process.stdout.write(`${JSON.stringify({ error }, null, 2)}\n`);
  } else {
    process.stderr.write(errorText(cliValidationMessage(e) ?? e.message, e.hint));
    if (!isSatiError(err) && err instanceof Error && err.stack && process.env.SATI_DEBUG) {
      process.stderr.write(`${err.stack}\n`);
    }
  }
  return e.exitCode;
}

/**
 * Runs one command: JSON goes to stdout with `--json`, otherwise `render` makes the human text.
 * Errors print a message and a hint, and set the documented exit code.
 */
export async function execute<T>(
  json: boolean | undefined,
  fn: (rt: Runtime) => Promise<T>,
  render: (value: T) => string,
  opts: { readOnly?: boolean } = {},
): Promise<void> {
  return output(json, async () => withExport(await openRuntime(), fn, opts), render);
}

/**
 * Git mode exports `.sati/` after a command that wrote, as the MCP server does, so the snapshot
 * is already dirty when git looks: `git commit -a` decides there is nothing to commit before the
 * pre-commit hook runs. A failed export (say, a secret in a record) warns but keeps the write.
 */
export async function withExport<T>(
  rt: Runtime,
  fn: (rt: Runtime) => Promise<T>,
  opts: { readOnly?: boolean } = {},
): Promise<T> {
  const dir = sharedDir(rt);
  if (!dir) return fn(rt);
  // A command that never writes has nothing to export, so git mode skips loading @sati/sync
  // (review 8.6). A shared folder still loads first: that brings in teammates' edits.
  if (opts.readOnly && rt.project.mode !== "standalone") return fn(rt);
  const { afterWrites } = await import("@sati/sync");
  const notUpdated = (err: unknown) => {
    warn("the .sati/ snapshot was not updated.");
    printError(err, false);
  };
  // No git hook loads a teammate's files in a shared folder, so each command looks first.
  const folder = rt.project.mode === "standalone";
  const db = rt.location.path;
  if (folder) {
    await loadFolder(rt.ctx, dir, db, (err) => {
      warn("the shared .sati/ folder was not loaded.");
      printError(err, false);
    });
  }
  const synced = afterWrites(
    rt.ctx.store,
    // Never fires: flush() below runs the export when the command ends.
    2 ** 31 - 1,
    async (written) => {
      const files = await exportWritten(rt.ctx, dir, written, notUpdated);
      if (folder) await markSeen(dir, db, files);
    },
    notUpdated,
  );
  try {
    return await fn({ ...rt, ctx: { ...rt.ctx, store: synced.store } });
  } finally {
    await synced.flush();
  }
}

/**
 * Exports the records a debounced batch wrote. Refused records (a secret in a field) are reported,
 * not thrown: a throw puts the whole batch back in the queue, so one bad record would fail every
 * later export and nothing would reach `.sati/` again.
 */
export async function exportWritten(
  ctx: ServiceContext,
  dir: string,
  written: WrittenRecord[],
  report: (err: unknown) => void,
): Promise<string[]> {
  const { exportSnapshot, refusedError } = await import("@sati/sync");
  const result = await exportSnapshot(ctx, dir, { only: written });
  if (result.refused.length > 0) report(refusedError(result.refused));
  return result.written;
}

/** Shows text taller than the window in the pager. False when it was not shown that way. */
async function paged(text: string): Promise<boolean> {
  const use = pager(text.split("\n").length);
  return use !== null && pipeTo(use, text);
}

/** Like `execute`, for commands that run before a project exists (`init`). */
export async function output<T>(
  json: boolean | undefined,
  fn: () => Promise<T>,
  render: (value: T) => string,
): Promise<void> {
  try {
    const value = await fn();
    // Record text is cleaned of terminal control characters before it is laid out; JSON
    // escapes them itself.
    const text = json ? JSON.stringify(value, withoutStamps, 2) : polish(render(cleanDeep(value)));
    // An empty rendering prints nothing at all (a quiet git hook), not a blank line.
    if (text !== "" && !(await paged(text))) process.stdout.write(`${text}\n`);
    printSameAs();
  } catch (err) {
    // Leaving a question is a choice, not a failure: nothing was written.
    if (err instanceof Cancelled) {
      if (err.message !== "") process.stdout.write(`${err.message}\n`);
    } else process.exitCode = printError(err, json ?? false);
  } finally {
    await closeRuntime();
  }
}
