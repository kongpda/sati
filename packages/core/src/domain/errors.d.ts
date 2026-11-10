/**
 * Every failure the core can report. Each code maps to a stable CLI exit code,
 * so agents can branch on the result without parsing text.
 */
export declare const ERROR_EXIT_CODES: {
    readonly INTERNAL: 1;
    readonly USAGE: 2;
    readonly NOT_FOUND: 3;
    readonly CONFLICT: 4;
    readonly VALIDATION: 5;
    readonly NOT_INITIALIZED: 6;
    readonly SCHEMA_TOO_NEW: 7;
    readonly INVALID_TRANSITION: 8;
    readonly AMBIGUOUS: 9;
    /** `sati guard` found a blocked change. */
    readonly BLOCKED: 10;
};
export type ErrorCode = keyof typeof ERROR_EXIT_CODES;
export declare class SatiError extends Error {
    readonly code: ErrorCode;
    /** What the user or agent should run next. */
    readonly hint: string | undefined;
    readonly details: unknown;
    constructor(code: ErrorCode, message: string, opts?: {
        hint?: string;
        details?: unknown;
    });
    get exitCode(): number;
}
export declare function isSatiError(err: unknown): err is SatiError;
