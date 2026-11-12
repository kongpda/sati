import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  type Decision,
  type Milestone,
  type Note,
  type Snapshot,
  type Task,
  type TemplateSummary,
} from "./api.js";
import { Avatar, personName } from "./people.js";
import { COMMENT_TAG } from "./thread.js";
import { capital, plainError, statusWord } from "./words.js";

/** Kept in step with PRIORITIES in core (test/constants.test.ts checks it). */
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

/** Effort options; a light task can go to an agent on a small, cheaper model. */
export function EffortSelect({
  className,
  chosen,
}: {
  className?: string;
  chosen?: string | null;
}) {
  const hint = useId();
  return (
    <>
      <label className={className}>
        Effort
        <select name="effort" defaultValue={chosen ?? "standard"} aria-describedby={hint}>
          <option value="light">Light: quick, simple</option>
          <option value="standard">Standard</option>
          <option value="deep">Deep: needs careful thought</option>
        </select>
      </label>
      {/* Outside the label, so it describes the select without becoming part of its name. */}
      <small id={hint} className="meta effort-hint">
        Light tasks can go to a faster, cheaper agent.
      </small>
    </>
  );
}

/** Where a milestone may go next; mirrors MILESTONE_TRANSITIONS in core, which enforces it. */
export const MILESTONE_NEXT: Record<string, string[]> = {
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
function parseLabels(text: string): string[] {
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
export function FormDialog({
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
  // Once the person types, a stray backdrop click must not throw the text away (review 6.1).
  const dirty = useRef(false);
  const dismiss = (via: "backdrop" | "escape") => {
    if (!dirty.current) onClose();
    else if (via === "escape" && window.confirm("Discard what you typed?")) onClose();
  };
  const onEscape = useRef(dismiss);
  onEscape.current = dismiss;
  // On the window, not the form: after a click on the backdrop the focus is outside the form,
  // and Esc did nothing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape.current("escape");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const previous = document.activeElement;
    const form = formRef.current;
    form?.querySelector<HTMLElement>("input, textarea, select")?.focus();
    if (form) setReady(filled(form));
    // The page behind takes no focus, clicks or screen-reader reading while the dialog is open;
    // aria-modal alone does not stop Tab. The dialog is portalled out of <main> for this.
    const behind = [
      ...document.querySelectorAll<HTMLElement>(".app > nav, .app > main, .app > .sheet"),
    ];
    for (const el of behind) el.inert = true;
    return () => {
      // Back to what the app wants now (`data-modal`, set with its own inert), not to what it
      // was when this opened: New task closes this and clears the app's flag in one render.
      for (const el of behind) el.inert = el.hasAttribute("data-modal");
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return createPortal(
    <div className="palette" role="dialog" aria-modal="true" aria-labelledby={heading}>
      <button
        type="button"
        className="palette-dismiss"
        aria-label={`Close ${title.toLowerCase()}`}
        tabIndex={-1}
        onClick={() => dismiss("backdrop")}
      />
      <form
        ref={formRef}
        className="dialog-form"
        onInput={(e) => {
          dirty.current = true;
          setReady(filled(e.currentTarget));
        }}
        onSubmit={(e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          void onSubmit(new FormData(e.currentTarget))
            .catch((err: unknown) => {
              setError(plainError(err));
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
    </div>,
    document.querySelector(".app") ?? document.body,
  );
}

/** Checkboxes for who should do a task, people first; the reader is marked "(you)". */
export function Assignees({ data, chosen = [] }: { data: Snapshot; chosen?: string[] }) {
  // People are not in the `.sati/` snapshot, so a teammate's clone can name someone this
  // computer has never seen. They stay ticked, or saving any edit would unassign them.
  const elsewhere = chosen.filter((id) => !data.actors.some((a) => a.id === id));
  if (data.actors.length === 0 && elsewhere.length === 0) return null;
  const actors = [...data.actors].sort(
    (a, b) =>
      Number(a.kind !== "human") - Number(b.kind !== "human") ||
      personName(a).localeCompare(personName(b)),
  );
  return (
    <fieldset className="dialog-choices">
      <legend>Assigned to</legend>
      <div className="choices">
        {actors.map((a) => (
          <label key={a.id}>
            <input
              type="checkbox"
              name="assigneeIds"
              value={a.id}
              defaultChecked={chosen.includes(a.id)}
            />
            <Avatar actor={a} />
            {personName(a)}
            {a.id === data.you ? " (you)" : ""}
          </label>
        ))}
        {elsewhere.map((id) => (
          <label key={id}>
            <input type="checkbox" name="assigneeIds" value={id} defaultChecked />
            Someone on another computer
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Asks what still needs doing before work goes back from review. Core refuses the move without a
 * reason, and whoever picks the task up next reads it.
 */
export function SendBack({
  titles,
  onClose,
  onSend,
}: {
  /** The tasks going back. */
  titles: string[];
  onClose: () => void;
  onSend: (reason: string) => Promise<unknown>;
}) {
  const one = titles.length === 1 ? titles[0] : undefined;
  return (
    <FormDialog
      title={one ? `Send back ${one}` : `Send back ${titles.length} tasks`}
      submit="Send back"
      busy="Sending…"
      onClose={onClose}
      onSubmit={(form) => onSend(text(form, "reason").trim())}
    >
      <label>
        What still needs doing
        <input className="field" name="reason" required maxLength={2000} />
      </label>
      <p className="dialog-note">
        Whoever takes {one ? "the task" : "these tasks"} next reads this first.
      </p>
    </FormDialog>
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
        const dueDate = text(form, "dueDate");
        const effort = text(form, "effort");
        const milestoneId = text(form, "milestoneId");
        const assigneeIds = form.getAll("assigneeIds").map(String);
        return api
          .createTask({
            title: text(form, "title").trim(),
            body: text(form, "body"),
            priority: text(form, "priority") || "medium",
            status: text(form, "status") || "todo",
            labels: parseLabels(text(form, "labels")),
            ...(featureId ? { featureId } : {}),
            ...(dueDate ? { dueDate } : {}),
            ...(effort && effort !== "standard" ? { effort } : {}),
            ...(milestoneId ? { milestoneId } : {}),
            ...(assigneeIds.length ? { assigneeIds } : {}),
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
                {capital(p)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select name="status" defaultValue="todo">
            <option value="todo">{statusWord("todo")}</option>
            <option value="backlog">{statusWord("backlog")}</option>
          </select>
        </label>
        <EffortSelect />
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
      <div className="dialog-row">
        <label>
          Due date
          <input className="field" type="date" name="dueDate" />
        </label>
        {data.milestones.length > 0 ? <PlanSelect data={data} chosen={null} /> : null}
        <label>
          Labels
          <input className="field" name="labels" placeholder="design, launch" />
        </label>
      </div>
      <Assignees data={data} />
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
  milestone?: Milestone | undefined;
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
  replaces?: Decision | undefined;
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
          <div className="choices">
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
          </div>
        </fieldset>
      ) : null}
      <p className="dialog-note">
        Decisions are kept as written. To change one later, record a new decision that replaces it.
      </p>
    </FormDialog>
  );
}

/**
 * Edit a note: title, Markdown body, tags and pinned. Like the milestone edit, it sends the
 * version the dialog opened with, so an agent's newer edit is refused instead of overwritten.
 */
export function NoteForm({
  note,
  onClose,
  onSaved,
}: {
  note: Note;
  onClose: () => void;
  onSaved: (note: Note) => void;
}) {
  const [opened] = useState(note);
  return (
    <FormDialog
      title="Edit note"
      submit="Save note"
      busy="Saving…"
      onClose={onClose}
      onSubmit={(form) =>
        api
          .patchNote(opened.id, {
            title: text(form, "title").trim(),
            body: text(form, "body"),
            tags: parseLabels(text(form, "tags")),
            pinned: form.get("pinned") === "on",
            ...(opened.private ? { private: form.get("private") === "on" } : {}),
            expectedVersion: opened.version,
          })
          .then(onSaved)
      }
    >
      <label>
        Title
        <input
          className="field"
          name="title"
          required
          maxLength={300}
          defaultValue={opened.title}
        />
      </label>
      <label>
        Body
        <textarea
          className="field"
          name="body"
          rows={10}
          defaultValue={opened.body}
          placeholder="Markdown is fine"
        />
      </label>
      <label>
        Tags
        <input
          className="field"
          name="tags"
          defaultValue={opened.tags.join(", ")}
          placeholder="launch, venue"
          // Core keeps this tag for comments and refuses it on a note: say so before the save.
          onInput={(e) =>
            e.currentTarget.setCustomValidity(
              parseLabels(e.currentTarget.value).includes(COMMENT_TAG)
                ? `The tag "${COMMENT_TAG}" is kept for comments. Pick another tag.`
                : "",
            )
          }
        />
      </label>
      <label className="dialog-check">
        <input type="checkbox" name="pinned" defaultChecked={opened.pinned} />
        Pin: shown on the board and in every agent's brief
      </label>
      {/* A shared note is in git history already, so only a private one can change here. */}
      {opened.private ? (
        <label className="dialog-check">
          <input type="checkbox" name="private" defaultChecked />
          Keep on this computer only (untick to share it)
        </label>
      ) : null}
    </FormDialog>
  );
}

/** The milestones a task can belong to directly, open ones first; done ones stay pickable. */
export function PlanSelect({
  data,
  chosen,
  className,
}: {
  data: Snapshot;
  chosen: string | null;
  className?: string;
}) {
  const open = data.milestones.filter((m) => m.status !== "done" || m.id === chosen);
  return (
    <label className={className}>
      Plan
      <select name="milestoneId" defaultValue={chosen ?? ""}>
        <option value="">None</option>
        {open.map((m) => (
          <option key={m.id} value={m.id}>
            {m.title}
          </option>
        ))}
      </select>
    </label>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "8 weeks before", "on the day", "3 days after": when a stage is due, from the plan's day. */
function offsetWords(days: number | null): string {
  if (days === null) return "no due date";
  if (days === 0) return "on the day";
  const n = Math.abs(days);
  const [count, unit] = n % 7 === 0 ? [n / 7, "week"] : [n, "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ${days < 0 ? "before" : "after"}`;
}

/**
 * New plan: a template (event, campaign, release, or the project's own) becomes a milestone and
 * its tasks in stages. The same apply as `sati template apply`, so both make the same plan.
 */
export function PlanForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (title: string, tasks: number) => void;
}) {
  const templates = useQuery({ queryKey: ["templates"], queryFn: api.templates });
  const [chosen, setChosen] = useState<string>("");
  const list = templates.data ?? [];
  const current: TemplateSummary | undefined = list.find((t) => t.name === chosen) ?? list[0];
  return (
    <FormDialog
      title="New plan"
      submit="Create plan"
      busy="Creating…"
      onClose={onClose}
      onSubmit={(form) => {
        const template = text(form, "template");
        const title = text(form, "title").trim();
        const targetDate = text(form, "targetDate");
        return api
          .applyTemplate({
            template,
            ...(title ? { title } : {}),
            ...(targetDate ? { targetDate } : {}),
          })
          .then((r) => onSaved(r.milestone.title, r.taskIds.length));
      }}
    >
      <fieldset className="dialog-choices plan-templates">
        <legend>Start from</legend>
        {templates.isPending ? <p className="dialog-note">Loading templates…</p> : null}
        {templates.error ? (
          <p className="form-error" role="alert">
            {plainError(templates.error)}
          </p>
        ) : null}
        {list.map((t) => (
          <label key={t.name} className="plan-template">
            <input
              type="radio"
              name="template"
              value={t.name}
              required
              checked={current?.name === t.name}
              onChange={() => setChosen(t.name)}
            />
            <span>
              <strong>{t.title}</strong>
              <span className="dialog-note">
                {plural(t.tasks, "task")} in {plural(t.stages.length, "stage")}
                {t.source === "built-in" ? "" : ` · ${t.source}`}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {current ? (
        <div className="dialog-note plan-stages">
          {current.goal ? <p>{current.goal}</p> : null}
          <ol>
            {current.stages.map((s) => (
              <li key={s.title}>
                {s.title}: {plural(s.tasks, "task")}, {offsetWords(s.offsetDays)}
              </li>
            ))}
          </ol>
          <p>Each stage starts when the one before is done.</p>
        </div>
      ) : null}
      <label>
        Name
        <input
          className="field"
          name="title"
          maxLength={300}
          placeholder={current ? current.title : "Spring fair"}
        />
      </label>
      <label>
        The day
        <input className="field" type="date" name="targetDate" />
        <span className="dialog-note">Due dates count back from it. Leave empty for none.</span>
      </label>
    </FormDialog>
  );
}
