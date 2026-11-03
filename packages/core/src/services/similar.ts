import { z } from "zod";
import type { Task } from "../domain/schemas.js";
import { parseInput, type ServiceContext } from "./context.js";

/** Words too common in task titles to say two tasks are about the same thing. */
const STOPWORDS = new Set(
  "the and for with from into onto add adds fix fixes make use update new task when then that this".split(
    " ",
  ),
);
/** Dice similarity of significant title words at or above which a task counts as a likely duplicate. */
export const SIMILARITY_THRESHOLD = 0.5;
const CANDIDATES = 20;
const MAX_MATCHES = 3;

export interface SimilarTask {
  id: string;
  title: string;
  status: Task["status"];
  /** 0..1, share of significant title words in common (Dice coefficient). */
  score: number;
}

const SimilarInput = z.strictObject({ title: z.string().trim().min(1).max(300) });

function words(title: string): Set<string> {
  const all = title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(all.filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

/**
 * Tasks whose titles look like `title`, best first: full-text search finds candidates
 * sharing any word, then a word-overlap score keeps only close matches. Cancelled tasks are skipped;
 * done ones are kept, since redoing finished work is also duplicate work.
 */
export async function findSimilarTasks(
  ctx: ServiceContext,
  input: unknown,
): Promise<SimilarTask[]> {
  const { title } = parseInput(SimilarInput, input);
  const mine = words(title);
  if (mine.size === 0) return [];
  return ctx.store.read(async (r) => {
    const hits = await r.search(ctx.projectId, [...mine].join(" "), {
      entities: ["task"],
      match: "any",
      limit: CANDIDATES,
    });
    const out: SimilarTask[] = [];
    for (const hit of hits) {
      const task = await r.get("task", hit.id);
      if (!task || task.deletedAt || task.status === "cancelled") continue;
      const theirs = words(task.title);
      const shared = [...mine].filter((w) => theirs.has(w)).length;
      const score = (2 * shared) / (mine.size + theirs.size);
      if (score >= SIMILARITY_THRESHOLD) {
        out.push({ id: task.id, title: task.title, status: task.status, score: round(score) });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, MAX_MATCHES);
  });
}

const round = (n: number) => Math.round(n * 100) / 100;
