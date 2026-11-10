import type { ChangeKind } from "./guard.js";
export interface ShellChange {
    path: string;
    kind: Extract<ChangeKind, "deleted" | "renamed">;
    from?: string;
}
/**
 * Deletes and renames implied by `rm`, `unlink`, `git rm`, `mv` and `git mv`, including flags,
 * quoted paths, `&&` chains, `cd` and `sh -c`. Any other command contributes nothing, so the
 * guard lets it through; the pre-commit and CI guards stay the backstop.
 */
export declare function parseShellChanges(commandLine: string): ShellChange[];
/**
 * Why a command would skip git's hooks, or undefined: `git commit --no-verify` (or `-n`),
 * `git push --no-verify`, or a `-c core.hooksPath=` override. The pre-commit guard never runs
 * for these, so the PreToolUse hook blocks them instead.
 */
export declare function hookBypass(commandLine: string): string | undefined;
