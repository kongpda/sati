/**
 * Which code a refusal uses (review 9.7):
 * - VALIDATION: the input has the wrong shape (a missing field, a bad id, text too long).
 * - CONFLICT: the record changed or is held by someone else since the caller looked: a lost
 *   version race, or a live claim or lock. Trying again later may work.
 * - INVALID_TRANSITION: the input is well formed, but the record's state or the caller may not
 *   do it: the status machine, "only a person", "only the holder or author", "cannot be undone".
 * - BLOCKED: the guard refused a change to a protected path.
 *
 * Every failure the core can report. Each code maps to a stable CLI exit code,
 * so agents can branch on the result without parsing text.
 */
export const ERROR_EXIT_CODES = {
  INTERNAL: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  VALIDATION: 5,
  NOT_INITIALIZED: 6,
  SCHEMA_TOO_NEW: 7,
  INVALID_TRANSITION: 8,
  AMBIGUOUS: 9,
  /** `sati guard` found a blocked change. */
  BLOCKED: 10,
} as const;

export type ErrorCode = keyof typeof ERROR_EXIT_CODES;

export class SatiError extends Error {
  readonly code: ErrorCode;
  /** What the user or agent should run next. */
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, opts: { hint?: string; details?: unknown } = {}) {
    super(message);
    this.name = "SatiError";
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  get exitCode(): number {
    return ERROR_EXIT_CODES[this.code];
  }
}

export function isSatiError(err: unknown): err is SatiError {
  return err instanceof SatiError;
}
