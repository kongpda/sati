import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect } from "react";
import type { Task } from "../api.js";

/** `g` then one of these keys goes to a page. */
export const GO_KEYS: Record<string, readonly [href: string, name: string]> = {
  b: ["/", "Board"],
  w: ["/my-work", "My work"],
  p: ["/plan", "Plan"],
  k: ["/knowledge", "Knowledge"],
  c: ["/changes", "Changes"],
  t: ["/team", "Team"],
};

/**
 * Every shortcut, as the Keyboard help lists them. The handler below acts on the same keys, and
 * a test presses each go-to row, so the sheet cannot say something the board does not do.
 */
export const SHORTCUTS: readonly { keys: string; does: string }[] = [
  { keys: "Ctrl K or Cmd K", does: "Search, or ask a question" },
  ...Object.entries(GO_KEYS).map(([key, [, name]]) => ({
    keys: `g then ${key}`,
    does: `Go to ${name}`,
  })),
  { keys: "j and k", does: "Next and previous card on the Board" },
  { keys: "c", does: "New task, on the Board and My work" },
  { keys: "x", does: "Select or unselect the open card" },
  { keys: "?", does: "Show this list" },
  { keys: "Esc", does: "Close what is open" },
];

/** How long a `g` waits for the key after it. */
const GO_WAIT_MS = 1500;

/** The board's keys: Ctrl+K search, ? help, g then a page key, Escape, j/k between cards, c to create, x to select. */
export function useKeys({
  palette,
  closePalette,
  setPalette,
  setCreating,
  setHelp,
  setSelected,
  go,
  path,
  task,
  visible,
  cursor,
}: {
  palette: boolean;
  closePalette: () => void;
  setPalette: (open: boolean) => void;
  setCreating: (open: boolean) => void;
  setHelp: (open: boolean) => void;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  go: (next: string, taskId?: string | null) => boolean;
  path: string;
  task: string | null;
  /** The cards as the board shows them, set on each render. */
  visible: MutableRefObject<Task[]>;
  /** The task j/k steps from: the open one, or the last one opened. */
  cursor: MutableRefObject<string | null>;
}) {
  useEffect(() => {
    let goAt = 0;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette(true);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        if (palette) closePalette();
        else if (document.querySelector(".palette"))
          return; // a form dialog closes itself
        else if (typing)
          target?.blur(); // The sheet stays open, so typed edits are kept.
        else if (task) go(path);
        return;
      }
      // Ctrl+C, Cmd+X and other chords belong to the browser, not to the board's letters.
      // Any open dialog (search, or a create or edit form on any page) owns the keyboard.
      const dialog = document.querySelector(".palette") !== null;
      if (dialog || typing || event.metaKey || event.ctrlKey || event.altKey) return;
      // Page keys work from anywhere that is not typing, a button or a link included.
      if (event.key === "?") {
        event.preventDefault();
        setHelp(true);
        return;
      }
      if (goAt && Date.now() - goAt < GO_WAIT_MS) {
        goAt = 0;
        const page = GO_KEYS[event.key];
        if (page) {
          event.preventDefault();
          go(page[0]);
          return;
        }
      }
      if (event.key === "g") {
        goAt = Date.now();
        return;
      }
      const step = event.key === "j" || event.key === "k";
      // Buttons and links use these keys themselves, and the sheet is a dialog of its own; only
      // j/k pass from the sheet's heading (where it puts focus) and from a card (where closing
      // the sheet puts it back), to step to the next card.
      const stepsFrom = target?.id === "sheet-title" || target?.matches("button[data-task]");
      if (!(step && stepsFrom) && target?.closest(".sheet, button, a")) return;
      if (step && path === "/") {
        // The order the board shows, with its filters and the phone's column choice.
        const list = visible.current;
        if (list.length === 0) return;
        const at = list.findIndex((t) => t.id === (task ?? cursor.current));
        const forward = event.key === "j";
        const index =
          at === -1
            ? forward
              ? 0
              : list.length - 1
            : (at + (forward ? 1 : -1) + list.length) % list.length;
        const item = list[index];
        if (item) go("/", item.id);
      }
      // New task opens where tasks are on screen.
      if (event.key === "c" && (path === "/" || path === "/my-work")) {
        // Keep the "c" from being typed into the title field the dialog focuses.
        event.preventDefault();
        setCreating(true);
      }
      // x acts on the board's cards; on other pages it would select a card that is not shown.
      if (event.key === "x" && task && path === "/") {
        setSelected((cur) => {
          const next = new Set(cur);
          if (next.has(task)) next.delete(task);
          else next.add(task);
          return next;
        });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    closePalette,
    cursor,
    go,
    palette,
    path,
    setCreating,
    setHelp,
    setPalette,
    setSelected,
    task,
    visible,
  ]);
}
