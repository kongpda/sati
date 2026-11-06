import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, COLUMNS, type Snapshot } from "./api.js";
import { Board } from "./board.js";
import { Activity, Agents, Decisions, Features, Notes, Roadmap, TaskSheet } from "./pages.js";

const PAGES = [
  ["/", "Board"],
  ["/agents", "Agents"],
  ["/roadmap", "Roadmap"],
  ["/features", "Features"],
  ["/notes", "Notes"],
  ["/decisions", "Decisions"],
  ["/activity", "Activity"],
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
  const [toast, setToast] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [queryText, setQueryText] = useState("");
  const [hits, setHits] = useState<{ entity: string; id: string; title: string }[]>([]);
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

  const fail = useCallback((err: unknown) => {
    const message = err instanceof ApiError ? err.message : "That change did not save.";
    const hint = err instanceof ApiError ? err.hint : null;
    setToast(hint ? `${message} ${hint}` : message);
  }, []);

  async function move(id: string, status: string) {
    const current = client.getQueryData<Snapshot>(["snapshot"]);
    const item = current?.tasks.find((t) => t.id === id);
    if (!item || item.status === status) return;
    if (status === "done") {
      setToast("Done needs `sati task complete`, so the summary and files are recorded.");
      return;
    }
    client.setQueryData<Snapshot>(["snapshot"], (snap) =>
      snap ? { ...snap, tasks: snap.tasks.map((t) => (t.id === id ? { ...t, status } : t)) } : snap,
    );
    try {
      await api.patchTask(id, { status, expectedVersion: item.version });
      await client.invalidateQueries({ queryKey: ["snapshot"] });
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
      fail(err);
      await client.invalidateQueries({ queryKey: ["snapshot"] });
    }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette(true);
        return;
      }
      if (event.key === "Escape") {
        setPalette(false);
        if (task) go(path);
        return;
      }
      if (typing) return;
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
        const title = window.prompt("Task title");
        if (title)
          void api
            .createTask(title)
            .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
            .catch(fail);
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
  }, [client, fail, feature, filter, go, path, task]);

  useEffect(() => {
    if (palette) searchRef.current?.focus();
  }, [palette]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(id);
  }, [toast]);

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
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tasks"
            aria-label="Filter tasks"
          />
          <select value={feature} onChange={(e) => setFeature(e.target.value)} aria-label="Feature">
            <option value="">All features</option>
            {data?.features.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setPalette(true)}>
            Search
          </button>
        </div>
        {path === "/" ? (
          <>
            <h1 className="sr-only">Board</h1>
            {(data?.tasks ?? []).some((t) => t.claim) ? (
              <div className="live">
                {(data?.tasks ?? [])
                  .filter((t) => t.claim)
                  .map((t) => (
                    <span className="pill" key={t.id}>
                      <strong>
                        {data?.actors.find((a) => a.id === t.claim?.actorId)?.name ?? "agent"}
                      </strong>{" "}
                      · {t.title}
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
                    if (!status) return;
                    for (const id of selected) void move(id, status);
                    setSelected(new Set());
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
            {query.isLoading ? (
              <p className="empty">Loading the board…</p>
            ) : query.isError ? (
              <p className="empty" role="alert">
                The board could not load.{" "}
                {query.error instanceof ApiError ? query.error.message : "Reload this page."}
              </p>
            ) : data && data.tasks.length === 0 ? (
              <p className="empty">No tasks yet. Press c, or run sati task create "First task".</p>
            ) : (
              <Board
                tasks={tasks}
                features={data?.features ?? []}
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
        {data && path === "/agents" ? (
          <Agents
            data={data}
            onRelease={() =>
              void api
                .releaseExpired()
                .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
                .catch(fail)
            }
          />
        ) : null}
        {data && path === "/features" ? (
          <Features
            data={data}
            onSavePaths={(id, paths, version) =>
              void api
                .patchFeature(id, {
                  paths: paths
                    .split(",")
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
        {data && path === "/roadmap" ? <Roadmap data={data} /> : null}
        {data && path === "/notes" ? (
          <Notes
            data={data}
            onCreate={(title, body) =>
              void api
                .createNote({ title, body })
                .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
                .catch(fail)
            }
            onReviewed={(id, version) =>
              void api
                .patchNote(id, { reviewed: true, expectedVersion: version })
                .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
                .catch(fail)
            }
          />
        ) : null}
        {data && path === "/decisions" ? <Decisions data={data} /> : null}
        {data && path === "/activity" ? <Activity data={data} /> : null}
      </main>
      {data && task ? (
        <TaskSheet
          data={data}
          id={task}
          onClose={() => go(path)}
          onSave={(id, patch) =>
            void api
              .patchTask(id, patch)
              .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
              .catch(fail)
          }
        />
      ) : null}
      {palette ? (
        <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
          <button
            type="button"
            className="palette-dismiss"
            aria-label="Close search"
            onClick={() => setPalette(false)}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void api
                .search(queryText)
                .then((res) => setHits(res.hits))
                .catch(fail);
            }}
          >
            <input
              ref={searchRef}
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="Search tasks, notes, decisions"
              aria-label="Search"
            />
            {hits.map((hit) => (
              <button
                type="button"
                key={`${hit.entity}-${hit.id}`}
                onClick={() => {
                  setPalette(false);
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
          {toast}
          <button type="button" onClick={() => setToast(null)}>
            {" "}
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
