/**
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
} as const;

export type ErrorCode = keyof typeof ERROR_EXIT_CODES;

export class BrainError extends Error {
  readonly code: ErrorCode;
  /** What the user or agent should run next. */
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, opts: { hint?: string; details?: unknown } = {}) {
    super(message);
    this.name = "BrainError";
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  get exitCode(): number {
    return ERROR_EXIT_CODES[this.code];
  }
}

export function isBrainError(err: unknown): err is BrainError {
  return err instanceof BrainError;
}
