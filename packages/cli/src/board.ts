import { shortHandle } from "@sati/core";
import { row } from "./render.js";
import { bold, cyan, dim, pad, truncate } from "./term.js";

/** The board's columns, in its order. Cancelled tasks are not on the board. */
export const BOARD_STATUSES = ["backlog", "todo", "in_progress", "review", "blocked", "done"];

interface Card {
  id: string;
  title: string;
  status?: string;
  priority?: string;
}

export interface BoardColumn {
  status: string;
  tasks: Card[];
  /** The column holds more tasks than were read. */
  capped: boolean;
}

const LABEL: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

/** A column narrower than this cannot show a handle and a few words: stack the columns. */
const MIN_COLUMN = 22;
const GAP = 2;

const total = (c: BoardColumn) => `${c.tasks.length}${c.capped ? "+" : ""}`;
const mark = (t: Card) => (t.priority === "urgent" || t.priority === "high" ? "! " : "");

/**
 * The board as text. Side by side when every column fits in `width`, one under the other when
 * not. `perColumn` rows of each column are shown; the rest is counted. Plain layout (a pipe, an
 * agent): one task per line with its status in it, so `grep` works, and nothing is cut.
 */
export function boardText(
  columns: readonly BoardColumn[],
  opts: { rich: boolean; width: number; perColumn: number },
): string {
  if (!opts.rich) {
    return columns.flatMap((c) => c.tasks.map(row)).join("\n");
  }
  const more = (c: BoardColumn) => {
    const rest = c.tasks.length - opts.perColumn;
    return rest > 0 ? [dim(`+${rest}${c.capped ? " or more" : ""} more`)] : [];
  };
  const each = Math.floor((opts.width - GAP * (columns.length - 1)) / columns.length);
  if (each < MIN_COLUMN) {
    return columns
      .flatMap((c) => [
        `${bold(LABEL[c.status] ?? c.status)} ${dim(`· ${total(c)}`)}`,
        ...(c.tasks.length
          ? c.tasks
              .slice(0, opts.perColumn)
              .map(
                (t) =>
                  `  ${truncate(row({ id: t.id, title: t.title, ...(t.priority ? { priority: t.priority } : {}) }), opts.width - 2)}`,
              )
          : [`  ${dim("none")}`]),
        ...more(c).map((line) => `  ${line}`),
        "",
      ])
      .join("\n")
      .trimEnd();
  }
  const cells = columns.map((c) => [
    `${bold(LABEL[c.status] ?? c.status)} ${dim(total(c))}`,
    dim("─".repeat(each)),
    ...(c.tasks.length
      ? c.tasks.slice(0, opts.perColumn).map((t) => {
          const handle = shortHandle(t.id);
          const title = truncate(`${mark(t)}${t.title}`, each - handle.length - 1);
          return `${cyan(handle)} ${title}`;
        })
      : [dim("none")]),
    ...more(c),
  ]);
  const height = Math.max(...cells.map((c) => c.length));
  return Array.from({ length: height }, (_, i) =>
    cells
      .map((c) => pad(c[i] ?? "", each))
      .join(" ".repeat(GAP))
      .trimEnd(),
  ).join("\n");
}
