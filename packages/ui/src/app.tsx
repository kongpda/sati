import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  api,
  COLUMNS,
  type Deletable,
  phoneColumn,
  type Snapshot,
  type Task,
} from "./api.js";
import { Board, boardOrder } from "./board.js";
import { Changes } from "./changes.js";
import { NewTask, SendBack } from "./forms.js";
import { Memory } from "./memory.js";
import { heldByOther, moveRefusal, moveTargets, needsReason, personOnly } from "./moves.js";
import { inboxCount, MyWork } from "./my-work.js";
import { Activity, Agents, Decisions, Features, Notes, Roadmap, TaskSheet } from "./pages.js";
import { holderName } from "./people.js";
import { Settings } from "./settings.js";
import { COMMENT_TAG, threadOf } from "./thread.js";
import { kindLabel, plainError, statusWord } from "./words.js";

const PAGES = [
  ["/", "Board"],
  ["/my-work", "My work"],
  ["/agents", "Agents"],
  ["/roadmap", "Roadmap"],
  ["/features", "Features"],
  ["/notes", "Notes"],
  ["/memory", "Memory"],
  ["/decisions", "Decisions"],
  ["/changes", "Changes"],
  ["/activity", "Activity"],
  ["/settings", "Settings"],
] as const;

/** One empty list, so a general project's data keeps the same identity between renders. */
const NONE: never[] = [];

/** Pages a general project does without: it has no features, file reservations or guard. */
const CODE_ONLY = new Set<string>(["/agents", "/features"]);

/** The phone layout in styles.css: one column at a time. */
const PHONE = "(max-width: 700px)";
/** Matches the stylesheet, which shows the board beside the task panel from this width. */
const WIDE = "(min-width: 900px)";

/** Where a search hit of each kind opens, and the tag it shows. */
const HIT_PAGES: Record<string, string> = {
  note: "/notes",
  decision: "/decisions",
  feature: "/features",
  context: "/memory",
};

/** The branch commit a person sees when approving, so a later push is not approved unseen. */
function approvedCommit(data: Snapshot, id: string): { approvedCommit?: string } {
  const head = data.drift?.[id]?.head;
  return head ? { approvedCommit: head } : {};
}

/** The board's search returns at most this many hits (the `/api/search` limit). */
const SEARCH_LIMIT = 20;

const DISCARD_COMMENT = "Discard the comment you typed?";

export function App() {
  const query = useQuery({ queryKey: ["snapshot"], queryFn: api.snapshot });
  const client = useQueryClient();
  const [path, setPath] = useState(window.location.pathname);
  const [task, setTask] = useState<string | null>(
    new URLSearchParams(window.location.search).get("task"),
  );
  const [filter, setFilter] = useState("");
  const [feature, setFeature] = useState("");
  // On a phone, null until the person picks a column: the board picks one that has tasks.
  const [picked, setColumn] = useState<string | null>(() =>
    window.matchMedia(PHONE).matches ? null : "all",
  );
  const column = picked ?? phoneColumn(query.data?.tasks ?? []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [toast, setToastState] = useState<{
    message: string;
    undo?: () => void;
    /** Errors stay until dismissed: a refused save must not vanish before it is read. */
    error?: boolean;
  } | null>(null);
  const setToast = useCallback(
    (message: string | null, undo?: () => void) =>
      setToastState(message === null ? null : { message, ...(undo ? { undo } : {}) }),
    [],
  );
  const [palette, setPalette] = useState(false);
  const [creating, setCreating] = useState(false);
  /** Tasks on their way back from review, held until the person says what still needs doing. */
  const [sendingBack, setSendingBack] = useState<{
    ids: string[];
    status: string;
    bulk: boolean;
  } | null>(null);
  const [offline, setOffline] = useState(false);
  /** The session cookie was refused (the board server restarted): updates will not come back. */
  const [expired, setExpired] = useState(false);
  /** Board moves waiting for the server; live refetches wait too, or a card would jump back. */
  const moving = useRef(0);
  /** The last move of each task still in flight; the next move of that task waits for it. */
  const moveQueue = useRef(new Map<string, Promise<boolean>>());
  /** The task j/k steps from: the open one, or the last one opened. */
  const cursor = useRef<string | null>(null);
  /** The cards as the board shows them, set on each render for the key handler. */
  const visible = useRef<Task[]>([]);
  /** On a wide screen the task panel sits beside the board, which stays usable. */
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  /** The open task, for `go`, which must not change on every render. */
  const shownTask = useRef(task);
  /** The task panel has edits that are not saved yet. */
  const sheetDirty = useRef(false);
  /** Records on the current page (Notes, Decisions) with a comment typed but not sent. */
  const drafts = useRef(new Set<string>());
  /** Clears the "new" highlight; a newer event restarts it, so it is kept to cancel. */
  const freshTimer = useRef<number | undefined>(undefined);
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
    const media = window.matchMedia(WIDE);
    const onChange = () => setWide(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // A phone shows one column, a wider screen all of them; turning or resizing past the
  // breakpoint switches, or the board keeps a layout made for the other width.
  useEffect(() => {
    const phone = window.matchMedia(PHONE);
    const onChange = () => setColumn(phone.matches ? null : "all");
    phone.addEventListener("change", onChange);
    return () => phone.removeEventListener("change", onChange);
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

  useEffect(() => {
    const source = new EventSource("/events");
    // No refetch on (re)connect: the server sends a message at once when anything was written
    // since the last event this tab saw (Last-Event-ID), and stays quiet when nothing was.
    source.onopen = () => setOffline(false);
    source.onerror = () => {
      setOffline(true);
      // EventSource retries a dropped connection itself, but gives up for good on a refused
      // one (401): the link this tab signed in with is gone.
      if (source.readyState === EventSource.CLOSED) setExpired(true);
    };
    source.onmessage = () => {
      // A move in flight invalidates the snapshot itself when it settles.
      if (moving.current > 0) return;
      const previous = client.getQueryData<Snapshot>(["snapshot"]);
      void client.invalidateQueries({ queryKey: ["snapshot"] }).then(() => {
        const next = client.getQueryData<Snapshot>(["snapshot"]);
        if (!previous || !next) return;
        const before = new Map(previous.tasks.map((t) => [t.id, t.updatedAt]));
        const changed = next.tasks.filter((t) => before.get(t.id) !== t.updatedAt).map((t) => t.id);
        if (changed.length === 0) return;
        setFresh(new Set(changed));
        window.clearTimeout(freshTimer.current);
        freshTimer.current = window.setTimeout(() => setFresh(new Set()), 1600);
      });
    };
    return () => {
      source.close();
      window.clearTimeout(freshTimer.current);
    };
  }, [client]);

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

  /** Opens a list page scrolled to one record, with focus on it, as a link to it would. */
  const show = useCallback(
    (next: string, id: string) => {
      if (!go(next)) return;
      // After the page has rendered.
      requestAnimationFrame(() => {
        const row = document.getElementById(id);
        row?.scrollIntoView({ block: "center" });
        row?.focus();
      });
    },
    [go],
  );

  const fail = useCallback((err: unknown) => {
    setToastState({ message: plainError(err), error: true });
  }, []);

  const copyFailed = useCallback(
    () =>
      setToastState({
        message: "Could not copy. Select the text and copy it by hand.",
        error: true,
      }),
    [],
  );

  const saved = useCallback(
    (message: string) => {
      setToast(message);
      return client.invalidateQueries({ queryKey: ["snapshot"] });
    },
    [client, setToast],
  );

  // Deletes are soft and need no "are you sure": the toast offers Undo, which restores it.
  const remove = useCallback(
    (entity: Deletable, id: string, title: string) =>
      void api
        .remove(entity, id)
        .then(() => {
          setToast(
            `Deleted ${title}.`,
            () =>
              void api
                .restore(entity, id)
                .then(() => saved(`Restored ${title}.`))
                .catch(fail),
          );
          return client.invalidateQueries({ queryKey: ["snapshot"] });
        })
        .catch(fail),
    [client, fail, saved, setToast],
  );
  const thread = {
    onAdd: (on: string, body: string) =>
      api
        .addComment(on, body)
        .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
        .catch((err: unknown) => {
          fail(err);
          throw err;
        }),
    onDelete: (id: string, title: string) => remove("note", id, title),
    onDraft: setDraft,
  };

  const closePalette = useCallback(() => setPalette(false), []);

  /**
   * Resolves true when the task moved. Pass `onFail` to report the reason yourself. A second
   * move of the same card waits for the first: sent at once, it carried the version from
   * before the first move and the server refused it as a conflict.
   */
  function move(
    id: string,
    status: string,
    onFail?: (reason: string) => void,
    reason?: string,
  ): Promise<boolean> {
    const run = (moveQueue.current.get(id) ?? Promise.resolve(true)).then(() =>
      moveNow(id, status, onFail, reason),
    );
    moveQueue.current.set(id, run);
    void run.finally(() => {
      if (moveQueue.current.get(id) === run) moveQueue.current.delete(id);
    });
    return run;
  }

  async function moveNow(
    id: string,
    status: string,
    onFail?: (reason: string) => void,
    reason?: string,
  ): Promise<boolean> {
    const current = client.getQueryData<Snapshot>(["snapshot"]);
    const item = current?.tasks.find((t) => t.id === id);
    if (!current || !item || item.status === status) return false;
    // What core is certain to refuse is not sent: the card would jump to the column and back.
    const refusal = moveRefusal(current, item, status);
    if (refusal) {
      (onFail ?? ((message: string) => setToastState({ message, error: true })))(refusal);
      return false;
    }
    // A refetch already in flight would overwrite the optimistic status with the old one.
    moving.current++;
    await client.cancelQueries({ queryKey: ["snapshot"] });
    client.setQueryData<Snapshot>(["snapshot"], (snap) =>
      snap ? { ...snap, tasks: snap.tasks.map((t) => (t.id === id ? { ...t, status } : t)) } : snap,
    );
    try {
      const updated = await api.patchTask(id, {
        status,
        expectedVersion: item.version,
        ...(reason ? { reason } : {}),
        ...(status === "done" ? approvedCommit(current, id) : {}),
      });
      // The refetch waits for the other moves; a queued move of this card needs the version now.
      client.setQueryData<Snapshot>(["snapshot"], (snap) =>
        snap
          ? {
              ...snap,
              tasks: snap.tasks.map((t) =>
                t.id === id ? { ...t, status: updated.status, version: updated.version } : t,
              ),
            }
          : snap,
      );
      moving.current--;
      // Refetch once the last move lands: an earlier refetch would bring back the old status of
      // the cards still in flight, and they would jump back.
      if (moving.current === 0) await client.invalidateQueries({ queryKey: ["snapshot"] });
      return true;
    } catch (err) {
      moving.current--;
      // Revert only this task: other moves may be in flight, and a whole-snapshot restore
      // would undo them or bring back their refused state.
      client.setQueryData<Snapshot>(["snapshot"], (snap) =>
        snap
          ? {
              ...snap,
              tasks: snap.tasks.map((t) => (t.id === id ? { ...t, status: item.status } : t)),
            }
          : snap,
      );
      if (onFail) onFail(plainError(err));
      else fail(err);
      if (moving.current === 0) await client.invalidateQueries({ queryKey: ["snapshot"] });
      return false;
    }
  }

  /**
   * Moves the tasks and says what did not move, each reason once with how many tasks it stopped.
   * Tasks already in the column are left out of the count.
   */
  async function moveMany(ids: string[], status: string, bulk: boolean, reason?: string) {
    const why = new Map<string, number>();
    const results = await Promise.all(
      ids.map((id) =>
        move(id, status, (message) => why.set(message, (why.get(message) ?? 0) + 1), reason),
      ),
    );
    const failed = ids.filter((_, i) => !results[i]);
    if (bulk) setSelected(new Set(failed));
    if (why.size === 0) return;
    const stopped = [...why.values()].reduce((a, b) => a + b, 0);
    const reasons = [...why].map(([message, n]) =>
      why.size === 1 ? message : `${n} ${n === 1 ? "task" : "tasks"}: ${message}`,
    );
    // An error toast stays until it is closed; the plain one is gone after 6 seconds.
    setToastState({
      message: !bulk
        ? (reasons[0] ?? "")
        : `${stopped} of ${ids.length} tasks did not move. ${reasons.join(" ")}`,
      error: true,
    });
  }

  /** A move from a drag or the bulk menu. Work sent back from review asks for the reason first. */
  function requestMove(ids: string[], status: string, bulk = false) {
    const current = client.getQueryData<Snapshot>(["snapshot"]);
    const asks = ids.some((id) => {
      const item = current?.tasks.find((t) => t.id === id);
      return current && item && needsReason(item, status) && !moveRefusal(current, item, status);
    });
    if (asks) setSendingBack({ ids, status, bulk });
    else void moveMany(ids, status, bulk);
  }

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
      // Enter and x act on the board's cards; on other pages they would jump to the board or
      // select a card that is not shown.
      if (event.key === "Enter" && task && path === "/") go("/", task);
      if (event.key === "c") {
        // Keep the "c" from being typed into the title field the dialog focuses.
        event.preventDefault();
        setCreating(true);
      }
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
  }, [closePalette, go, palette, path, task]);

  useEffect(() => {
    if (!toast || toast.error) return;
    // An Undo stays a little longer, so there is time to reach it.
    const id = window.setTimeout(() => setToast(null), toast.undo ? 10000 : 6000);
    return () => window.clearTimeout(id);
  }, [toast, setToast]);

  const general = query.data?.project?.kind === "general";
  // Where the bulk menu may send the selection: any column at least one selected task can reach.
  const bulkTargets = useMemo(() => {
    const snap = query.data;
    const targets = new Set<string>();
    if (!snap || selected.size === 0) return targets;
    for (const t of snap.tasks) {
      if (selected.has(t.id)) for (const to of moveTargets(snap, t)) targets.add(to);
    }
    return targets;
  }, [query.data, selected]);
  // A general project shows no features or file reservations anywhere, even ones left over
  // from when it was a code project; they stay in the store and come back if it switches back.
  // Memoised: a new object each render would re-render the memoised board on every keystroke.
  const data = useMemo(
    () => (query.data && general ? { ...query.data, features: NONE, locks: NONE } : query.data),
    [query.data, general],
  );
  const pages = PAGES.filter(([href]) => !(general && CODE_ONLY.has(href)));
  // The feature filter is hidden in a general project, so it must not keep narrowing the board.
  useEffect(() => {
    if (general) setFeature("");
  }, [general]);
  const pageLabel = pages.find(([href]) => href === path)?.[1];
  const projectName = data?.project?.name;
  // What waits for this person: shown next to "My work" on every page, and in the tab's title.
  const inbox = useMemo(() => (data ? inboxCount(data) : 0), [data]);
  // Each page names itself in the tab, and on a phone the nav bar scrolls to the current page.
  useEffect(() => {
    const title = [pageLabel, projectName ?? __PRODUCT_NAME__].filter(Boolean).join(" · ");
    document.title = inbox ? `(${inbox}) ${title}` : title;
    document
      .querySelector('.nav a[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pageLabel, projectName, inbox]);
  // Filtering reads every title and body: deferred, so typing stays quick on a big board.
  const lookFor = useDeferredValue(filter).toLowerCase();
  const tasks = useMemo(
    () =>
      (data?.tasks ?? []).filter((t) => {
        if (feature && t.featureId !== feature) return false;
        if (lookFor && !`${t.title} ${t.body}`.toLowerCase().includes(lookFor)) return false;
        return true;
      }),
    [data?.tasks, feature, lookFor],
  );
  visible.current = useMemo(
    () => (data ? boardOrder(tasks, data.features, column) : []),
    [data, tasks, column],
  );
  // The brand kit or event brief one click from the board; the brief gives agents the same 3.
  const pinned = (data?.notes ?? [])
    .filter((n) => n.pinned && !threadOf(n) && !n.tags.includes(COMMENT_TAG))
    .slice(0, 3);

  // Stable handlers, so a memoised card re-renders only when its own task changes.
  const latest = useRef({ data, requestMove });
  latest.current = { data, requestMove };
  const openTask = useCallback((id: string) => go("/", id), [go]);
  const toggle = useCallback(
    (id: string) =>
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const reviewed = useCallback(
    (id: string) => {
      const item = latest.current.data?.tasks.find((t) => t.id === id);
      if (!item) return;
      void api
        .patchTask(id, { reviewed: true, expectedVersion: item.version })
        .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
        .catch(fail);
    },
    [client, fail],
  );
  const refusal = useCallback(
    (t: Task, status: string) => (data ? moveRefusal(data, t, status) : null),
    [data],
  );
  const heldBy = useCallback(
    (t: Task) => (data && heldByOther(data, t) ? holderName(data, t.claim?.actorId) : null),
    [data],
  );
  const moveCard = useCallback((id: string, status: string) => {
    latest.current.requestMove([id], status);
  }, []);

  // While New task, Search or (on a narrow screen) the task panel is open, the page behind it
  // takes no focus or clicks, so Tab stays inside the dialog (aria-modal alone does not stop it).
  // A wide screen shows the panel beside the board, which stays usable: click another card to
  // switch tasks.
  // "Working now" is a live lease. A claim whose lease ended is an agent that stopped; the card
  // says so, and this strip must not show it as at work.
  const now = new Date().toISOString();
  const working = (data?.tasks ?? []).filter((t) => t.claim && t.claim.leaseUntil > now);
  const sheetOpen = task !== null && !!data?.tasks.some((t) => t.id === task);
  const dialog = creating || palette || sendingBack !== null;
  const modal = dialog || (sheetOpen && !wide);

  return (
    <div className="app">
      <nav className="nav" inert={modal} data-modal={modal ? "" : undefined}>
        <p className="brand">{data?.project?.name ?? __PRODUCT_NAME__}</p>
        {pages.map(([href, label]) => (
          <a
            key={href}
            href={href}
            aria-current={path === href ? "page" : undefined}
            // The link keeps its name; the count is its description, read after it.
            aria-describedby={href === "/my-work" && inbox ? "inbox-count" : undefined}
            onClick={(e) => {
              e.preventDefault();
              go(href);
            }}
          >
            {label}
            {href === "/my-work" && inbox ? (
              <span className="nav-count" aria-hidden="true">
                {inbox > 99 ? "99+" : inbox}
              </span>
            ) : null}
          </a>
        ))}
        {inbox ? (
          <span id="inbox-count" hidden>
            {inbox === 1 ? "1 thing waits for you" : `${inbox} things wait for you`}
          </span>
        ) : null}
      </nav>
      <main className="main" inert={modal} data-modal={modal ? "" : undefined}>
        <div className="top">
          {/* The filters only narrow the board, so other pages do not show them. */}
          {path === "/" ? (
            <>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter tasks"
                aria-label="Filter tasks"
              />
              {data && data.features.length === 0 ? null : (
                <select
                  value={feature}
                  onChange={(e) => setFeature(e.target.value)}
                  aria-label="Feature"
                >
                  <option value="">All features</option>
                  {data?.features.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.title}
                    </option>
                  ))}
                </select>
              )}
            </>
          ) : null}
          <button type="button" onClick={() => setPalette(true)}>
            Search
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => setCreating(true)}
            aria-keyshortcuts="c"
          >
            New task
          </button>
        </div>
        {expired ? (
          <p className="banner" role="alert">
            This board link has expired, so changes are no longer shown or saved. Start the board
            again from your terminal and open the new link.
          </p>
        ) : offline ? (
          <p className="banner" role="status">
            Live updates disconnected. Reconnecting…
          </p>
        ) : null}
        {data && personOnly(data) ? (
          <p className="banner" role="status">
            {personOnly(data)?.replace(" to do this.", "")} to approve work, take over a task or
            change how people are shown.
          </p>
        ) : null}
        {data?.truncated && data.truncated.length > 0 ? (
          <p className="banner" role="status">
            This project has more {data.truncated.join(", ")} than the board shows; the oldest are
            left out. Search finds them.
          </p>
        ) : null}
        {query.isLoading ? (
          <p className="empty page" role="status">
            Loading…
          </p>
        ) : null}
        {query.isError && !data ? (
          <div className="empty page" role="alert">
            <p>
              Could not load. {query.error instanceof ApiError ? query.error.message : "Try again."}
            </p>
            <button type="button" onClick={() => void query.refetch()}>
              Retry
            </button>
          </div>
        ) : null}
        {query.isError && data ? (
          <p className="banner" role="alert">
            The latest refresh failed, so this may be out of date.{" "}
            <button type="button" onClick={() => void query.refetch()}>
              Retry
            </button>
          </p>
        ) : null}
        {path === "/" ? (
          <>
            <h1 className="sr-only">Board</h1>
            {pinned.length > 0 ? (
              <nav className="pinned" aria-label="Pinned notes">
                <span className="meta">Pinned</span>
                {pinned.map((n) => (
                  <a
                    key={n.id}
                    href="/notes"
                    onClick={(e) => {
                      e.preventDefault();
                      go("/notes");
                    }}
                  >
                    {n.title}
                  </a>
                ))}
              </nav>
            ) : null}
            {working.length > 0 ? (
              <div className="live">
                {working.map((t) => (
                  <span className="pill" key={t.id}>
                    <strong>{data ? holderName(data, t.claim?.actorId) : ""}</strong> · {t.title}
                  </span>
                ))}
              </div>
            ) : null}
            <select
              className="mobile-status"
              value={column}
              onChange={(e) => setColumn(e.target.value)}
              aria-label="Status"
            >
              <option value="all">All columns</option>
              {COLUMNS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            {selected.size > 0 ? (
              <div className="bulk">
                <span>{selected.size} selected</span>
                <select
                  aria-label="Move selected"
                  defaultValue=""
                  onChange={(e) => {
                    const status = e.target.value;
                    e.target.value = "";
                    if (!status) return;
                    requestMove([...selected], status, true);
                  }}
                >
                  <option value="">Move to…</option>
                  {/* Only where at least one selected task can go; the rest say why they stayed. */}
                  {COLUMNS.filter(([id]) => id !== "done" && bulkTargets.has(id)).map(
                    ([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ),
                  )}
                </select>
                {bulkTargets.size === 0 ? (
                  <span className="hint">None of these can be moved from here.</span>
                ) : null}
              </div>
            ) : null}
            {!data ? null : data.tasks.length === 0 ? (
              <p className="empty page">
                No tasks yet. Use New task (or press c), or ask your agent to plan the work.
              </p>
            ) : tasks.length === 0 ? (
              <p className="empty page">No tasks match the filter.</p>
            ) : (
              <Board
                tasks={tasks}
                allTasks={data?.tasks ?? []}
                features={data?.features ?? []}
                actors={data?.actors ?? []}
                fresh={fresh}
                selected={selected}
                open={task}
                column={column}
                onOpen={openTask}
                onToggle={toggle}
                onReviewed={reviewed}
                onMove={moveCard}
                refusal={refusal}
                heldBy={heldBy}
              />
            )}
          </>
        ) : null}
        {data && path === "/my-work" ? (
          <MyWork
            data={data}
            onOpen={(id) => go(path, id)}
            onGo={go}
            onApprove={(t) =>
              api
                .patchTask(t.id, {
                  status: "done",
                  expectedVersion: t.version,
                  // The commit shown: refused if the branch moves again before the click lands.
                  ...approvedCommit(data, t.id),
                })
                .then(() => saved(`Approved ${t.title}.`))
                .catch(fail)
            }
            onAnswered={(t) =>
              api
                .answered(t.id)
                .then(() => saved(`${t.title} no longer waits on you.`))
                .catch(fail)
            }
            onSendBack={(t, reason) =>
              api
                .patchTask(t.id, { status: "todo", reason, expectedVersion: t.version })
                .then(() => saved(`Sent ${t.title} back to ${statusWord("todo")}.`))
                .catch((err: unknown) => {
                  fail(err);
                  throw err;
                })
            }
          />
        ) : null}
        {data && general && CODE_ONLY.has(path) ? (
          <p className="empty page">
            A general project has no features or file reservations. Switch the project kind in
            Settings to see this page.
          </p>
        ) : null}
        {data && !general && path === "/agents" ? (
          <Agents
            data={data}
            onRelease={() =>
              void api
                .releaseExpired()
                .then((freed) =>
                  saved(
                    freed.length === 0
                      ? "No tasks had run out of time."
                      : `Freed ${freed.length} task${freed.length === 1 ? "" : "s"}.`,
                  ),
                )
                .catch(fail)
            }
            onReleaseTask={(id) => {
              const t = data.tasks.find((x) => x.id === id);
              const name = holderName(data, t?.claim?.actorId);
              const ok =
                t?.claim?.actorId === data.you ||
                window.confirm(
                  `Stop ${name} working on ${t?.title ?? id}? Their next save will be refused.`,
                );
              if (!ok) return;
              void api
                .releaseTask(id, t?.claim?.actorId !== data.you)
                .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
                .catch(fail);
            }}
          />
        ) : null}
        {data && !general && path === "/features" ? (
          <Features
            data={data}
            onSavePaths={(id, paths, version) =>
              api
                .patchFeature(id, {
                  paths: paths
                    .split(/\r?\n/u)
                    .map((p) => p.trim())
                    .filter(Boolean),
                  expectedVersion: version,
                })
                .then((saved) => {
                  setToast("Saved");
                  void client.invalidateQueries({ queryKey: ["snapshot"] });
                  return saved;
                })
                .catch((err: unknown) => {
                  fail(err);
                  throw err;
                })
            }
            onReviewed={(id, version) =>
              void api
                .patchFeature(id, { reviewed: true, expectedVersion: version })
                .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
                .catch(fail)
            }
          />
        ) : null}
        {data && path === "/roadmap" ? <Roadmap data={data} onSaved={saved} /> : null}
        {data && path === "/notes" ? (
          <Notes
            data={data}
            onCreate={(title, body, hidden) =>
              api
                .createNote({ title, body, ...(hidden ? { private: true } : {}) })
                .then(() => saved(`Saved the note ${title}.`))
                .catch((err: unknown) => {
                  fail(err);
                  throw err;
                })
            }
            onPatch={(id, patch) =>
              void api
                .patchNote(id, patch)
                .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
                .catch(fail)
            }
            onSaved={saved}
            onDelete={(id, title) => remove("note", id, title)}
            thread={thread}
          />
        ) : null}
        {data && path === "/memory" ? (
          <Memory
            data={data}
            onSaved={saved}
            onCopied={(message) => setToast(message)}
            onCopyFailed={copyFailed}
            onFailed={fail}
            onOpenTask={(id) => go("/", id)}
            onGo={show}
          />
        ) : null}
        {data && path === "/decisions" ? (
          <Decisions
            data={data}
            onSaved={saved}
            onDelete={(id, title) => remove("decision", id, title)}
            thread={thread}
          />
        ) : null}
        {data && path === "/changes" ? (
          <Changes
            data={data}
            onOpenTask={(id) => go(path, id)}
            onGo={show}
            onCopied={(message) => setToast(message)}
            onCopyFailed={copyFailed}
          />
        ) : null}
        {data && path === "/activity" ? <Activity data={data} /> : null}
        {data && path === "/settings" ? (
          <Settings data={data} onSaved={saved} onError={fail} />
        ) : null}
      </main>
      {data && task ? (
        <TaskSheet
          key={task}
          data={data}
          id={task}
          modal={!wide}
          inert={dialog}
          onDirty={setSheetDirty}
          onToast={setToast}
          onClose={() => go(path)}
          onSave={(id, patch) =>
            api
              // Approving from the panel names the commit on screen, as a drag to Done does.
              .patchTask(id, {
                ...patch,
                ...(patch.status === "done" && data ? approvedCommit(data, id) : {}),
              })
              // Resolve before the refetch: the panel takes the saved task as its new baseline
              // first, or the refetched task looks like someone else's change while it is
              // still dirty.
              .then((saved) => {
                void client.invalidateQueries({ queryKey: ["snapshot"] });
                return saved;
              })
              .catch((err: unknown) => {
                fail(err);
                throw err;
              })
          }
          onRelease={(id, force) =>
            void api
              .releaseTask(id, force)
              .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
              .catch(fail)
          }
          onTakeOver={(id) =>
            void api
              .takeOver(id)
              .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
              .catch(fail)
          }
          onDelete={(id, title) => {
            // Keeping unsaved edits means keeping the task.
            if (go(path)) remove("task", id, title);
          }}
          thread={thread}
        />
      ) : null}
      {creating && data ? (
        <NewTask
          data={data}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setToast(`Created ${created.title}.`);
            void client.invalidateQueries({ queryKey: ["snapshot"] });
          }}
        />
      ) : null}
      {sendingBack && data ? (
        <SendBack
          titles={sendingBack.ids.flatMap((id) => {
            const t = data.tasks.find((x) => x.id === id);
            return t && needsReason(t, sendingBack.status) ? [t.title] : [];
          })}
          onClose={() => setSendingBack(null)}
          onSend={async (reason) => {
            const { ids, status, bulk } = sendingBack;
            setSendingBack(null);
            await moveMany(ids, status, bulk, reason);
          }}
        />
      ) : null}
      {palette ? (
        <Palette
          data={data}
          onClose={() => setPalette(false)}
          onGo={go}
          onShow={show}
          onToast={setToast}
          onError={fail}
        />
      ) : null}
      {/* Always mounted: a live region added together with its message is often not read. Errors
          use an assertive alert region; everything else is a polite status. */}
      <div role="status" aria-live="polite" className="toast-region">
        {toast && !toast.error ? toastBox(toast, setToast) : null}
      </div>
      <div role="alert" className="toast-region">
        {toast?.error ? toastBox(toast, setToast) : null}
      </div>
    </div>
  );
}

/** The toast itself, for either live region. */
function toastBox(
  toast: { message: string; undo?: () => void; error?: boolean },
  setToast: (message: string | null) => void,
) {
  return (
    <div className={toast.error ? "toast error" : "toast"}>
      <span className="toast-text">{toast.message}</span>
      <span className="toast-actions">
        {toast.undo ? (
          <button
            type="button"
            className="undo"
            onClick={() => {
              toast.undo?.();
              setToast(null);
            }}
          >
            Undo
          </button>
        ) : null}
        <button type="button" onClick={() => setToast(null)}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

/**
 * Search. Its text and results live here, so typing does not re-render the board behind it.
 * Closing unmounts it, which clears them and puts focus back where it was.
 */
function Palette({
  data,
  onClose,
  onGo,
  onShow,
  onToast,
  onError,
}: {
  data: Snapshot | undefined;
  onClose: () => void;
  onGo: (path: string, taskId?: string | null) => void;
  /** Opens a list page at one record. */
  onShow: (path: string, id: string) => void;
  onToast: (message: string) => void;
  onError: (err: unknown) => void;
}) {
  const [queryText, setQueryText] = useState("");
  const [hits, setHits] = useState<{ entity: string; id: string; title: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchRun = useRef(0);
  useEffect(() => {
    const previous = document.activeElement;
    searchRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
      <button
        type="button"
        className="palette-dismiss"
        aria-label="Close search"
        tabIndex={-1}
        onClick={onClose}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const text = queryText.trim();
          if (!text) return;
          setSearching(true);
          setSearched(false);
          // Only the latest search may show: an earlier, slower answer is dropped.
          const run = ++searchRun.current;
          void api
            .search(text)
            .then((res) => {
              if (run !== searchRun.current) return;
              // A general project has no Features page to open a feature on.
              const general = data?.project?.kind === "general";
              setHits(res.hits.filter((h) => !(general && h.entity === "feature")));
              setSearched(true);
            })
            .catch((err: unknown) => {
              if (run === searchRun.current) onError(err);
            })
            .finally(() => {
              if (run === searchRun.current) setSearching(false);
            });
        }}
      >
        <input
          ref={searchRef}
          value={queryText}
          onChange={(e) => {
            setQueryText(e.target.value);
            // Hits for the old text would read as answers to the new one.
            searchRun.current++;
            setHits([]);
            setSearched(false);
            setSearching(false);
          }}
          placeholder="Search tasks, notes, decisions, features"
          aria-label="Search"
        />
        <div role="status" className="meta">
          {searching
            ? "Searching…"
            : !searched
              ? "Press Enter to search."
              : hits.length === 0
                ? "No results"
                : hits.length >= SEARCH_LIMIT
                  ? `First ${SEARCH_LIMIT} results`
                  : `${hits.length} result${hits.length === 1 ? "" : "s"}`}
        </div>
        {hits.map((hit) => {
          const titleOf = (id: string) =>
            (id.startsWith("tsk_")
              ? data?.tasks
              : id.startsWith("dec_")
                ? data?.decisions
                : data?.notes
            )?.find((r) => r.id === id)?.title;
          const note = data?.notes.find((n) => n.id === hit.id);
          const on = note ? threadOf(note) : undefined;
          const about = on ? titleOf(on) : undefined;
          return (
            <button
              type="button"
              key={`${hit.entity}-${hit.id}`}
              onClick={() => {
                onClose();
                // A comment opens what it is on; one whose record was deleted says so.
                if (on && about === undefined) onToast("That comment is on something deleted.");
                else if (hit.entity === "task") onGo("/", hit.id);
                else if (on?.startsWith("tsk_")) onGo("/", on);
                else
                  onShow(
                    HIT_PAGES[on ? (on.startsWith("dec_") ? "decision" : "note") : hit.entity] ??
                      "/",
                    on ?? hit.id,
                  );
              }}
            >
              <span className="badge">{on ? "Comment" : kindLabel(hit.entity)}</span>{" "}
              {about ? `on ${about}` : hit.title}
            </button>
          );
        })}
      </form>
    </div>
  );
}
