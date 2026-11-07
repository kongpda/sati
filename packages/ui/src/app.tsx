import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, COLUMNS, type Deletable, type Snapshot, type Task } from "./api.js";
import { Board, boardOrder } from "./board.js";
import { Changes } from "./changes.js";
import { NewTask } from "./forms.js";
import { Memory } from "./memory.js";
import { MyWork } from "./my-work.js";
import { Activity, Agents, Decisions, Features, Notes, Roadmap, TaskSheet } from "./pages.js";
import { nameOf } from "./people.js";
import { Settings } from "./settings.js";
import { threadOf } from "./thread.js";
import { plainError } from "./words.js";

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

/** Pages a general project does without: it has no features, file reservations or guard. */
const CODE_ONLY = new Set<string>(["/agents", "/features"]);

/** The phone layout in styles.css: one column at a time. */
const PHONE = "(max-width: 700px)";

/** Where a search hit of each kind opens, and the tag it shows. */
const HIT_PAGES: Record<string, string> = {
  note: "/notes",
  decision: "/decisions",
  feature: "/features",
  context: "/memory",
};
const HIT_KINDS: Record<string, string> = {
  task: "Task",
  note: "Note",
  decision: "Decision",
  feature: "Feature",
  context: "Card",
};

export function App() {
  const query = useQuery({ queryKey: ["snapshot"], queryFn: api.snapshot });
  const client = useQueryClient();
  const [path, setPath] = useState(window.location.pathname);
  const [task, setTask] = useState<string | null>(
    new URLSearchParams(window.location.search).get("task"),
  );
  const [filter, setFilter] = useState("");
  const [feature, setFeature] = useState("");
  const [column, setColumn] = useState(() =>
    window.matchMedia(PHONE).matches ? "in_progress" : "all",
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [toast, setToastState] = useState<{ message: string; undo?: () => void } | null>(null);
  const setToast = useCallback(
    (message: string | null, undo?: () => void) =>
      setToastState(message === null ? null : { message, ...(undo ? { undo } : {}) }),
    [],
  );
  const [palette, setPalette] = useState(false);
  const [creating, setCreating] = useState(false);
  const [queryText, setQueryText] = useState("");
  const [hits, setHits] = useState<{ entity: string; id: string; title: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [offline, setOffline] = useState(false);
  /** The task j/k steps from: the open one, or the last one opened. */
  const cursor = useRef<string | null>(null);
  /** The cards as the board shows them, set on each render for the key handler. */
  const visible = useRef<Task[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  // A phone shows one column, a wider screen all of them; turning or resizing past the
  // breakpoint switches, or the board keeps a layout made for the other width.
  useEffect(() => {
    const phone = window.matchMedia(PHONE);
    const onChange = () => setColumn(phone.matches ? "in_progress" : "all");
    phone.addEventListener("change", onChange);
    return () => phone.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (task) cursor.current = task;
  }, [task]);

  useEffect(() => {
    const onPop = () => {
      setPath(window.location.pathname);
      setTask(new URLSearchParams(window.location.search).get("task"));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const source = new EventSource("/events");
    source.onopen = () => {
      setOffline(false);
      void client.invalidateQueries({ queryKey: ["snapshot"] });
    };
    source.onerror = () => setOffline(true);
    source.onmessage = () => {
      const previous = client.getQueryData<Snapshot>(["snapshot"]);
      void client.invalidateQueries({ queryKey: ["snapshot"] }).then(() => {
        const next = client.getQueryData<Snapshot>(["snapshot"]);
        if (!previous || !next) return;
        const before = new Map(previous.tasks.map((t) => [t.id, t.updatedAt]));
        const changed = next.tasks.filter((t) => before.get(t.id) !== t.updatedAt).map((t) => t.id);
        if (changed.length === 0) return;
        setFresh(new Set(changed));
        window.setTimeout(() => setFresh(new Set()), 1600);
      });
    };
    return () => source.close();
  }, [client]);

  const go = useCallback((next: string, taskId: string | null = null) => {
    const url = taskId ? `${next}?task=${taskId}` : next;
    window.history.pushState(null, "", url);
    setPath(next);
    setTask(taskId);
  }, []);

  const fail = useCallback(
    (err: unknown) => {
      setToast(plainError(err));
    },
    [setToast],
  );

  const saved = useCallback(
    (message: string) => {
      setToast(message);
      void client.invalidateQueries({ queryKey: ["snapshot"] });
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
  };

  const closePalette = useCallback(() => {
    setPalette(false);
    setQueryText("");
    setHits([]);
    setSearching(false);
    setSearched(false);
  }, []);

  /** Resolves true when the task moved. Pass `onFail` to report the reason yourself. */
  async function move(
    id: string,
    status: string,
    onFail?: (reason: string) => void,
  ): Promise<boolean> {
    const current = client.getQueryData<Snapshot>(["snapshot"]);
    const item = current?.tasks.find((t) => t.id === id);
    if (!item || item.status === status) return false;
    // A person approves work waiting in review; anything else reaches done through
    // `task complete`, which records the summary and the files.
    if (status === "done" && item.status !== "review") {
      (onFail ?? setToast)(
        "Only work waiting for approval can be moved to Done. Whoever does the task finishes it with a summary.",
      );
      return false;
    }
    // A refetch already in flight would overwrite the optimistic status with the old one.
    await client.cancelQueries({ queryKey: ["snapshot"] });
    client.setQueryData<Snapshot>(["snapshot"], (snap) =>
      snap ? { ...snap, tasks: snap.tasks.map((t) => (t.id === id ? { ...t, status } : t)) } : snap,
    );
    try {
      await api.patchTask(id, { status, expectedVersion: item.version });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      return true;
    } catch (err) {
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
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      return false;
    }
  }

  async function moveSelected(status: string) {
    const ids = [...selected];
    // Say why once: the tasks usually fail for the same reason.
    let reason = "";
    const results = await Promise.all(
      ids.map((id) =>
        move(id, status, (why) => {
          reason ||= why;
        }),
      ),
    );
    const failed = ids.filter((_, i) => !results[i]);
    setSelected(new Set(failed));
    if (failed.length > 0) {
      setToast(`${failed.length} of ${ids.length} tasks did not move. ${reason}`.trim());
    }
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
      // j/k pass from the sheet's heading (where it puts focus), to step to the next card.
      if (!(step && target?.id === "sheet-title") && target?.closest(".sheet, button, a")) return;
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
      if (event.key === "Enter" && task) go("/", task);
      if (event.key === "c") {
        // Keep the "c" from being typed into the title field the dialog focuses.
        event.preventDefault();
        setCreating(true);
      }
      if (event.key === "x" && task) {
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
    if (!palette) return;
    const previous = document.activeElement;
    searchRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [palette]);

  useEffect(() => {
    if (!toast) return;
    // An Undo stays a little longer, so there is time to reach it.
    const id = window.setTimeout(() => setToast(null), toast.undo ? 10000 : 6000);
    return () => window.clearTimeout(id);
  }, [toast, setToast]);

  const general = query.data?.project?.kind === "general";
  // A general project shows no features or file reservations anywhere, even ones left over
  // from when it was a code project; they stay in the store and come back if it switches back.
  const data = query.data && general ? { ...query.data, features: [], locks: [] } : query.data;
  const pages = PAGES.filter(([href]) => !(general && CODE_ONLY.has(href)));
  // The feature filter is hidden in a general project, so it must not keep narrowing the board.
  useEffect(() => {
    if (general) setFeature("");
  }, [general]);
  const pageLabel = pages.find(([href]) => href === path)?.[1];
  const projectName = data?.project?.name;
  // Each page names itself in the tab, and on a phone the nav bar scrolls to the current page.
  useEffect(() => {
    document.title = [pageLabel, projectName ?? __PRODUCT_NAME__].filter(Boolean).join(" · ");
    document
      .querySelector('.nav a[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pageLabel, projectName]);
  const tasks = (data?.tasks ?? []).filter((t) => {
    if (feature && t.featureId !== feature) return false;
    if (filter && !`${t.title} ${t.body}`.toLowerCase().includes(filter.toLowerCase()))
      return false;
    return true;
  });
  visible.current = data ? boardOrder(tasks, data.features, column) : [];
  // The brand kit or event brief one click from the board; the brief gives agents the same 3.
  const pinned = (data?.notes ?? [])
    .filter((n) => n.pinned && !threadOf(n) && !n.tags.includes("comment"))
    .slice(0, 3);

  // While the task panel, New task or Search is open, the page behind it takes no focus or
  // clicks, so Tab stays inside the dialog (aria-modal alone does not stop it).
  const modal = creating || palette || (task !== null && !!data?.tasks.some((t) => t.id === task));

  return (
    <div className="app">
      <nav className="nav" inert={modal}>
        <p className="brand">{data?.project?.name ?? __PRODUCT_NAME__}</p>
        {pages.map(([href, label]) => (
          <a
            key={href}
            href={href}
            aria-current={path === href ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              go(href);
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      <main className="main" inert={modal}>
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
        {offline ? (
          <p className="banner" role="status">
            Live updates disconnected. Reconnecting…
          </p>
        ) : null}
        {query.isLoading ? <p className="empty page">Loading…</p> : null}
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
            {(data?.tasks ?? []).some((t) => t.claim) ? (
              <div className="live">
                {(data?.tasks ?? [])
                  .filter((t) => t.claim)
                  .map((t) => (
                    <span className="pill" key={t.id}>
                      <strong>{data ? nameOf(data, t.claim?.actorId) : ""}</strong> · {t.title}
                    </span>
                  ))}
              </div>
            ) : null}
            <select
              className="mobile-status"
              value={column}
              onChange={(e) => setColumn(e.target.value)}
              aria-label="Column"
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
                    void moveSelected(status);
                  }}
                >
                  <option value="">Move to…</option>
                  {COLUMNS.filter(([id]) => id !== "done").map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
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
                features={data?.features ?? []}
                actors={data?.actors ?? []}
                fresh={fresh}
                selected={selected}
                column={column}
                onOpen={(id) => go("/", id)}
                onToggle={(id) =>
                  setSelected((cur) => {
                    const next = new Set(cur);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onReviewed={(id) => {
                  const item = data?.tasks.find((t) => t.id === id);
                  if (!item) return;
                  void api
                    .patchTask(id, { reviewed: true, expectedVersion: item.version })
                    .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
                    .catch(fail);
                }}
                onMove={(id, status) => void move(id, status)}
              />
            )}
          </>
        ) : null}
        {data && path === "/my-work" ? (
          <MyWork
            data={data}
            onOpen={(id) => go(path, id)}
            onApprove={(t) =>
              void api
                .patchTask(t.id, { status: "done", expectedVersion: t.version })
                .then(() => saved(`Approved ${t.title}.`))
                .catch(fail)
            }
            onSendBack={(t, reason) =>
              api
                .patchTask(t.id, { status: "todo", reason, expectedVersion: t.version })
                .then(() => saved(`Sent ${t.title} back to todo.`))
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
                .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
                .catch(fail)
            }
            onReleaseTask={(id) => {
              const t = data.tasks.find((x) => x.id === id);
              const name = nameOf(data, t?.claim?.actorId);
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
              void api
                .patchFeature(id, {
                  paths: paths
                    .split(/\r?\n/u)
                    .map((p) => p.trim())
                    .filter(Boolean),
                  expectedVersion: version,
                })
                .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
                .catch(fail)
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
                .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
                .then(() => undefined)
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
            onOpenTask={(id) => go("/", id)}
            onGo={(next) => go(next)}
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
            onGo={(next) => go(next)}
            onCopied={(message) => setToast(message)}
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
          onClose={() => go(path)}
          onSave={(id, patch) =>
            api
              .patchTask(id, patch)
              .then(async (saved) => {
                await client.invalidateQueries({ queryKey: ["snapshot"] });
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
            go(path);
            remove("task", id, title);
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
      {palette ? (
        <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
          <button
            type="button"
            className="palette-dismiss"
            aria-label="Close search"
            tabIndex={-1}
            onClick={closePalette}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = queryText.trim();
              if (!text) return;
              setSearching(true);
              setSearched(false);
              void api
                .search(text)
                .then((res) => {
                  setHits(res.hits);
                  setSearched(true);
                })
                .catch(fail)
                .finally(() => setSearching(false));
            }}
          >
            <input
              ref={searchRef}
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="Search tasks, notes, decisions, features"
              aria-label="Search"
            />
            {searching ? <p className="meta">Searching…</p> : null}
            {!searching && !searched ? <p className="meta">Press Enter to search.</p> : null}
            {searched && hits.length === 0 ? <p className="meta">No results</p> : null}
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
                    closePalette();
                    // A comment opens what it is on; one whose record was deleted says so.
                    if (on && about === undefined)
                      setToast("That comment is on something deleted.");
                    else if (hit.entity === "task") go("/", hit.id);
                    else if (on?.startsWith("tsk_")) go("/", on);
                    else
                      go(
                        HIT_PAGES[
                          on ? (on.startsWith("dec_") ? "decision" : "note") : hit.entity
                        ] ?? "/",
                      );
                  }}
                >
                  <span className="badge">
                    {on ? "Comment" : (HIT_KINDS[hit.entity] ?? hit.entity)}
                  </span>{" "}
                  {about ? `on ${about}` : hit.title}
                </button>
              );
            })}
          </form>
        </div>
      ) : null}
      {toast ? (
        <div className="toast" role="status">
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
      ) : null}
    </div>
  );
}
