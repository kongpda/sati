import {
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
import { useRef, useState } from "react";
import { ago, COLUMNS, type Feature, type Task } from "./api.js";

export function Board({
  tasks,
  features,
  fresh,
  selected,
  column,
  onOpen,
  onToggle,
  onReviewed,
  onMove,
}: {
  tasks: Task[];
  features: Feature[];
  fresh: Set<string>;
  selected: Set<string>;
  column: string;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onReviewed: (id: string) => void;
  onMove: (id: string, status: string) => void;
}) {
  const byFeature = new Map(features.map((f) => [f.id, f.title]));
  const featureName = (id: string | null) => (id ? (byFeature.get(id) ?? "") : "");
  // A drag starts only after the pointer moves, so a plain click still opens the card.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const [dragging, setDragging] = useState<string | null>(null);
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
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="board">
        {COLUMNS.map(([status, label]) => (
          <Column
            key={status}
            status={status}
            label={label}
            show={column === "all" || column === status}
            tasks={tasks.filter((t) => t.status === status)}
            featureName={featureName}
            fresh={fresh}
            selected={selected}
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
  tasks,
  featureName,
  fresh,
  selected,
  onOpen,
  onToggle,
  onReviewed,
}: {
  status: string;
  label: string;
  show: boolean;
  tasks: Task[];
  featureName: (id: string | null) => string;
  fresh: Set<string>;
  selected: Set<string>;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onReviewed: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const parent = useRef<HTMLDivElement>(null);
  const rows = laneRows(tasks, featureName);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: (index) => (rows[index]?.kind === "lane" ? 28 : 78),
    overscan: 8,
  });
  return (
    <section className={show ? "column show" : "column"} ref={setNodeRef} aria-label={label}>
      <h2>
        {label} <span className="count">{tasks.length}</span>
        {isOver ? " · drop" : ""}
      </h2>
      <div className="cards" ref={parent}>
        {tasks.length === 0 ? <p className="column-empty">No tasks</p> : null}
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
                  feature={featureName(item.task.featureId)}
                  fresh={fresh.has(item.task.id)}
                  selected={selected.has(item.task.id)}
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

function Card({
  task,
  feature,
  fresh,
  selected,
  onOpen,
  onToggle,
  onReviewed,
}: {
  task: Task;
  feature: string;
  fresh: boolean;
  selected: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onReviewed: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      className={`card${fresh ? " fresh" : ""}${selected ? " selected" : ""}${isDragging ? " ghost" : ""}`}
    >
      <div className="card-head">
        <button type="button" className="title" onClick={() => onOpen(task.id)}>
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
        fresh={fresh}
        selected={selected}
        onReviewed={onReviewed}
        onToggle={onToggle}
      />
    </div>
  );
}

/** The meta line. Without the handlers it is the plain copy shown while dragging. */
function CardBody({
  task,
  feature,
  fresh,
  selected,
  onToggle,
  onReviewed,
}: {
  task: Task;
  feature: string;
  fresh: boolean;
  selected: boolean;
  onToggle?: (id: string) => void;
  onReviewed?: (id: string) => void;
}) {
  const urgent = task.priority === "high" || task.priority === "urgent";
  return (
    <>
      {onToggle ? null : <div className="title">{task.title}</div>}
      <div className="meta">
        {fresh ? <span className="new-badge">new</span> : null}
        <time dateTime={task.updatedAt} title={task.updatedAt}>
          {ago(task.updatedAt)}
        </time>
        {feature ? ` · ${feature}` : ""}
        {urgent ? ` · ${task.priority}` : ""}
        {onReviewed && task.needsReview ? (
          <button type="button" onClick={() => onReviewed(task.id)}>
            mark reviewed
          </button>
        ) : null}
        {onToggle ? (
          <button
            type="button"
            aria-pressed={selected}
            aria-label={`Select ${task.title}`}
            onClick={() => onToggle(task.id)}
          >
            {selected ? "selected" : "select"}
          </button>
        ) : null}
      </div>
    </>
  );
}

type LaneRow = { kind: "lane"; key: string; title: string } | { kind: "task"; task: Task };

function laneRows(tasks: Task[], featureName: (id: string | null) => string): LaneRow[] {
  // Named features first, alphabetically; tasks without a feature go last.
  const sorted = [...tasks].sort((a, b) => {
    const left = featureName(a.featureId);
    const right = featureName(b.featureId);
    if (!left !== !right) return left ? -1 : 1;
    return left.localeCompare(right);
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
