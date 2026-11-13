import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect } from "react";
import type { Task } from "../api.js";

/** The board's keys: Ctrl+K search, Escape, j/k between cards, Enter, c to create, x to select. */
export function useKeys({
  palette,
  closePalette,
  setPalette,
  setCreating,
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
    setPalette,
    setSelected,
    task,
    visible,
  ]);
}
