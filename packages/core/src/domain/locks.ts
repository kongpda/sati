import micromatch from "micromatch";

/**
 * Normalises a repo-relative path or glob: trims, drops a leading `./` and trailing `/`.
 * Returns undefined for paths that could never match a repo file (absolute, `..`, empty), so a
 * lock on them would silently protect nothing.
 */
export function normalizeLockPath(raw: string): string | undefined {
  let p = raw.trim().replaceAll("\\", "/");
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+$/, "");
  if (p === "" || p === "." || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return undefined;
  if (p.split("/").includes("..")) return undefined;
  return p;
}

const isGlobSegment = (s: string) => micromatch.scan(s).isGlob;

/** Splits a pattern into segments after expanding braces, which may contain `/`. */
function expand(pattern: string): string[][] {
  const variants = micromatch.braces(pattern, { expand: true });
  return (variants.length > 0 ? variants : [pattern]).map((v) => v.split("/").filter(Boolean));
}

function segmentsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    if (x === "**" || y === "**") return true;
    const gx = isGlobSegment(x);
    const gy = isGlobSegment(y);
    if (!gx && !gy && x !== y) return false;
    if (gx && !gy && !micromatch.isMatch(y, x, { dot: true })) return false;
    if (gy && !gx && !micromatch.isMatch(x, y, { dot: true })) return false;
    // Two globs in the same segment: assume they can match a common name.
  }
  // One is a prefix of the other: a lock path also covers everything beneath what it matches.
  return true;
}

const cache = new Map<string, boolean>();
const CACHE_LIMIT = 10_000;

/**
 * Whether two lock paths can cover a common file. A path covers what it matches and everything
 * beneath it, so `src` overlaps `src/a.ts`. Segments are compared one by one; `**` and two globs
 * in the same segment count as overlapping. That errs towards a false overlap, which only costs a
 * warning or a refused lock, never a missed one.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const xs = expand(a);
  const ys = expand(b);
  const result = xs.some((x) => ys.some((y) => segmentsOverlap(x, y)));
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
}

/** Pairs of paths, one from each list, that overlap. */
export function overlappingPaths(
  mine: readonly string[],
  theirs: readonly string[],
): [string, string][] {
  const out: [string, string][] = [];
  for (const a of mine) for (const b of theirs) if (pathsOverlap(a, b)) out.push([a, b]);
  return out;
}
