/** Shared flags. Lists are comma-separated because citty keeps only the last repeated flag. */
export const json = {
  json: { type: "boolean", description: "Print JSON for scripts and agents" },
} as const;

export const expectedVersion = {
  "expected-version": {
    type: "string",
    description: "Fail with CONFLICT unless the record is at this version",
  },
} as const;

export const pagination = {
  limit: { type: "string", description: "Max results (default 50, max 500)" },
  offset: { type: "string", description: "Skip this many results" },
} as const;

export const id = (what: string) =>
  ({
    id: { type: "positional", required: true, description: `${what} id or short handle` },
  }) as const;

/** A task id that may be left out by the one who holds a task (see `heldTask`). */
export const taskId = {
  id: {
    type: "positional",
    required: false,
    description: "Task id or short handle (default: the one task you hold)",
  },
} as const;

/** `none` clears a planning field from the command line. */
export const NONE = "none";

/** `--due`, `--date` and `--effort`: a value, or `none` to clear the field. Core checks the value. */
export function orNone(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === NONE ? null : value;
}
