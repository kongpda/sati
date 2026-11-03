export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Test clock that only moves when told to. */
export function fixedClock(
  start: Date | string,
): Clock & { advance(ms: number): void; set(d: Date | string): void } {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
    set: (d) => {
      t = new Date(d).getTime();
    },
  };
}
