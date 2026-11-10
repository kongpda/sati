export interface Clock {
    now(): Date;
}
export declare const systemClock: Clock;
/** Test clock that only moves when told to. */
export declare function fixedClock(start: Date | string): Clock & {
    advance(ms: number): void;
    set(d: Date | string): void;
};
