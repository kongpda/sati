/**
 * Hybrid logical clock stamps. A stamp is `wall#counter#node`, and the string sorts in
 * causal order: a writer whose wall clock is behind still moves past every stamp it has seen.
 * The counter is capped so the text stays fixed-width; past the cap the wall time steps 1 ms.
 */
export interface Hlc {
    ms: number;
    counter: number;
    node: string;
}
export declare function formatHlc(ms: number, counter: number, node: string): string;
export declare function parseHlc(stamp: string): Hlc | undefined;
/** Negative when `a` is earlier than `b`. Unparseable stamps sort first. */
export declare function compareHlc(a: string, b: string): number;
export declare function maxHlc(stamps: readonly (string | null | undefined)[]): string | undefined;
/** The next stamp after every stamp this writer has already seen. */
export declare function tickHlc(wall: Date, seen: string | undefined, node: string): string;
