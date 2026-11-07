import { useEffect, useRef, useState } from "react";
import { ApiError, api, type Snapshot, type Task } from "./api.js";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

/** Comma-separated labels as typed, trimmed and without blanks or repeats. */
export function parseLabels(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * The "New task" dialog. The fields are what a person needs to plan a todo; anything later
 * (claims, completion) happens on the task itself. A refused save keeps the dialog open with
 * the reason, so nothing typed is lost.
 */
export function NewTask({
  data,
  onClose,
  onCreated,
}: {
  data: Snapshot;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const title = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [named, setNamed] = useState(false);

  useEffect(() => {
    const previous = document.activeElement;
    title.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <div className="palette" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
      <button
        type="button"
        className="palette-dismiss"
        aria-label="Close new task"
        tabIndex={-1}
        onClick={onClose}
      />
      <form
        className="new-task"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onClose();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const featureId = String(form.get("featureId") ?? "");
          const input = {
            title: String(form.get("title") ?? "").trim(),
            body: String(form.get("body") ?? ""),
            priority: String(form.get("priority") ?? "medium"),
            status: String(form.get("status") ?? "todo"),
            labels: parseLabels(String(form.get("labels") ?? "")),
            ...(featureId ? { featureId } : {}),
          };
          setSaving(true);
          setError(null);
          void api
            .createTask(input)
            .then(onCreated)
            .catch((err: unknown) => {
              const hint = err instanceof ApiError && err.hint ? ` ${err.hint}` : "";
              setError(err instanceof ApiError ? `${err.message}${hint}` : "That did not save.");
            })
            .finally(() => setSaving(false));
        }}
      >
        <h2 id="new-task-title">New task</h2>
        <label>
          Title
          <input
            ref={title}
            className="field"
            name="title"
            required
            maxLength={300}
            onChange={(e) => setNamed(e.target.value.trim() !== "")}
          />
        </label>
        <label>
          Details
          <textarea className="field" name="body" rows={5} placeholder="Markdown is fine" />
        </label>
        <div className="new-task-row">
          <label>
            Priority
            <select name="priority" defaultValue="medium">
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            List
            <select name="status" defaultValue="todo">
              <option value="todo">Todo</option>
              <option value="backlog">Backlog</option>
            </select>
          </label>
          {data.features.length > 0 ? (
            <label>
              Feature
              <select name="featureId" defaultValue="">
                <option value="">None</option>
                {data.features.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <label>
          Labels
          <input className="field" name="labels" placeholder="design, launch" />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="new-task-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!named || saving}>
            {saving ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>
    </div>
  );
}
