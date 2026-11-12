import { useCallback, useEffect, useRef, useState } from "react";
import { resolveUrl } from "../redirects.js";

const DISCARD_COMMENT = "Discard the comment you typed?";

/**
 * The page and the open task, kept in step with the address bar. Leaving a page with unsaved
 * edits or an unsent comment asks first; Back and Forward ask too.
 */
export function useRoute() {
  // An old address is sent on once, before anything shows it.
  const first = useRef(resolveUrl(window.location.pathname, window.location.search));
  const [path, setPath] = useState(first.current.path);
  const [task, setTask] = useState<string | null>(first.current.params.get("task"));
  /** The page's own query (`tab`, `kind`), without the open task. */
  const [query, setQuery] = useState(() => withoutTask(first.current.params));
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
  if (first.current.moved) {
    here.current = urlOf(first.current.path, first.current.params);
    window.history.replaceState(null, "", here.current);
    first.current = { ...first.current, moved: false };
  }

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
      const to = resolveUrl(window.location.pathname, window.location.search);
      if (to.moved) window.history.replaceState(null, "", urlOf(to.path, to.params));
      const next = to.params.get("task");
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
        to.path !== new URL(here.current, window.location.origin).pathname &&
        !window.confirm(DISCARD_COMMENT)
      ) {
        window.history.pushState(null, "", here.current);
        return;
      }
      if (next !== shownTask.current) sheetDirty.current = false;
      shownTask.current = next;
      here.current = urlOf(to.path, to.params);
      setPath(to.path);
      setQuery(withoutTask(to.params));
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

  const go = useCallback((target: string, taskId: string | null = null) => {
    // The target may carry the page's own query: `/changes?tab=log`.
    const [next = target, typed] = target.split("?");
    // Opening a task from this page keeps the page's own tab or filter.
    const own =
      typed ??
      (taskId && next === window.location.pathname
        ? withoutTask(new URLSearchParams(window.location.search))
        : "");
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
    const params = new URLSearchParams(own);
    if (taskId) params.set("task", taskId);
    const url = urlOf(next, params);
    // The same URL again (the open card clicked) adds no history entry for Back to step through.
    if (url !== here.current) window.history.pushState(null, "", url);
    here.current = url;
    setPath(next);
    setQuery(own);
    setTask(taskId);
    return true;
  }, []);

  return { path, params: new URLSearchParams(query), task, cursor, go, setSheetDirty, setDraft };
}

function withoutTask(params: URLSearchParams): string {
  const rest = new URLSearchParams(params);
  rest.delete("task");
  return rest.toString();
}

function urlOf(path: string, params: URLSearchParams): string {
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}
