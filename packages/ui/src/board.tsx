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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Actor, ago, COLUMNS, dueLabel, type Feature, type Task, waitingOn } from "./api.js";
import { Avatar } from "./people.js";
import { capital, fullTime, statusWord } from "./words.js";

export function Board({
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
  onReviewed,
  onMove,
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
  onReviewed: (id: string) => void;
  onMove: (id: string, status: string) => void;
}) {
  const { featureName, columns } = boardColumns(tasks, features);
  const people = useMemo(() => new Map(actors.map((a) => [a.id, a])), [actors]);
  // From every task, not only the filtered ones: a hidden task can still hold another one up.
  const unfinished = new Set(
    allTasks.filter((t) => t.status !== "done" && t.status !== "cancelled").map((t) => t.id),
  );
  const waiting = (t: Task) => (t.dependsOn ?? []).filter((id) => unfinished.has(id)).length;
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
    onDragOver: ({ active, over }) =>
      over ? `${titleOf(active.id)} is over ${columnOf(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `${titleOf(active.id)} moved to ${columnOf(over.id)}.`
        : `${titleOf(active.id)} was dropped outside the columns and stays where it was.`,
    onDragCancel: ({ active }) => `Moving ${titleOf(active.id)} was cancelled.`,
  };
  const dragged = tasks.find((t) => t.id === dragging);
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
}

function Column({
  status,
  label,
  show,
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
  onReviewed,
}: {
  status: string;
  label: string;
  show: boolean;
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
    <section className={show ? "column show" : "column"} ref={sectionRef} aria-label={label}>
      <h2>
        {label} <span className="count">{count}</span>
        {isOver ? " · drop" : ""}
      </h2>
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
        onReviewed={onReviewed}
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
          <time dateTime={task.updatedAt} title={fullTime(task.updatedAt)}>
            {ago(task.updatedAt)}
          </time>
          {feature ? ` · ${feature}` : ""}
          {urgent ? ` · ${capital(task.priority)}` : ""}
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
