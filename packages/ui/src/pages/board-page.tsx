import type { Dispatch, SetStateAction } from "react";
import { COLUMNS, type Snapshot, type Task } from "../api.js";
import { Board, setFolded } from "../board.js";
import type { Toast } from "../hooks/use-moves.js";
import { usePrefs } from "../prefs.js";

type BoardProps = Parameters<typeof Board>[0];

/** The board page: pinned notes, who is working, the phone's column choice, bulk actions, columns. */
export function BoardPage({
  data,
  tasks,
  pinned,
  morePinned,
  filter,
  clearFilters,
  setCreating,
  working,
  column,
  setColumn,
  selected,
  setSelected,
  reviewing,
  approveRefusal,
  bulkTargets,
  fresh,
  task,
  go,
  show,
  moveMany,
  requestMove,
  setToastState,
  openTask,
  toggle,
  selectColumn,
  reviewed,
  moveCard,
  refusal,
  heldBy,
}: {
  data: Snapshot | undefined;
  /** The tasks that pass the filters. */
  tasks: Task[];
  pinned: { id: string; title: string }[];
  /** How many pinned notes are not listed. */
  morePinned: number;
  /** The text in the filter box, and a way to empty it and the feature choice. */
  filter: string;
  clearFilters: () => void;
  setCreating: (open: boolean) => void;
  working: Task[];
  column: string;
  setColumn: (column: string) => void;
  selected: Set<string>;
  setSelected: (selected: Set<string>) => void;
  reviewing: boolean;
  approveRefusal: string | null;
  bulkTargets: Set<string>;
  fresh: Set<string>;
  task: string | null;
  go: (next: string, taskId?: string | null) => boolean;
  /** Opens a list page at one record. */
  show: (next: string, id: string) => void;
  moveMany: (ids: string[], status: string, bulk: boolean, reason?: string) => Promise<void>;
  requestMove: (ids: string[], status: string, bulk?: boolean) => void;
  setToastState: Dispatch<SetStateAction<Toast | null>>;
  openTask: BoardProps["onOpen"];
  toggle: BoardProps["onToggle"];
  selectColumn: BoardProps["onSelectColumn"];
  reviewed: BoardProps["onReviewed"];
  moveCard: BoardProps["onMove"];
  refusal: BoardProps["refusal"];
  heldBy: BoardProps["heldBy"];
}) {
  const prefs = usePrefs();
  // One line: how many hold a live claim, not a pill for each.
  const workers = new Set(working.map((t) => t.claim?.actorId)).size;
  return (
    <>
      <h1 className="sr-only">Board</h1>
      {pinned.length > 0 ? (
        <nav className="pinned" aria-label="Pinned notes">
          <span className="meta">Pinned</span>
          {pinned.map((n) => (
            <a
              key={n.id}
              href="/knowledge"
              onClick={(e) => {
                e.preventDefault();
                show("/knowledge", n.id);
              }}
            >
              {n.title}
            </a>
          ))}
          {morePinned > 0 ? (
            <a
              href="/knowledge"
              onClick={(e) => {
                e.preventDefault();
                go("/knowledge");
              }}
            >
              +{morePinned} more
            </a>
          ) : null}
        </nav>
      ) : null}
      {working.length > 0 ? (
        <div className="live">
          <a
            href="/team"
            onClick={(e) => {
              e.preventDefault();
              go("/team");
            }}
          >
            {workers} {workers === 1 ? "agent" : "agents"} working now
          </a>
        </div>
      ) : null}
      <details className="columns-menu">
        <summary>Columns</summary>
        <fieldset>
          <legend className="sr-only">Show these columns</legend>
          {COLUMNS.map(([id, label]) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={!prefs.collapsedColumns.includes(id)}
                onChange={(e) => setFolded(id, !e.target.checked)}
              />{" "}
              {label}
            </label>
          ))}
        </fieldset>
      </details>
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
        <section className="bulk" aria-label="Selected tasks">
          <span aria-live="polite">{selected.size} selected</span>
          {reviewing ? (
            <>
              <button
                type="button"
                className="primary"
                aria-disabled={approveRefusal !== null}
                title={approveRefusal ?? undefined}
                onClick={() => {
                  if (approveRefusal) {
                    setToastState({ message: approveRefusal, error: true });
                    return;
                  }
                  if (window.confirm(`Approve ${selected.size} tasks?`)) {
                    void moveMany([...selected], "done", true);
                  }
                }}
              >
                Approve
              </button>
              <button type="button" onClick={() => requestMove([...selected], "todo", true)}>
                Send back
              </button>
            </>
          ) : null}
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
            {COLUMNS.filter(([id]) => id !== "done" && bulkTargets.has(id)).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          {bulkTargets.size === 0 ? (
            <span className="hint">None of these can be moved from here.</span>
          ) : null}
          <button type="button" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </section>
      ) : null}
      {!data ? null : data.tasks.length === 0 ? (
        <div className="empty page">
          <p>No tasks yet. Use New task (or press c), or ask your agent to plan the work.</p>
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Add the first task
          </button>
        </div>
      ) : tasks.length === 0 ? (
        <div className="empty page">
          <p>{filter ? `No task matches "${filter}".` : "No tasks match the filter."}</p>
          <button type="button" onClick={clearFilters}>
            Clear filter
          </button>
        </div>
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
          onSelectColumn={selectColumn}
          onReviewed={reviewed}
          onMove={moveCard}
          refusal={refusal}
          heldBy={heldBy}
        />
      )}
    </>
  );
}
