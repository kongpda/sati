import { z } from "zod";
import { type ServiceContext } from "./context.js";
/** PLAN Phase 8: a recall answer stays under 1,000 tokens, so asking is cheaper than reading. */
export declare const RECALL_TOKEN_CAP = 1000;
export declare const RecallInput: z.ZodObject<{
    question: z.ZodString;
    maxTokens: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type RecallInput = z.input<typeof RecallInput>;
export interface RecallItem {
    kind: "card" | "note" | "decision" | "task";
    id: string;
    /** A card's path, or the record's title. */
    title: string;
    /** The line shown under the title: a summary, the decision, a snippet. */
    text: string;
    /** For cards: the facts that match the question first. */
    facts: string[];
    /** For cards: the file version the agent read, and whether the files changed since (git). */
    sourceSeen: string | null;
    stale: boolean | null;
    private: boolean;
    updatedAt: string;
}
export interface Recall {
    question: string;
    markdown: string;
    tokens: number;
    items: RecallItem[];
    /** Matching records left out to stay under the cap. */
    omitted: number;
}
/** The question's subject words, lowercased; all words when every one is a stop word. */
export declare function subjectWords(question: string): string[];
/**
 * "What do we know about X?" in one call: the cards, notes, decisions and open tasks that best
 * match the question, with ids and sources, under 1,000 tokens. sati holds no model: it finds
 * and trims, and the asking agent writes the answer. A card says which file version it came from
 * so the agent can tell whether to re-read the file.
 */
export declare function recall(ctx: ServiceContext, input: unknown): Promise<Recall>;
