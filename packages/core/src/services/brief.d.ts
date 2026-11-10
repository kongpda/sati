import { z } from "zod";
import { type ServiceContext } from "./context.js";
/** PLAN: the brief stays under 1,500 tokens so it is cheap to inject at every session start. */
export declare const BRIEF_TOKEN_CAP = 1500;
export declare const BriefInput: z.ZodObject<{
    format: z.ZodOptional<z.ZodEnum<{
        agent: "agent";
        short: "short";
    }>>;
    maxTokens: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type BriefInput = z.input<typeof BriefInput>;
export interface Brief {
    markdown: string;
    /** Estimated as characters / 4, which overestimates for English Markdown. */
    tokens: number;
    /** Lines left out to stay under the cap. */
    omitted: number;
}
export declare const estimateTokens: (text: string) => number;
/**
 * The session-start brief: who I am, my claimed tasks with their acceptance criteria, ready
 * tasks, paths other agents have locked, what others changed since my last session, recent
 * decisions, stale context entries and protected features. Every line carries an id so the
 * agent can fetch more. Lower sections lose items first when the text would exceed the token cap.
 */
export declare function buildBrief(ctx: ServiceContext, input?: unknown): Promise<Brief>;
