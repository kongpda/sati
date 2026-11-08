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

/** Most variants one pattern may expand to through braces; a bigger one is refused. */
export const BRACE_VARIANT_CAP = 256;

const RANGE = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/;
const CHAR_RANGE = /^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(\d+))?$/;

/**
 * How many strings brace expansion would produce, counted without expanding (`{a,b}{c,d}` is 4,
 * `{1..5000}` is 5000). Saturates just above the cap, so a hostile pattern costs linear time.
 */
export function braceVariantCount(pattern: string): number {
  const cap = BRACE_VARIANT_CAP + 1;
  const count = (s: string): number => {
    let total = 1;
    for (let i = 0; i < s.length && total < cap; i++) {
      if (s[i] === "\\") {
        i++;
        continue;
      }
      if (s[i] !== "{") continue;
      let depth = 0;
      let end = -1;
      for (let j = i; j < s.length; j++) {
        if (s[j] === "\\") j++;
        else if (s[j] === "{") depth++;
        else if (s[j] === "}" && --depth === 0) {
          end = j;
          break;
        }
      }
      if (end < 0) break;
      const inner = s.slice(i + 1, end);
      const range = RANGE.exec(inner);
      const chars = CHAR_RANGE.exec(inner);
      let n: number;
      if (range) {
        const step = Math.abs(Number(range[3] ?? 1)) || 1;
        n = Math.floor(Math.abs(Number(range[2]) - Number(range[1])) / step) + 1;
      } else if (chars) {
        const step = Number(chars[3] ?? 1) || 1;
        n =
          Math.floor(
            Math.abs((chars[2] ?? "").charCodeAt(0) - (chars[1] ?? "").charCodeAt(0)) / step,
          ) + 1;
      } else {
        const parts: string[] = [];
        let d = 0;
        let from = 0;
        for (let j = 0; j < inner.length; j++) {
          if (inner[j] === "\\") j++;
          else if (inner[j] === "{") d++;
          else if (inner[j] === "}") d--;
          else if (inner[j] === "," && d === 0) {
            parts.push(inner.slice(from, j));
            from = j + 1;
          }
        }
        parts.push(inner.slice(from));
        n = parts.reduce((sum, p) => sum + count(p), 0);
      }
      total = Math.min(cap, total * Math.max(1, n));
      i = end;
    }
    return total;
  };
  return count(pattern);
}

/** A message when the pattern's braces would expand past the cap, else undefined. */
export function globBraceError(raw: string): string | undefined {
  return braceVariantCount(raw) > BRACE_VARIANT_CAP
    ? `"${raw.length > 60 ? `${raw.slice(0, 57)}...` : raw}" has too many brace alternatives (at most ${BRACE_VARIANT_CAP} variants); use a shorter list or a plain glob.`
    : undefined;
}

const isGlobSegment = (s: string) => micromatch.scan(s).isGlob;

/** Splits a pattern into segments after expanding braces, which may contain `/`. */
function expand(pattern: string): string[][] | undefined {
  // Stored data may predate the cap: an over-cap or unexpandable pattern is not expanded.
  if (braceVariantCount(pattern) > BRACE_VARIANT_CAP) return undefined;
  try {
    const variants = micromatch.braces(pattern, { expand: true });
    return (variants.length > 0 ? variants : [pattern]).map((v) => v.split("/").filter(Boolean));
  } catch {
    return undefined;
  }
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
  // Cannot tell: count it as overlapping, the safe direction.
  const result =
    xs === undefined || ys === undefined || xs.some((x) => ys.some((y) => segmentsOverlap(x, y)));
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
