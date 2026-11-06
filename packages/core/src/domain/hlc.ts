/**
 * Hybrid logical clock stamps. A stamp is `wall#counter#node`, and the string sorts in
 * causal order: a writer whose wall clock is behind still moves past every stamp it has seen.
 * The counter is capped so the text stays fixed-width; past the cap the wall time steps 1 ms.
 */

const COUNTER_MAX = 999_999;

export interface Hlc {
  ms: number;
  counter: number;
  node: string;
}

export function formatHlc(ms: number, counter: number, node: string): string {
  return `${new Date(ms).toISOString()}#${String(counter).padStart(6, "0")}#${node.replaceAll("#", "_").slice(0, 40)}`;
}

export function parseHlc(stamp: string): Hlc | undefined {
  const wall = stamp.slice(0, 24);
  const rest = stamp.slice(25);
  const hash = rest.indexOf("#");
  if (hash < 1 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(wall)) return undefined;
  const counter = Number(rest.slice(0, hash));
  const node = rest.slice(hash + 1);
  if (!Number.isInteger(counter) || counter < 0 || counter > COUNTER_MAX || node.length === 0) {
    return undefined;
  }
  const ms = Date.parse(wall);
  if (Number.isNaN(ms)) return undefined;
  return { ms, counter, node };
}

/** Negative when `a` is earlier than `b`. Unparseable stamps sort first. */
export function compareHlc(a: string, b: string): number {
  const pa = parseHlc(a);
  const pb = parseHlc(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  if (pa.ms !== pb.ms) return pa.ms < pb.ms ? -1 : 1;
  if (pa.counter !== pb.counter) return pa.counter < pb.counter ? -1 : 1;
  return pa.node < pb.node ? -1 : pa.node > pb.node ? 1 : 0;
}

export function maxHlc(stamps: readonly (string | null | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const stamp of stamps) {
    if (!stamp || !parseHlc(stamp)) continue;
    if (!best || compareHlc(stamp, best) > 0) best = stamp;
  }
  return best;
}

/** The next stamp after every stamp this writer has already seen. */
export function tickHlc(wall: Date, seen: string | undefined, node: string): string {
  const prev = seen ? parseHlc(seen) : undefined;
  const wallMs = wall.getTime();
  if (!prev || wallMs > prev.ms) return formatHlc(wallMs, 0, node);
  const counter = prev.counter + 1;
  if (counter > COUNTER_MAX) return formatHlc(prev.ms + 1, 0, node);
  return formatHlc(prev.ms, counter, node);
}
