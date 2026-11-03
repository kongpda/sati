/**
 * Line-level three-way merge for Markdown bodies. Small and dependency-free: an LCS table per
 * side, then the classic diff3 walk over lines that are unchanged on both sides.
 */

/** Above this many LCS cells (lines × lines) the body is not diffed, to bound time and memory. */
const MAX_CELLS = 4_000_000;

/** For each line of `a`, the index of its matching line in `b`, from a longest common subsequence. */
function matches(a: readonly string[], b: readonly string[]): (number | undefined)[] | undefined {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) return undefined;
  // len[i][j] = LCS length of a[i..] and b[j..], stored flat.
  const w = m + 1;
  const len = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * w + j] =
        a[i] === b[j]
          ? (len[(i + 1) * w + j + 1] as number) + 1
          : Math.max(len[(i + 1) * w + j] as number, len[i * w + j + 1] as number);
    }
  }
  const out: (number | undefined)[] = new Array(n).fill(undefined);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out[i] = j;
      i++;
      j++;
    } else if ((len[(i + 1) * w + j] as number) >= (len[i * w + j + 1] as number)) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export interface TextMerge {
  text: string;
  conflict: boolean;
}

/**
 * Merges two edits of `base` line by line. A chunk changed on one side takes that side; a chunk
 * changed the same way on both sides is taken once. A chunk changed differently on both sides is
 * kept twice, between `<<<<<<< ours` / `=======` / `>>>>>>> theirs` markers, and `conflict` is set.
 */
export function mergeText(base: string, ours: string, theirs: string): TextMerge {
  if (ours === theirs || theirs === base) return { text: ours, conflict: false };
  if (ours === base) return { text: theirs, conflict: false };
  const b = base.split("\n");
  const o = ours.split("\n");
  const t = theirs.split("\n");
  const mo = matches(b, o);
  const mt = matches(b, t);
  const out: string[] = [];
  let conflict = false;
  const chunk = (bc: string[], oc: string[], tc: string[]) => {
    if (same(oc, bc)) out.push(...tc);
    else if (same(tc, bc) || same(oc, tc)) out.push(...oc);
    else {
      conflict = true;
      out.push("<<<<<<< ours", ...oc, "=======", ...tc, ">>>>>>> theirs");
    }
  };
  if (!mo || !mt) {
    chunk(b, o, t);
    return { text: out.join("\n"), conflict };
  }
  let i = 0;
  let j = 0;
  let k = 0;
  for (let p = 0; p <= b.length; p++) {
    const po = p < b.length ? mo[p] : o.length;
    const pt = p < b.length ? mt[p] : t.length;
    // A base line kept by both sides, after everything already merged, anchors a stable point.
    if (po === undefined || pt === undefined || po < j || pt < k) continue;
    chunk(b.slice(i, p), o.slice(j, po), t.slice(k, pt));
    if (p < b.length) out.push(b[p] as string);
    i = p + 1;
    j = po + 1;
    k = pt + 1;
  }
  return { text: out.join("\n"), conflict };
}
