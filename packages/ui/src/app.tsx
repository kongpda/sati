import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, COLUMNS, type Deletable, type Snapshot } from "./api.js";
import { Board } from "./board.js";
import { NewTask } from "./forms.js";
import { MyWork } from "./my-work.js";
import { Activity, Agents, Decisions, Features, Notes, Roadmap, TaskSheet } from "./pages.js";
import { nameOf } from "./people.js";
import { Settings } from "./settings.js";

const PAGES = [
  ["/", "Board"],
  ["/my-work", "My work"],
  ["/agents", "Agents"],
  ["/roadmap", "Roadmap"],
  ["/features", "Features"],
  ["/notes", "Notes"],
  ["/decisions", "Decisions"],
  ["/activity", "Activity"],
  ["/settings", "Settings"],
] as const;

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
    window.matchMedia("(max-width: 700px)").matches ? "in_progress" : "all",
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
  const cursor = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

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
      const message = err instanceof ApiError ? err.message : "That change did not save.";
      const hint = err instanceof ApiError ? err.hint : null;
      setToast((hint ? `${message} ${hint}` : message).replaceAll("`", ""));
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

  const closePalette = useCallback(() => {
    setPalette(false);
    setQueryText("");
    setHits([]);
    setSearching(false);
    setSearched(false);
  }, []);

  /** Resolves true when the task moved. Pass `quiet` to report failures yourself. */
  async function move(id: string, status: string, quiet = false): Promise<boolean> {
    const current = client.getQueryData<Snapshot>(["snapshot"]);
    const item = current?.tasks.find((t) => t.id === id);
    if (!item || item.status === status) return false;
    // A person approves work waiting in review; anything else reaches done through
    // `task complete`, which records the summary and the files.
    if (status === "done" && item.status !== "review") {
      setToast(`Done needs ${__CLI_NAME__} task complete, so the summary and files are recorded.`);
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
      if (!quiet) fail(err);
      await client.invalidateQueries({ queryKey: ["snapshot"] });
      return false;
    }
  }

  async function moveSelected(status: string) {
    const ids = [...selected];
    const results = await Promise.all(ids.map((id) => move(id, status, true)));
    const failed = ids.filter((_, i) => !results[i]);
    setSelected(new Set(failed));
    if (failed.length > 0) setToast(`${failed.length} of ${ids.length} tasks did not move.`);
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
      // Buttons and links use these keys themselves, and the sheet is a dialog of its own.
      if (target?.closest(".sheet, button, a")) return;
      if (event.key === "j" || event.key === "k") {
        const list = (client.getQueryData<Snapshot>(["snapshot"])?.tasks ?? []).filter((t) => {
          if (feature && t.featureId !== feature) return false;
          if (filter && !`${t.title} ${t.body}`.toLowerCase().includes(filter.toLowerCase()))
            return false;
          return true;
        });
        if (list.length === 0) return;
        const next = event.key === "j" ? cursor.current + 1 : cursor.current - 1;
        const index = (next + list.length) % list.length;
        cursor.current = index;
        const item = list[index];
        if (item) setTask(item.id);
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
  }, [client, closePalette, feature, filter, go, palette, path, task]);

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

  const data = query.data;
  const tasks = (data?.tasks ?? []).filter((t) => {
    if (feature && t.featureId !== feature) return false;
    if (filter && !`${t.title} ${t.body}`.toLowerCase().includes(filter.toLowerCase()))
      return false;
    return true;
  });

  return (
    <div className="app">
      <nav className="nav">
        <p className="brand">{data?.project?.name ?? "Sati"}</p>
        {PAGES.map(([href, label]) => (
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
      <main className="main">
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
              <p className="empty">
                No tasks yet. Use New task (or press c), ask your agent, or run {__CLI_NAME__} task
                create "First task".
              </p>
            ) : tasks.length === 0 ? (
              <p className="empty">No tasks match the filter.</p>
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
        {data && path === "/agents" ? (
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
                window.confirm(`Release ${t?.title ?? id} from ${name}? Their claim ends.`);
              if (!ok) return;
              void api
                .releaseTask(id, t?.claim?.actorId !== data.you)
                .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
                .catch(fail);
            }}
          />
        ) : null}
        {data && path === "/features" ? (
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
            onCreate={(title, body) =>
              api
                .createNote({ title, body })
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
          />
        ) : null}
        {data && path === "/decisions" ? (
          <Decisions
            data={data}
            onSaved={saved}
            onDelete={(id, title) => remove("decision", id, title)}
          />
        ) : null}
        {data && path === "/activity" ? <Activity data={data} /> : null}
        {data && path === "/settings" ? <Settings data={data} onSaved={saved} /> : null}
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
              placeholder="Search tasks, notes, decisions"
              aria-label="Search"
            />
            {searching ? <p className="meta">Searching…</p> : null}
            {searched && hits.length === 0 ? <p className="meta">No results</p> : null}
            {hits.map((hit) => (
              <button
                type="button"
                key={`${hit.entity}-${hit.id}`}
                onClick={() => {
                  closePalette();
                  if (hit.entity === "task") go("/", hit.id);
                  else
                    go(
                      hit.entity === "note"
                        ? "/notes"
                        : hit.entity === "decision"
                          ? "/decisions"
                          : "/features",
                    );
                }}
              >
                {hit.title}
              </button>
            ))}
          </form>
        </div>
      ) : null}
      {toast ? (
        <div className="toast" role="status">
          {toast.message}
          {toast.undo ? (
            <button
              type="button"
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
        </div>
      ) : null}
    </div>
  );
}
