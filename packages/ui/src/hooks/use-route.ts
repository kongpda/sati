import { useCallback, useEffect, useRef, useState } from "react";

const DISCARD_COMMENT = "Discard the comment you typed?";

/**
 * The page and the open task, kept in step with the address bar. Leaving a page with unsaved
 * edits or an unsent comment asks first; Back and Forward ask too.
 */
export function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  const [task, setTask] = useState<string | null>(
    new URLSearchParams(window.location.search).get("task"),
  );
  /** The task j/k steps from: the open one, or the last one opened. */
  const cursor = useRef<string | null>(null);
  /** The open task, for `go`, which must not change on every render. */
  const shownTask = useRef(task);
  /** The task panel has edits that are not saved yet. */
  const sheetDirty = useRef(false);
  /** Records on the current page (Notes, Decisions) with a comment typed but not sent. */
  const drafts = useRef(new Set<string>());
  // The URL on screen, to put back when a Back or Forward is declined.
  const here = useRef(window.location.pathname + window.location.search);

  const setSheetDirty = useCallback((dirty: boolean) => {
    sheetDirty.current = dirty;
  }, []);
  const setDraft = useCallback((typed: boolean, on: string) => {
    if (typed) drafts.current.add(on);
    else drafts.current.delete(on);
  }, []);

  useEffect(() => {
    shownTask.current = task;
    if (task) cursor.current = task;
  }, [task]);

  useEffect(() => {
    const onPop = () => {
      const next = new URLSearchParams(window.location.search).get("task");
      // Back and Forward ask too. Declining puts the panel's URL back.
      if (
        sheetDirty.current &&
        next !== shownTask.current &&
        !window.confirm("Discard your unsaved changes to this task?")
      ) {
        window.history.pushState(null, "", here.current);
        return;
      }
      if (
        drafts.current.size > 0 &&
        window.location.pathname !== new URL(here.current, window.location.origin).pathname &&
        !window.confirm(DISCARD_COMMENT)
      ) {
        window.history.pushState(null, "", here.current);
        return;
      }
      if (next !== shownTask.current) sheetDirty.current = false;
      shownTask.current = next;
      here.current = window.location.pathname + window.location.search;
      setPath(window.location.pathname);
      setTask(next);
    };
    // Reloading or closing the tab with unsaved edits gets the browser's own prompt.
    const onUnload = (e: BeforeUnloadEvent) => {
      if (sheetDirty.current || drafts.current.size > 0) e.preventDefault();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  const go = useCallback((next: string, taskId: string | null = null) => {
    // Leaving a panel with unsaved edits asks first. On a wide screen the board stays clickable
    // beside the panel, so one stray click would otherwise throw the edits away.
    if (
      sheetDirty.current &&
      taskId !== shownTask.current &&
      !window.confirm("Discard your unsaved changes to this task?")
    ) {
      return false;
    }
    // A comment typed on Notes or Decisions is lost when the page changes.
    if (drafts.current.size > 0 && next !== window.location.pathname) {
      if (!window.confirm(DISCARD_COMMENT)) return false;
      drafts.current.clear();
    }
    // Clicking the open task again keeps its edits, so it stays dirty.
    if (taskId !== shownTask.current) sheetDirty.current = false;
    shownTask.current = taskId;
    const url = taskId ? `${next}?task=${taskId}` : next;
    // The same URL again (the open card clicked) adds no history entry for Back to step through.
    if (url !== here.current) window.history.pushState(null, "", url);
    here.current = url;
    setPath(next);
    setTask(taskId);
    return true;
  }, []);

  return { path, task, cursor, go, setSheetDirty, setDraft };
}
