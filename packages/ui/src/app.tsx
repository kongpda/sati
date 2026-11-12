import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type Deletable, phoneColumn, type Task } from "./api.js";
import { boardOrder } from "./board.js";
import { Changes } from "./changes.js";
import { NewTask, SendBack } from "./forms.js";
import { useKeys } from "./hooks/use-keys.js";
import { useLive } from "./hooks/use-live.js";
import { approvedCommit, useMoves } from "./hooks/use-moves.js";
import { useRoute } from "./hooks/use-route.js";
import { Memory } from "./memory.js";
import {
  allInReview,
  heldByOther,
  moveRefusal,
  moveTargets,
  needsReason,
  personOnly,
} from "./moves.js";
import { inboxCount, MyWork } from "./my-work.js";
import { BoardPage } from "./pages/board-page.js";
import { Activity, Agents, Decisions, Features, Notes, Roadmap, TaskSheet } from "./pages.js";
import { holderName } from "./people.js";
import { Settings } from "./settings.js";
import { Nav } from "./shell/nav.js";
import { Palette } from "./shell/palette.js";
import { toastBox } from "./shell/toast.js";
import { TopBar } from "./shell/top-bar.js";
import { COMMENT_TAG, threadOf } from "./thread.js";
import { plainError, statusWord } from "./words.js";

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

export function App() {
  const query = useQuery({ queryKey: ["snapshot"], queryFn: api.snapshot });
  const client = useQueryClient();
  const { path, task, cursor, go, setSheetDirty, setDraft } = useRoute();
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
      setToastState((shown) =>
        message === null
          ? null
          : // A plain "Saved" must not take away an Undo that is still offered: the live refresh
            // after a delete often lands a second message within the Undo's ten seconds.
            shown?.undo && !undo
            ? shown
            : { message, ...(undo ? { undo } : {}) },
      ),
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
  /** The cards as the board shows them, set on each render for the key handler. */
  const visible = useRef<Task[]>([]);
  /** On a wide screen the task panel sits beside the board, which stays usable. */
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
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

  useLive(client, moving, setOffline, setExpired, setFresh);
  const { moveMany, requestMove } = useMoves(
    client,
    moving,
    setToastState,
    fail,
    setSelected,
    setSendingBack,
  );
  useKeys({
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
  });

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
  // Approve and Send back for a selection of finished work; the person-only rule is core's, and
  // the board says it before the click, as the single card does.
  const reviewing = useMemo(
    () => !!query.data && allInReview(query.data.tasks.filter((t) => selected.has(t.id))),
    [query.data, selected],
  );
  const approveRefusal =
    query.data && query.data.project?.review !== "none" ? personOnly(query.data) : null;
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
  const selectColumn = useCallback(
    (ids: string[], on: boolean) =>
      setSelected((cur) => {
        const next = new Set(cur);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
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
      <Nav
        pages={pages}
        path={path}
        projectName={data?.project?.name}
        inbox={inbox}
        modal={modal}
        go={go}
      />
      <main className="main" inert={modal} data-modal={modal ? "" : undefined}>
        <TopBar
          onBoard={path === "/"}
          filter={filter}
          setFilter={setFilter}
          feature={feature}
          setFeature={setFeature}
          features={data?.features}
          setPalette={setPalette}
          setCreating={setCreating}
        />
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
          <BoardPage
            data={data}
            tasks={tasks}
            pinned={pinned}
            working={working}
            column={column}
            setColumn={setColumn}
            selected={selected}
            reviewing={reviewing}
            approveRefusal={approveRefusal}
            bulkTargets={bulkTargets}
            fresh={fresh}
            task={task}
            go={go}
            moveMany={moveMany}
            requestMove={requestMove}
            setToastState={setToastState}
            openTask={openTask}
            toggle={toggle}
            selectColumn={selectColumn}
            reviewed={reviewed}
            moveCard={moveCard}
            refusal={refusal}
            heldBy={heldBy}
          />
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
