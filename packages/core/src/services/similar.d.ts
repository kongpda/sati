import type { Task } from "../domain/schemas.js";
import { type ServiceContext } from "./context.js";
/** Dice similarity of significant title words at or above which a task counts as a likely duplicate. */
export declare const SIMILARITY_THRESHOLD = 0.5;
export interface SimilarTask {
    id: string;
    title: string;
    status: Task["status"];
    /** 0..1, share of significant title words in common (Dice coefficient). */
    score: number;
}
/**
 * Tasks whose titles look like `title`, best first: full-text search finds candidates
 * sharing any word, then a word-overlap score keeps only close matches. Cancelled tasks are skipped;
 * done ones are kept, since redoing finished work is also duplicate work.
 */
export declare function findSimilarTasks(ctx: ServiceContext, input: unknown): Promise<SimilarTask[]>;
