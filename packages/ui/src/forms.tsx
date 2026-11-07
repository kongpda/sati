import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ApiError, api, type Decision, type Milestone, type Snapshot, type Task } from "./api.js";

const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

/** Where a milestone may go next; mirrors MILESTONE_TRANSITIONS in core, which enforces it. */
const MILESTONE_NEXT: Record<string, string[]> = {
  planned: ["active"],
  active: ["planned", "done"],
  done: ["active"],
};
const MILESTONE_LABELS: Record<string, string> = {
  planned: "Planned",
  active: "Active",
  done: "Done",
};

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

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

/** True when every required text field holds more than spaces. */
function filled(form: HTMLFormElement): boolean {
  return Array.from(form.elements).every(
    (el) =>
      !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ||
      !el.required ||
      el.value.trim() !== "",
  );
}

/**
 * The shell every create and edit dialog shares: it focuses the first field, closes on Esc or
 * Cancel, keeps the submit button off until the required fields are filled, and shows a refused
 * save inside the dialog so nothing typed is lost. The caller closes it when the save succeeds.
 */
function FormDialog({
  title,
  submit,
  busy,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  submit: string;
  busy: string;
  onClose: () => void;
  onSubmit: (form: FormData) => Promise<unknown>;
  children: ReactNode;
}) {
  const heading = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const previous = document.activeElement;
    const form = formRef.current;
    form?.querySelector<HTMLElement>("input, textarea, select")?.focus();
    if (form) setReady(filled(form));
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <div className="palette" role="dialog" aria-modal="true" aria-labelledby={heading}>
      <button
        type="button"
        className="palette-dismiss"
        aria-label={`Close ${title.toLowerCase()}`}
        tabIndex={-1}
        onClick={onClose}
      />
      <form
        ref={formRef}
        className="dialog-form"
        onInput={(e) => setReady(filled(e.currentTarget))}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onClose();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          void onSubmit(new FormData(e.currentTarget))
            .catch((err: unknown) => {
              const hint = err instanceof ApiError && err.hint ? ` ${err.hint}` : "";
              setError(err instanceof ApiError ? `${err.message}${hint}` : "That did not save.");
            })
            .finally(() => setSaving(false));
        }}
      >
        <h2 id={heading}>{title}</h2>
        {children}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!ready || saving}>
            {saving ? busy : submit}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The "New task" dialog: what a person needs to plan a todo. Claims and completion come later. */
export function NewTask({
  data,
  onClose,
  onCreated,
}: {
  data: Snapshot;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  return (
    <FormDialog
      title="New task"
      submit="Create task"
      busy="Creating…"
      onClose={onClose}
      onSubmit={(form) => {
        const featureId = text(form, "featureId");
        return api
          .createTask({
            title: text(form, "title").trim(),
            body: text(form, "body"),
            priority: text(form, "priority") || "medium",
            status: text(form, "status") || "todo",
            labels: parseLabels(text(form, "labels")),
            ...(featureId ? { featureId } : {}),
          })
          .then(onCreated);
      }}
    >
      <label>
        Title
        <input className="field" name="title" required maxLength={300} />
      </label>
      <label>
        Details
        <textarea className="field" name="body" rows={5} placeholder="Markdown is fine" />
      </label>
      <div className="dialog-row">
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
    </FormDialog>
  );
}

/**
 * Create a milestone, or edit one when `milestone` is given. The edit sends the version the
 * dialog opened with, so a change someone saved meanwhile is refused instead of overwritten.
 */
export function MilestoneForm({
  milestone,
  onClose,
  onSaved,
}: {
  milestone?: Milestone;
  onClose: () => void;
  onSaved: (milestone: Milestone) => void;
}) {
  // Freeze what the dialog opened with; live updates must not move the version under the edit.
  const [opened] = useState(milestone);
  const statuses = opened
    ? [opened.status, ...(MILESTONE_NEXT[opened.status] ?? [])]
    : ["planned", "active"];
  return (
    <FormDialog
      title={opened ? "Edit milestone" : "New milestone"}
      submit={opened ? "Save milestone" : "Create milestone"}
      busy="Saving…"
      onClose={onClose}
      onSubmit={(form) => {
        const status = text(form, "status");
        const fields = {
          title: text(form, "title").trim(),
          goal: text(form, "goal"),
          targetDate: text(form, "targetDate") || null,
        };
        const saved = opened
          ? api.patchMilestone(opened.id, {
              ...fields,
              ...(status !== opened.status ? { status } : {}),
              expectedVersion: opened.version,
            })
          : api.createMilestone({ ...fields, status });
        return saved.then(onSaved);
      }}
    >
      <label>
        Name
        <input
          className="field"
          name="title"
          required
          maxLength={300}
          defaultValue={opened?.title}
          placeholder="Launch event"
        />
      </label>
      <label>
        Goal
        <textarea
          className="field"
          name="goal"
          rows={3}
          maxLength={2000}
          defaultValue={opened?.goal}
          placeholder="What done looks like"
        />
      </label>
      <div className="dialog-row">
        <label>
          Target date
          <input
            className="field"
            type="date"
            name="targetDate"
            defaultValue={opened?.targetDate ?? ""}
          />
        </label>
        <label>
          Status
          <select name="status" defaultValue={statuses[0]}>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {MILESTONE_LABELS[s] ?? s}
              </option>
            ))}
          </select>
        </label>
      </div>
    </FormDialog>
  );
}

/**
 * Record a decision. Decisions are kept as written, so changing one means recording a new one
 * that replaces it; `replaces` preselects that.
 */
export function DecisionForm({
  data,
  replaces,
  onClose,
  onSaved,
}: {
  data: Snapshot;
  replaces?: Decision;
  onClose: () => void;
  onSaved: (decision: Decision) => void;
}) {
  return (
    <FormDialog
      title={replaces ? "Replace decision" : "Record decision"}
      submit="Record decision"
      busy="Recording…"
      onClose={onClose}
      onSubmit={(form) => {
        const supersedes = text(form, "supersedes");
        return api
          .recordDecision({
            title: text(form, "title").trim(),
            decision: text(form, "decision"),
            context: text(form, "context"),
            consequences: text(form, "consequences"),
            featureIds: form.getAll("featureIds").map(String),
            ...(supersedes ? { supersedes } : {}),
          })
          .then(onSaved);
      }}
    >
      <label>
        Title
        <input
          className="field"
          name="title"
          required
          maxLength={300}
          placeholder="Hold the launch at the riverside venue"
        />
      </label>
      <label>
        Decision
        <textarea
          className="field"
          name="decision"
          required
          rows={3}
          placeholder="What was decided"
        />
      </label>
      <label>
        Context
        <textarea
          className="field"
          name="context"
          rows={3}
          placeholder="Why: the problem and the options weighed"
        />
      </label>
      <label>
        Consequences
        <textarea
          className="field"
          name="consequences"
          rows={2}
          placeholder="What follows from it"
        />
      </label>
      {data.decisions.length > 0 ? (
        <label>
          Replaces
          <select name="supersedes" defaultValue={replaces?.id ?? ""}>
            <option value="">Nothing</option>
            {data.decisions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {data.features.length > 0 ? (
        <fieldset className="dialog-choices">
          <legend>Features it affects</legend>
          {data.features.map((f) => (
            <label key={f.id}>
              <input
                type="checkbox"
                name="featureIds"
                value={f.id}
                defaultChecked={replaces?.featureIds.includes(f.id)}
              />
              {f.title}
            </label>
          ))}
        </fieldset>
      ) : null}
      <p className="dialog-note">
        Decisions are kept as written. To change one later, record a new decision that replaces it.
      </p>
    </FormDialog>
  );
}
