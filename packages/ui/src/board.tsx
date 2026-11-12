import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type Actor, COLUMNS, dueLabel, type Feature, type Task, waitingOn } from "./api.js";
import { Avatar } from "./people.js";
import { readPrefs, usePrefs, writePrefs } from "./prefs.js";
import { Ago } from "./time.js";
import { capital, fullTime, statusWord } from "./words.js";

const WIDE = "(min-width: 701px)";
const subscribeWide = (listener: () => void) => {
  const query = window.matchMedia?.(WIDE);
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
};
/** Columns fold into rails only beside each other; on a phone one column fills the screen. */
const useWide = () =>
  useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia?.(WIDE).matches ?? true,
    () => true,
  );

function setFolded(status: string, folded: boolean): void {
  const rest = readPrefs().collapsedColumns.filter((s) => s !== status);
  writePrefs({ collapsedColumns: folded ? [...rest, status] : rest });
}

export const Board = memo(function Board({
  tasks,
  allTasks,
  features,
  actors,
  fresh,
  selected,
  open,
  column,
  onOpen,
  onToggle,
  onSelectColumn,
  onReviewed,
  onMove,
  refusal,
  heldBy,
}: {
  tasks: Task[];
  /** Every task, for which ones a card is waiting on. */
  allTasks: Task[];
  features: Feature[];
  actors: Actor[];
  fresh: Set<string>;
  selected: Set<string>;
  /** The task shown in the side panel, if any. */
  open: string | null;
  column: string;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  /** Selects or clears every task in a column; stable, so the memoised board is not redrawn. */
  onSelectColumn: (ids: string[], on: boolean) => void;
  onReviewed: (id: string) => void;
  onMove: (id: string, status: string) => void;
  /** Why the task cannot move to the column, or null when it can. */
  refusal: (task: Task, status: string) => string | null;
  /** Who else is working on the task, or null: its saves are refused until they stop. */
  heldBy: (task: Task) => string | null;
}) {
  const { featureName, columns } = useMemo(() => boardColumns(tasks, features), [tasks, features]);
  const people = useMemo(() => new Map(actors.map((a) => [a.id, a])), [actors]);
  const wide = useWide();
  const prefs = usePrefs();
  const folded = new Set(wide ? prefs.collapsedColumns : []);
  // From every task, not only the filtered ones: a hidden task can still hold another one up.
  const unfinished = useMemo(
    () =>
      new Set(
        allTasks.filter((t) => t.status !== "done" && t.status !== "cancelled").map((t) => t.id),
      ),
    [allTasks],
  );
  const waiting = useCallback(
    (t: Task) => (t.dependsOn ?? []).filter((id) => unfinished.has(id)).length,
    [unfinished],
  );
  // A drag starts only after the pointer moves, so a plain click still opens the card.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const [dragging, setDragging] = useState<string | null>(null);
  // Screen readers hear titles and column names, not the ids dnd-kit announces by default.
  const titleOf = (id: string | number) => allTasks.find((t) => t.id === id)?.title ?? "the task";
  const columnOf = (id: string | number | undefined) =>
    id === undefined ? "" : statusWord(String(id));
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}.`,
    onDragOver: ({ active, over }) => {
      if (!over) return undefined;
      const why = refused(active.id, over.id);
      return why
        ? `${titleOf(active.id)} cannot move to ${columnOf(over.id)}.`
        : `${titleOf(active.id)} is over ${columnOf(over.id)}.`;
    },
    onDragEnd: ({ active, over }) => {
      if (!over) {
        return `${titleOf(active.id)} was dropped outside the columns and stays where it was.`;
      }
      const why = refused(active.id, over.id);
      // The reason itself comes as an alert from the page.
      return why
        ? `${titleOf(active.id)} stays where it was.`
        : `${titleOf(active.id)} moved to ${columnOf(over.id)}.`;
    },
    onDragCancel: ({ active }) => `Moving ${titleOf(active.id)} was cancelled.`,
  };
  const dragged = allTasks.find((t) => t.id === dragging);
  function refused(id: string | number, status: string | number): string | null {
    const task = allTasks.find((t) => t.id === id);
    return task ? refusal(task, String(status)) : null;
  }
  function onDragStart(event: DragStartEvent) {
    setDragging(String(event.active.id));
  }
  function onDragEnd(event: DragEndEvent) {
    setDragging(null);
    const over = event.over?.id;
    if (typeof over === "string" && event.active.id !== over) onMove(String(event.active.id), over);
  }
  return (
    <DndContext
      sensors={sensors}
      accessibility={{ announcements }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="board">
        {columns.map(({ status, label, count, rows }) => (
          <Column
            key={status}
            status={status}
            label={label}
            show={shows(column, status)}
            folded={folded.has(status)}
            closed={
              dragged && dragged.status !== status ? refusal(dragged, status) !== null : false
            }
            heldBy={heldBy}
            count={count}
            rows={rows}
            featureName={features.length > 0 ? featureName : null}
            people={people}
            waiting={waiting}
            fresh={fresh}
            selected={selected}
            open={open}
            onOpen={onOpen}
            onToggle={onToggle}
            onSelectColumn={onSelectColumn}
            onReviewed={onReviewed}
          />
        ))}
      </div>
      <DragOverlay>
        {dragged ? (
          <div className="card dragging">
            <CardBody
              task={dragged}
              feature={featureName(dragged.featureId)}
              people={people}
              waiting={waiting(dragged)}
              fresh={false}
              selected={selected.has(dragged.id)}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
});

function Column({
  status,
  label,
  show,
  folded,
  closed,
  heldBy,
  count,
  rows,
  featureName,
  people,
  waiting,
  fresh,
  selected,
  open,
  onOpen,
  onToggle,
  onSelectColumn,
  onReviewed,
}: {
  status: string;
  label: string;
  show: boolean;
  /** The reader folded this column into a rail; it opens again for an open or selected task. */
  folded: boolean;
  /** The card being dragged cannot go here. */
  closed: boolean;
  heldBy: (task: Task) => string | null;
  count: number;
  rows: LaneRow[];
  /** null when there are no features: no lane headings, so no "No feature" in every column. */
  featureName: ((id: string | null) => string) | null;
  people: Map<string, Actor>;
  waiting: (task: Task) => number;
  fresh: Set<string>;
  selected: Set<string>;
  open: string | null;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onSelectColumn: (ids: string[], on: boolean) => void;
  onReviewed: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const section = useRef<HTMLElement | null>(null);
  // A stable ref: the virtual list re-renders on every scroll frame, and a new callback each
  // render would detach and re-register the drop target each time.
  const sectionRef = useCallback(
    (el: HTMLElement | null) => {
      setNodeRef(el);
      section.current = el;
    },
    [setNodeRef],
  );
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (index) => (rows[index]?.kind === "lane" ? 28 : 78),
    overscan: 8,
  });
  // From the rows, not the page: the virtual list draws only the cards in view.
  const ids = useMemo(() => rows.flatMap((r) => (r.kind === "task" ? [r.task.id] : [])), [rows]);
  const picked = ids.reduce((n, id) => n + (selected.has(id) ? 1 : 0), 0);
  const collapsed = folded && picked === 0 && !ids.includes(open ?? "");
  const openIndex = rows.findIndex((r) => r.kind === "task" && r.task.id === open);
  // Opening a card keeps it in view next to the panel: its column scrolls in sideways, and the
  // virtual list down to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a newly opened card scrolls.
  useEffect(() => {
    if (openIndex < 0) return;
    section.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    virtual.scrollToIndex(openIndex, { align: "auto" });
  }, [open]);
  return (
    <section
      className={`column${show ? " show" : ""}${closed ? " closed" : ""}${collapsed ? " collapsed" : ""}${isOver ? " over" : ""}`}
      ref={sectionRef}
      aria-label={label}
    >
      {collapsed ? (
        <button
          type="button"
          className="rail"
          aria-expanded={false}
          onClick={() => setFolded(status, false)}
        >
          {/* The name comes from the text, so it always holds what is shown. */}
          <span className="sr-only">{`Show ${label}, ${count} ${count === 1 ? "task" : "tasks"}`}</span>
          <span className="rail-count" aria-hidden="true">
            {count}
          </span>
          <span className="rail-name" aria-hidden="true">
            {label}
          </span>
        </button>
      ) : (
        <>
          <div className="column-head">
            {ids.length > 0 ? (
              <input
                type="checkbox"
                aria-label={`Select all in ${label}`}
                checked={picked === ids.length}
                ref={(el) => {
                  if (el) el.indeterminate = picked > 0 && picked < ids.length;
                }}
                onChange={(e) => onSelectColumn(ids, e.target.checked)}
              />
            ) : null}
            <h2>
              {label} <span className="count">{count}</span>
              {isOver ? (closed ? " · cannot move here" : " · drop") : ""}
            </h2>
            <button
              type="button"
              className="fold"
              aria-label={`Hide ${label}`}
              aria-expanded={true}
              onClick={() => setFolded(status, true)}
            >
              ‹
            </button>
          </div>
          <div className="cards" ref={parent}>
            {count === 0 ? <p className="column-empty">No tasks</p> : null}
            <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
              {virtual.getVirtualItems().map((row) => {
                const item = rows[row.index];
                if (!item) return null;
                const style = {
                  position: "absolute" as const,
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${row.start}px)`,
                };
                if (item.kind === "lane") {
                  return (
                    <div
                      key={item.key}
                      ref={virtual.measureElement}
                      data-index={row.index}
                      className="lane"
                      style={style}
                    >
                      {item.title}
                    </div>
                  );
                }
                return (
                  <div
                    key={item.task.id}
                    ref={virtual.measureElement}
                    data-index={row.index}
                    style={style}
                  >
                    <Card
                      task={item.task}
                      feature={featureName?.(item.task.featureId) ?? ""}
                      people={people}
                      waiting={waiting(item.task)}
                      fresh={fresh.has(item.task.id)}
                      selected={selected.has(item.task.id)}
                      heldBy={heldBy(item.task)}
                      open={item.task.id === open}
                      onOpen={onOpen}
                      onToggle={onToggle}
                      onReviewed={onReviewed}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** Memoised: each scroll frame re-renders the column, and cards whose props are unchanged skip it. */
const Card = memo(function Card({
  task,
  feature,
  people,
  waiting,
  fresh,
  selected,
  heldBy,
  open,
  onOpen,
  onToggle,
  onReviewed,
}: {
  task: Task;
  feature: string;
  people: Map<string, Actor>;
  waiting: number;
  fresh: boolean;
  selected: boolean;
  heldBy: string | null;
  open: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onReviewed: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      className={`card${fresh ? " fresh" : ""}${selected ? " selected" : ""}${open ? " open" : ""}${isDragging ? " ghost" : ""}`}
    >
      <div className="card-head">
        <button
          type="button"
          className="title"
          data-task={task.id}
          aria-current={open ? "true" : undefined}
          onClick={() => onOpen(task.id)}
        >
          {task.title}
        </button>
        <button
          type="button"
          className="handle"
          aria-label={`Move ${task.title}`}
          {...listeners}
          {...attributes}
        >
          <span aria-hidden="true">⠿</span>
        </button>
      </div>
      <CardBody
        task={task}
        feature={feature}
        people={people}
        waiting={waiting}
        fresh={fresh}
        selected={selected}
        heldBy={heldBy}
        // "Looks right" is a save: refused while someone else holds the task.
        {...(heldBy ? {} : { onReviewed })}
        onToggle={onToggle}
      />
    </div>
  );
});

/** The meta line. Without the handlers it is the plain copy shown while dragging. */
function CardBody({
  task,
  feature,
  people,
  waiting,
  fresh,
  selected,
  heldBy = null,
  onToggle,
  onReviewed,
}: {
  task: Task;
  feature: string;
  people: Map<string, Actor>;
  /** Open tasks this one depends on. */
  waiting: number;
  fresh: boolean;
  selected: boolean;
  heldBy?: string | null;
  onToggle?: (id: string) => void;
  onReviewed?: (id: string) => void;
}) {
  const urgent = task.priority === "high" || task.priority === "urgent";
  const due = task.dueDate ? dueLabel(task.dueDate, task.status) : null;
  const steps = task.checklist ?? [];
  const assignees = (task.assigneeIds ?? []).flatMap((id) => people.get(id) ?? []);
  return (
    <>
      {onToggle ? null : <div className="title">{task.title}</div>}
      <div className="meta">
        <span className="meta-text">
          {fresh ? <span className="new-badge">new</span> : null}
          {waitingOn(task) ? (
            <span className="needs-badge" title={waitingOn(task)?.text}>
              needs you
            </span>
          ) : null}
          {heldBy ? (
            <span
              className="held-badge"
              title={`${heldBy} is working on this. Open it to take it over or release it before you change it.`}
            >
              {heldBy}
            </span>
          ) : null}
          <time dateTime={task.updatedAt} title={fullTime(task.updatedAt)}>
            <Ago iso={task.updatedAt} />
          </time>
          {feature ? ` · ${feature}` : ""}
          {urgent ? ` · ${capital(task.priority)}` : ""}
          {task.effort === "light" || task.effort === "deep"
            ? ` · ${capital(task.effort)} effort`
            : ""}
          {due ? (
            <>
              {" · "}
              <time dateTime={task.dueDate ?? undefined} className={due.late ? "late" : undefined}>
                {due.late ? `late, ${due.text}` : due.text}
              </time>
            </>
          ) : null}
          {steps.length ? ` · ${steps.filter((c) => c.done).length}/${steps.length} steps` : ""}
          {task.status === "blocked" && task.blockedReason ? (
            <span className="blocked-reason" title={task.blockedReason}>
              {` · blocked: ${task.blockedReason.length > 60 ? `${task.blockedReason.slice(0, 59)}…` : task.blockedReason}`}
            </span>
          ) : null}
          {/* A plan's later stages sit in To do from the start; say which ones cannot start yet. */}
          {waiting > 0 && task.status === "todo" ? (
            <span className="waits">
              {" "}
              · waits for {waiting === 1 ? "1 task" : `${waiting} tasks`}
            </span>
          ) : null}
          {(task.labels ?? []).map((l) => (
            <span key={l} className="badge">
              {l}
            </span>
          ))}
          {assignees.length ? (
            <span className="avatars">
              {assignees.map((a) => (
                <Avatar key={a.id} actor={a} label />
              ))}
            </span>
          ) : null}
          {onReviewed && task.needsReview ? (
            <>
              {" · edited in two places "}
              <button
                type="button"
                aria-label={`${task.title} looks right after the merge`}
                onClick={() => onReviewed(task.id)}
              >
                Looks right
              </button>
            </>
          ) : null}
        </span>
        {onToggle ? (
          <button
            type="button"
            aria-pressed={selected}
            aria-label={`Select ${task.title}`}
            onClick={() => onToggle(task.id)}
          >
            {selected ? "Selected" : "Select"}
          </button>
        ) : null}
      </div>
    </>
  );
}

/** One collator for every lane sort; `localeCompare` sets one up on each call. */
const COLLATOR = new Intl.Collator();

type LaneRow = { kind: "lane"; key: string; title: string } | { kind: "task"; task: Task };

/** One function for the board's layout, so the board and j/k agree on the order. */
function boardColumns(tasks: Task[], features: Feature[]) {
  const byFeature = new Map(features.map((f) => [f.id, f.title]));
  const featureName = (id: string | null) => (id ? (byFeature.get(id) ?? "") : "");
  const columns = COLUMNS.map(([status, label]) => {
    const own = tasks.filter((t) => t.status === status);
    const rows: LaneRow[] =
      features.length > 0
        ? laneRows(own, featureName)
        : own.map((task) => ({ kind: "task", task }));
    return { status, label, count: own.length, rows };
  });
  return { featureName, columns };
}

const shows = (column: string, status: string) => column === "all" || column === status;

/** The cards in the order the person sees them: column by column, top to bottom. */
export function boardOrder(tasks: Task[], features: Feature[], column: string): Task[] {
  return boardColumns(tasks, features)
    .columns.filter((c) => shows(column, c.status))
    .flatMap((c) => c.rows.flatMap((row) => (row.kind === "task" ? [row.task] : [])));
}

function laneRows(tasks: Task[], featureName: (id: string | null) => string): LaneRow[] {
  // Named features first, alphabetically; tasks without a feature go last.
  const sorted = [...tasks].sort((a, b) => {
    const left = featureName(a.featureId);
    const right = featureName(b.featureId);
    if (!left !== !right) return left ? -1 : 1;
    return COLLATOR.compare(left, right);
  });
  const rows: LaneRow[] = [];
  let last = "\0";
  for (const task of sorted) {
    const title = featureName(task.featureId) || "No feature";
    if (title !== last) {
      rows.push({ kind: "lane", key: `${title}:${task.id}`, title });
      last = title;
    }
    rows.push({ kind: "task", task });
  }
  return rows;
}
