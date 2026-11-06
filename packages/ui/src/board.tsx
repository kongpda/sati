import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
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
  // A drag starts only after the pointer moves, so a plain click still opens the card.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  function onDragEnd(event: DragEndEvent) {
    const over = event.over?.id;
    if (typeof over === "string" && event.active.id !== over) onMove(String(event.active.id), over);
  }
  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="board">
        {COLUMNS.map(([status, label]) => (
          <Column
            key={status}
            status={status}
            label={label}
            show={column === "all" || column === status}
            tasks={tasks.filter((t) => t.status === status)}
            featureName={(id) => (id ? (byFeature.get(id) ?? "") : "")}
            fresh={fresh}
            selected={selected}
            onOpen={onOpen}
            onToggle={onToggle}
            onReviewed={onReviewed}
          />
        ))}
      </div>
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
                <div key={item.key} className="lane" style={style}>
                  {item.title}
                </div>
              );
            }
            return (
              <div key={item.task.id} style={style}>
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
  const { attributes, listeners, setNodeRef } = useDraggable({ id: task.id });
  return (
    <div ref={setNodeRef} className={`card${fresh ? " fresh" : ""}${selected ? " selected" : ""}`}>
      <button
        type="button"
        className="title"
        {...listeners}
        {...attributes}
        onClick={() => onOpen(task.id)}
      >
        {task.title}
      </button>
      <div className="meta">
        <time dateTime={task.updatedAt} title={task.updatedAt}>
          {ago(task.updatedAt)}
        </time>
        {feature ? ` · ${feature}` : ""}
        {task.needsReview ? (
          <button type="button" onClick={() => onReviewed(task.id)}>
            mark reviewed
          </button>
        ) : null}
        <button type="button" aria-pressed={selected} onClick={() => onToggle(task.id)}>
          {selected ? " selected" : " select"}
        </button>
      </div>
    </div>
  );
}

type LaneRow = { kind: "lane"; key: string; title: string } | { kind: "task"; task: Task };

function laneRows(tasks: Task[], featureName: (id: string | null) => string): LaneRow[] {
  const sorted = [...tasks].sort((a, b) =>
    featureName(a.featureId).localeCompare(featureName(b.featureId)),
  );
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
