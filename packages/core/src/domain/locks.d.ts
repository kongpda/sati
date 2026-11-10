/**
 * Normalises a repo-relative path or glob: trims, drops a leading `./` and trailing `/`.
 * Returns undefined for paths that could never match a repo file (absolute, `..`, empty), so a
 * lock on them would silently protect nothing.
 */
export declare function normalizeLockPath(raw: string): string | undefined;
/** Most variants one pattern may expand to through braces; a bigger one is refused. */
export declare const BRACE_VARIANT_CAP = 256;
/**
 * How many strings brace expansion would produce, counted without expanding (`{a,b}{c,d}` is 4,
 * `{1..5000}` is 5000). Saturates just above the cap, so a hostile pattern costs linear time.
 */
export declare function braceVariantCount(pattern: string): number;
/** A message when the pattern's braces would expand past the cap, else undefined. */
export declare function globBraceError(raw: string): string | undefined;
/**
 * Whether two lock paths can cover a common file. A path covers what it matches and everything
 * beneath it, so `src` overlaps `src/a.ts`. Segments are compared one by one; `**` and two globs
 * in the same segment count as overlapping. That errs towards a false overlap, which only costs a
 * warning or a refused lock, never a missed one.
 */
export declare function pathsOverlap(a: string, b: string): boolean;
/** Pairs of paths, one from each list, that overlap. */
export declare function overlappingPaths(mine: readonly string[], theirs: readonly string[]): [string, string][];
