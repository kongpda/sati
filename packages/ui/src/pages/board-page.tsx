import type { Dispatch, SetStateAction } from "react";
import { COLUMNS, type Snapshot, type Task } from "../api.js";
import { Board } from "../board.js";
import type { Toast } from "../hooks/use-moves.js";
import { holderName } from "../people.js";

type BoardProps = Parameters<typeof Board>[0];

/** The board page: pinned notes, who is working, the phone's column choice, bulk actions, columns. */
export function BoardPage({
  data,
  tasks,
  pinned,
  working,
  column,
  setColumn,
  selected,
  reviewing,
  approveRefusal,
  bulkTargets,
  fresh,
  task,
  go,
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
  working: Task[];
  column: string;
  setColumn: (column: string) => void;
  selected: Set<string>;
  reviewing: boolean;
  approveRefusal: string | null;
  bulkTargets: Set<string>;
  fresh: Set<string>;
  task: string | null;
  go: (next: string, taskId?: string | null) => boolean;
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
  return (
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
