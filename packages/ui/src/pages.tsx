import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Decision,
  type Milestone,
  type Note,
  type Snapshot,
  type Task,
  waitingOn,
} from "./api.js";
import {
  Assignees,
  DecisionForm,
  EffortSelect,
  MilestoneForm,
  NoteForm,
  PlanForm,
  PlanSelect,
} from "./forms.js";
import { Markdown } from "./markdown.js";
import { Avatar, holderName, nameOf, personName } from "./people.js";
import { isThreadNote, Thread, threadOf } from "./thread.js";
import { Ago } from "./time.js";

/** Adds and deletes comments; the board passes one to every page with a thread. */
interface ThreadActions {
  onAdd: (on: string, body: string) => Promise<unknown>;
  onDelete: (id: string, title: string) => void;
  /** Whether a comment is typed but not sent on record `on`, so leaving can ask first. */
  onDraft?: (typed: boolean, on: string) => void;
}

import { activityWords, capital, dayWords, fullTime, statusWord, untilTime } from "./words.js";

export function Agents({
  data,
  onRelease,
  onReleaseTask,
}: {
  data: Snapshot;
  onRelease: () => void;
  onReleaseTask: (id: string) => void;
}) {
  // Who is working comes first; the idle stay in their usual order below.
  const busy = new Set([
    ...data.tasks.flatMap((t) => (t.claim ? [t.claim.actorId] : [])),
    ...data.locks.map((l) => l.actorId),
  ]);
  const actors = [...data.actors].sort((a, b) => Number(busy.has(b.id)) - Number(busy.has(a.id)));
  return (
    <div className="page">
      <h1>Agents</h1>
      <button type="button" onClick={onRelease}>
        Free up tasks whose time ran out
      </button>
      <div className="list" style={{ marginTop: 12 }}>
        {actors.map((actor) => {
          const tasks = data.tasks.filter((t) => t.claim?.actorId === actor.id);
          const locks = data.locks.filter((l) => l.actorId === actor.id);
          return (
            <article key={actor.id} className="row">
              <strong className="who">
                <Avatar actor={actor} />
                {personName(actor)}
              </strong>
              <div className="meta">
                {actor.kind === "human" ? "Person" : "AI agent"}
                {actor.tool ? ` · ${actor.tool}` : ""}
                {actor.worktree ? ` · ${actor.worktree}` : ""}
              </div>
              {tasks.map((t) => (
                <div key={t.id} className="claim-row">
                  <span>
                    Working on {t.title}
                    {t.claim
                      ? Date.parse(t.claim.leaseUntil) > Date.now()
                        ? ` until ${untilTime(t.claim.leaseUntil)}`
                        : `, time ran out at ${untilTime(t.claim.leaseUntil)}`
                      : ""}
                  </span>
                  <button
                    type="button"
                    aria-label={`Release ${t.title}`}
                    onClick={() => onReleaseTask(t.id)}
                  >
                    Release
                  </button>
                </div>
              ))}
              {locks.map((l) => (
                <div key={l.id} className="meta">
                  {l.mode === "exclusive" ? "Reserved" : "Sharing"} {l.paths.join(", ")} for editing
                  until {untilTime(l.leaseUntil)}
                </div>
              ))}
              {tasks.length === 0 && locks.length === 0 ? <div className="meta">Idle</div> : null}
            </article>
          );
        })}
        {data.actors.length === 0 ? (
          <p className="empty">No agents yet. They appear when one claims a task.</p>
        ) : null}
      </div>
    </div>
  );
}

export function Features({
  data,
  onSavePaths,
  onReviewed,
}: {
  data: Snapshot;
  /** Rejects when the save is refused (the reason is already shown). */
  onSavePaths: (id: string, paths: string, version: number) => Promise<{ paths: string[] }>;
  onReviewed: (id: string, version: number) => void;
}) {
  return (
    <div className="page">
      <h1>Features</h1>
      <div className="list">
        {data.features.map((f) => (
          <article key={f.id} id={f.id} tabIndex={-1} className="row">
            <h2 className="row-title">{f.title}</h2>
            <div className="meta">
              {capital(f.status)}
              {f.protected ? " · protected" : ""}
              {f.matchCount === null ? "" : ` · matches ${f.matchCount} files`}
              {f.needsReview ? (
                <>
                  {" · edited in two places "}
                  <button
                    type="button"
                    aria-label={`${f.title} looks right after the merge`}
                    onClick={() => onReviewed(f.id, f.version)}
                  >
                    Looks right
                  </button>
                </>
              ) : null}
            </div>
            {f.description ? <Markdown source={f.description} /> : null}
            {f.acceptance.length > 0 ? (
              <ul className="acceptance">
                {f.acceptance.map((item, i) => (
                  // Two lines may read the same; the position tells them apart.
                  // biome-ignore lint/suspicious/noArrayIndexKey: plain text lines have no ids
                  <li key={`${i}:${item}`}>{item}</li>
                ))}
              </ul>
            ) : null}
            <PathsForm feature={f} onSave={onSavePaths} />
          </article>
        ))}
        {data.features.length === 0 ? (
          <p className="empty">No features yet. Your agent records one when it builds something.</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A feature's path patterns. The field reloads when they change elsewhere, but never while the
 * person has typed in it: it then says so, and Save sends what they typed.
 */
function PathsForm({
  feature: f,
  onSave,
}: {
  feature: Snapshot["features"][number];
  onSave: (id: string, paths: string, version: number) => Promise<{ paths: string[] }>;
}) {
  const [dirty, setDirty] = useState(false);
  const current = f.paths.join("\n");
  const loaded = useRef({ paths: current, n: 0 });
  if (loaded.current.paths !== current && !dirty) {
    loaded.current = { paths: current, n: loaded.current.n + 1 };
  }
  const changedElsewhere = dirty && loaded.current.paths !== current;
  return (
    <form
      className="paths"
      onInput={() => setDirty(true)}
      onSubmit={(e) => {
        e.preventDefault();
        const input = String(new FormData(e.currentTarget).get("paths") ?? "");
        onSave(f.id, input, f.version).then(
          (saved) => {
            // The saved paths are the baseline before the refetch lands, so they do not show
            // as a change made elsewhere while the field is still dirty.
            const paths = saved.paths.join("\n");
            // Reload the field only when the server tidied what was typed.
            loaded.current = { paths, n: loaded.current.n + (paths === input ? 0 : 1) };
            setDirty(false);
          },
          () => undefined,
        );
      }}
    >
      <label className="meta" htmlFor={`paths-${f.id}`}>
        Files this feature owns, one pattern per line
      </label>
      {changedElsewhere ? (
        <p className="banner" role="status">
          These paths changed while you were editing. Save replaces them with yours;{" "}
          <button type="button" className="link" onClick={() => setDirty(false)}>
            discard yours and reload
          </button>
          .
        </p>
      ) : null}
      <textarea
        key={loaded.current.n}
        id={`paths-${f.id}`}
        className="field"
        name="paths"
        rows={Math.max(2, f.paths.length)}
        defaultValue={loaded.current.paths}
        aria-label={`Paths for ${f.title}, one per line`}
      />
      <button type="submit">Save paths</button>
    </form>
  );
}

export function Roadmap({ data, onSaved }: { data: Snapshot; onSaved: (message: string) => void }) {
  // "new" opens an empty form; a milestone opens it to edit that one.
  const [editing, setEditing] = useState<Milestone | "new" | null>(null);
  const [planning, setPlanning] = useState(false);
  return (
    <div className="page">
      <div className="page-head">
        <h1>Roadmap</h1>
        <div className="page-actions">
          <button type="button" onClick={() => setEditing("new")}>
            New milestone
          </button>
          <button type="button" className="primary" onClick={() => setPlanning(true)}>
            New plan
          </button>
        </div>
      </div>
      <div className="timeline">
        {data.milestones.map((m) => (
          <div key={m.id} className="tick">
            <time dateTime={m.targetDate ?? undefined}>
              {m.targetDate ? dayWords(m.targetDate) : "No date"}
            </time>
            <strong>{m.title}</strong>
          </div>
        ))}
      </div>
      <div className="list">
        {data.milestones.map((m) => {
          const features = data.features.filter((f) => f.milestoneId === m.id);
          const tasks = data.tasks.filter(
            (t) => t.milestoneId === m.id || features.some((f) => f.id === t.featureId),
          );
          const done = tasks.filter((t) => t.status === "done").length;
          return (
            <article key={m.id} className="row">
              <h2 className="row-title">{m.title}</h2>
              <div className="meta">
                {capital(m.status)}
                {m.targetDate ? ` · ${dayWords(m.targetDate)}` : ""}
                {tasks.length ? ` · ${done}/${tasks.length} tasks done` : ""}
                <button type="button" aria-label={`Edit ${m.title}`} onClick={() => setEditing(m)}>
                  Edit
                </button>
              </div>
              {m.goal ? <p>{m.goal}</p> : null}
              {features.length ? (
                <p className="meta">Features: {features.map((f) => f.title).join(", ")}</p>
              ) : null}
            </article>
          );
        })}
        {data.milestones.length === 0 ? (
          <p className="empty">
            No milestones yet. Start one from a template with New plan, add one with New milestone,
            or ask your agent to plan the roadmap.
          </p>
        ) : null}
      </div>
      {planning ? (
        <PlanForm
          onClose={() => setPlanning(false)}
          onSaved={(title, tasks) => {
            setPlanning(false);
            onSaved(`Created ${title} with ${tasks} ${tasks === 1 ? "task" : "tasks"}.`);
          }}
        />
      ) : null}
      {editing ? (
        <MilestoneForm
          milestone={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(m) => {
            setEditing(null);
            onSaved(editing === "new" ? `Created ${m.title}.` : `Saved ${m.title}.`);
          }}
        />
      ) : null}
    </div>
  );
}

export function Notes({
  data,
  onCreate,
  onPatch,
  onSaved,
  onDelete,
  thread,
}: {
  data: Snapshot;
  onCreate: (title: string, body: string, hidden: boolean) => Promise<void>;
  onPatch: (id: string, patch: Record<string, unknown>) => void;
  onSaved: (message: string) => void;
  onDelete: (id: string, title: string) => void;
  thread: ThreadActions;
}) {
  const [editing, setEditing] = useState<Note | null>(null);
  const [tag, setTag] = useState("");
  // Comments and handoffs show under what they are on, not as notes of their own.
  const notes = useMemo(() => data.notes.filter((n) => !isThreadNote(n)), [data.notes]);
  const tags = useMemo(() => [...new Set(notes.flatMap((n) => n.tags))].sort(), [notes]);
  // Who links to each note, built once: asking per row would scan every note for every note.
  const linkedFrom = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const note of notes) {
      for (const link of new Set(note.links)) {
        if (link !== note.id) map.set(link, [...(map.get(link) ?? []), note.title]);
      }
    }
    return map;
  }, [notes]);
  // Pinned notes first; the rest keep the newest-first order the server sends.
  const shown = notes
    .filter((n) => !tag || n.tags.includes(tag))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return (
    <div className="page">
      <h1>Notes</h1>
      <form
        className="list"
        onSubmit={(e) => {
          e.preventDefault();
          const element = e.currentTarget;
          const form = new FormData(element);
          // Keep the draft when the save fails.
          onCreate(
            String(form.get("title") ?? ""),
            String(form.get("body") ?? ""),
            form.get("private") === "on",
          ).then(
            () => element.reset(),
            () => undefined,
          );
        }}
      >
        <input
          className="field"
          name="title"
          required
          placeholder="Note title"
          aria-label="Note title"
        />
        <textarea
          className="field"
          name="body"
          rows={4}
          placeholder="Write in Markdown. Link with [text](https://…)."
          aria-label="Note body"
        />
        <div className="note-actions">
          <label className="dialog-check">
            <input type="checkbox" name="private" />
            Keep on this computer only
          </label>
          <button type="submit">Save note</button>
        </div>
      </form>
      {tags.length > 0 ? (
        <fieldset className="tag-filter">
          <legend className="sr-only">Show notes tagged</legend>
          {["", ...tags].map((t) => (
            <button
              key={t || "all"}
              type="button"
              aria-pressed={tag === t}
              onClick={() => setTag(t)}
            >
              {t || "All"}
            </button>
          ))}
        </fieldset>
      ) : null}
      <div className="list" style={{ marginTop: 16 }}>
        {shown.map((n) => (
          <article key={n.id} id={n.id} tabIndex={-1} className="row">
            <h2 className="row-title">
              {n.pinned ? <span className="badge">Pinned</span> : null}
              {n.private ? <span className="badge private">Private</span> : null}
              {n.title}
            </h2>
            <div className="meta">
              <time dateTime={n.updatedAt} title={fullTime(n.updatedAt)}>
                <Ago iso={n.updatedAt} />
              </time>
              {n.tags.length ? ` · ${n.tags.join(", ")}` : ""}
              {n.needsReview ? (
                <>
                  {" · edited in two places "}
                  <button
                    type="button"
                    aria-label={`${n.title} looks right after the merge`}
                    onClick={() => onPatch(n.id, { reviewed: true, expectedVersion: n.version })}
                  >
                    Looks right
                  </button>
                </>
              ) : null}
              <button type="button" aria-label={`Edit ${n.title}`} onClick={() => setEditing(n)}>
                Edit
              </button>
              <button
                type="button"
                aria-label={`${n.pinned ? "Unpin" : "Pin"} ${n.title}`}
                onClick={() => onPatch(n.id, { pinned: !n.pinned, expectedVersion: n.version })}
              >
                {n.pinned ? "Unpin" : "Pin"}
              </button>
              <button
                type="button"
                aria-label={`Delete ${n.title}`}
                onClick={() => onDelete(n.id, n.title)}
              >
                Delete
              </button>
            </div>
            <Markdown source={n.body} />
            <Backlinks titles={linkedFrom.get(n.id)} />
            {threadOf(n) ? null : <Thread data={data} on={n.id} folded {...thread} />}
          </article>
        ))}
        {notes.length === 0 ? (
          <p className="empty">No notes yet. Write one above, or an agent records one.</p>
        ) : null}
      </div>
      {editing ? (
        <NoteForm
          note={editing}
          onClose={() => setEditing(null)}
          onSaved={(n) => {
            setEditing(null);
            onSaved(`Saved ${n.title}.`);
          }}
        />
      ) : null}
    </div>
  );
}

function Backlinks({ titles }: { titles: string[] | undefined }) {
  if (!titles || titles.length === 0) return null;
  return <div className="meta">Linked from {titles.join(", ")}</div>;
}

export function Decisions({
  data,
  onSaved,
  onDelete,
  thread,
}: {
  data: Snapshot;
  onSaved: (message: string) => void;
  onDelete: (id: string, title: string) => void;
  thread: ThreadActions;
}) {
  // "new" opens an empty form; a decision opens it to record one that replaces it.
  const [recording, setRecording] = useState<Decision | "new" | null>(null);
  const titles = new Map(data.decisions.map((d) => [d.id, d.title]));
  const features = new Map(data.features.map((f) => [f.id, f.title]));
  const replacedBy = new Map(
    data.decisions.flatMap((d) => (d.supersedes ? [[d.supersedes, d.title] as const] : [])),
  );
  return (
    <div className="page">
      <div className="page-head">
        <h1>Decisions</h1>
        <button type="button" className="primary" onClick={() => setRecording("new")}>
          Record decision
        </button>
      </div>
      <div className="list">
        {data.decisions.map((d) => (
          <article
            key={d.id}
            id={d.id}
            tabIndex={-1}
            className={replacedBy.has(d.id) ? "row replaced" : "row"}
          >
            <h2 className="row-title">{d.title}</h2>
            <div className="meta">
              <time dateTime={d.createdAt} title={fullTime(d.createdAt)}>
                <Ago iso={d.createdAt} />
              </time>
              {d.supersedes ? ` · replaces ${titles.get(d.supersedes) ?? d.supersedes}` : ""}
              {replacedBy.has(d.id) ? ` · replaced by ${replacedBy.get(d.id)}` : ""}
              {d.featureIds.length
                ? ` · ${d.featureIds.flatMap((id) => features.get(id) ?? []).join(", ")}`
                : ""}
              {/* A replaced decision is history: only the current one can be replaced again. */}
              {replacedBy.has(d.id) ? null : (
                <button
                  type="button"
                  aria-label={`Replace ${d.title}`}
                  onClick={() => setRecording(d)}
                >
                  Replace
                </button>
              )}
              <button
                type="button"
                aria-label={`Delete ${d.title}`}
                onClick={() => onDelete(d.id, d.title)}
              >
                Delete
              </button>
            </div>
            <Markdown source={d.decision} />
            {d.context ? (
              <>
                <h3 className="row-sub">Context</h3>
                <Markdown source={d.context} />
              </>
            ) : null}
            {d.consequences ? (
              <>
                <h3 className="row-sub">Consequences</h3>
                <Markdown source={d.consequences} />
              </>
            ) : null}
            <Thread data={data} on={d.id} folded {...thread} />
          </article>
        ))}
        {data.decisions.length === 0 ? (
          <p className="empty">
            No decisions yet. Record one when you choose between options, so people and agents know
            why.
          </p>
        ) : null}
      </div>
      {recording ? (
        <DecisionForm
          data={data}
          replaces={recording === "new" ? undefined : recording}
          onClose={() => setRecording(null)}
          onSaved={(d) => {
            setRecording(null);
            onSaved(`Recorded ${d.title}.`);
          }}
        />
      ) : null}
    </div>
  );
}

export function Activity({ data }: { data: Snapshot }) {
  // Name the record each row touched when it is still on screen elsewhere in the snapshot.
  const titles = new Map<string, string>([
    ...data.tasks.map((t) => [t.id, t.title] as const),
    ...data.features.map((f) => [f.id, f.title] as const),
    ...data.notes.map((n) => [n.id, n.title] as const),
    ...data.decisions.map((d) => [d.id, d.title] as const),
    ...data.milestones.map((m) => [m.id, m.title] as const),
  ]);
  const notes = new Map(data.notes.map((n) => [n.id, n]));
  return (
    // Rows have no controls, so the scrolling page itself takes focus (WCAG scrollable region).
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-reachable
    <section className="page" tabIndex={0} aria-labelledby="activity-title">
      <h1 id="activity-title">Activity</h1>
      <div className="list">
        {data.activity.map((row) => {
          // A new comment reads "commented on <the task>", not "added the note Comment on …".
          const note = row.entity === "note" ? notes.get(row.entityId) : undefined;
          const on = note && row.verb === "create" ? threadOf(note) : undefined;
          const handoff = note?.tags.includes("handoff");
          const subject = titles.get(on ?? row.entityId);
          return (
            <article key={row.id} className="row">
              <strong>{nameOf(data, row.actorId)}</strong>{" "}
              {on
                ? handoff
                  ? "left a handoff on"
                  : "commented on"
                : activityWords(row.verb, row.entity, row.diff)}
              {subject ? <span className="subject"> {subject}</span> : null}
              <div className="meta">
                <time dateTime={row.at} title={fullTime(row.at)}>
                  <Ago iso={row.at} />
                </time>
                {row.branch ? ` · ${row.branch}` : ""}
              </div>
            </article>
          );
        })}
        {data.activity.length === 0 ? (
          <p className="empty">No activity yet. Changes appear here as they happen.</p>
        ) : null}
      </div>
    </section>
  );
}

/** The effort select's value: standard is the default, stored as unset. */
const effortValue = (v: FormDataEntryValue | null) => (v === "light" || v === "deep" ? v : null);

/** The task fields the panel's form edits; the form reloads when one of them changes. */
const fieldsOf = (t: Task | undefined) =>
  JSON.stringify([
    t?.id,
    t?.title,
    t?.body,
    t?.status,
    t?.dueDate ?? null,
    t?.effort ?? null,
    t?.milestoneId ?? null,
    t?.assigneeIds ?? [],
  ]);

/** The same fields as the form reads them, to compare what was typed with a task. */
const valuesOf = (t: Task) => ({
  title: t.title,
  body: t.body,
  status: t.status,
  dueDate: t.dueDate ?? null,
  effort: effortValue(t.effort ?? null),
  milestoneId: t.milestoneId ?? null,
  assigneeIds: t.assigneeIds ?? [],
});

const EDITABLE = ["backlog", "todo", "in_progress", "review", "blocked", "cancelled"];

/** A person approves work in review by moving it to done; done is otherwise read-only here. */
function statusOptions(status: string): string[] {
  if (status === "review") return [...EDITABLE, "done"];
  return EDITABLE.includes(status) ? EDITABLE : [status, ...EDITABLE];
}

/** Keep this keyed by task id: it moves focus into the dialog on open and back on close. */
export function TaskSheet({
  data,
  id,
  modal,
  inert,
  onDirty,
  onClose,
  onSave,
  onRelease,
  onTakeOver,
  onDelete,
  onToast,
  thread,
}: {
  data: Snapshot;
  id: string;
  /** False on a wide screen, where the panel sits beside a board that stays usable. */
  modal: boolean;
  /** True while a dialog (search, a form) is open over the panel: it then takes no focus. */
  inert: boolean;
  /** Tells the app whether there are unsaved edits, so leaving can ask first. */
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
  /** Resolves with the saved task; rejects when the save is refused (the reason is already shown). */
  onSave: (id: string, patch: Record<string, unknown>) => Promise<Task>;
  onRelease: (id: string, force: boolean) => void;
  onTakeOver: (id: string) => void;
  onDelete: (id: string, title: string) => void;
  /** Shows a short message, with an Undo button when `undo` is given. */
  onToast: (message: string, undo?: () => void) => void;
  thread: ThreadActions;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const task = data.tasks.find((t) => t.id === id);
  const found = task !== undefined;
  useEffect(() => {
    if (!found) return;
    const previous = document.activeElement;
    heading.current?.focus();
    return () => {
      // After the panel closes, so the board is no longer inert: back to what had focus, or,
      // when that was the body (j/k stepped here) or is gone, to this task's card.
      requestAnimationFrame(() => {
        if (document.querySelector(".sheet")) return; // another task's panel opened instead
        const card = document.querySelector<HTMLElement>(`button[data-task="${id}"]`);
        const back =
          previous instanceof HTMLElement && previous.isConnected && previous !== document.body
            ? previous
            : card;
        back?.focus();
      });
    };
  }, [found, id]);
  // The form reloads only when a field it edits changes, and never while the person is typing
  // in it: an agent's write would otherwise throw their edit away. It then says the task
  // changed, and Save sends only the fields the person changed since the form loaded.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // The body shows rendered until the person chooses to edit it (owner decision, review 6.2).
  const [editingBody, setEditingBody] = useState(false);
  const bodyField = useRef<HTMLTextAreaElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  // Save is disabled while saving, so focus goes back to it only once it is enabled again.
  const refocus = useRef(false);
  useEffect(() => {
    if (saving || !refocus.current) return;
    refocus.current = false;
    saveButton.current?.focus();
  }, [saving]);
  const fields = fieldsOf(task);
  const formKey = useRef({ fields, n: 0, base: task });
  // After a save the snapshot still holds the older task until the refetch lands; reloading
  // from it would flash the old values back and drop focus from Save.
  const older = task !== undefined && task.version < (formKey.current.base?.version ?? 0);
  if (formKey.current.fields !== fields && !dirty && !older) {
    formKey.current = { fields, n: formKey.current.n + 1, base: task };
  }
  const changedElsewhere = dirty && formKey.current.fields !== fields;
  // Typing in the comment box or the new-step box is unsaved work too.
  const [commentDraft, setCommentDraft] = useState(false);
  const [stepDraft, setStepDraft] = useState(false);
  // A task deleted elsewhere takes its unsaved edits with it: nothing is left to ask about.
  const anyDirty = found && (dirty || commentDraft || stepDraft);
  useEffect(() => onDirty(anyDirty), [anyDirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  if (!task) {
    return (
      <aside
        className="sheet"
        role="dialog"
        aria-modal={modal ? "true" : "false"}
        aria-label="Task deleted"
        inert={inert}
      >
        <p role="status">This task was deleted.</p>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </aside>
    );
  }
  const base = formKey.current.base ?? task;
  const feature = data.features.find((f) => f.id === task.featureId);
  // Someone else's live claim is ended with Take over or Release first, not deleted under them.
  const held =
    task.claim !== null &&
    task.claim.actorId !== data.you &&
    Date.parse(task.claim.leaseUntil) > Date.now();
  return (
    <aside
      className="sheet"
      role="dialog"
      aria-modal={modal ? "true" : "false"}
      aria-labelledby="sheet-title"
      inert={inert}
      data-modal={inert ? "" : undefined}
    >
      <button type="button" onClick={onClose}>
        Close
      </button>
      <h2 id="sheet-title" ref={heading} tabIndex={-1}>
        {task.title}
      </h2>
      <p className="meta sheet-meta">
        {capital(task.priority)} priority{feature ? ` · ${feature.title}` : ""}
        {(task.labels ?? []).map((l) => (
          <span key={l} className="badge">
            {l}
          </span>
        ))}
      </p>
      {task.completion?.summary ? (
        <section className="done-summary" aria-label="What was done">
          <h3>What was done</h3>
          <Markdown source={task.completion.summary} />
        </section>
      ) : null}
      {task.claim ? (
        <ClaimBox
          data={data}
          claim={task.claim}
          onRelease={(force) => onRelease(task.id, force)}
          onTakeOver={() => onTakeOver(task.id)}
        />
      ) : null}
      <TaskSignals data={data} task={task} />
      {changedElsewhere ? (
        <p className="banner" role="status">
          This task changed while you were editing. Save keeps your changes to the fields you
          edited;{" "}
          <button type="button" className="link" onClick={() => setDirty(false)}>
            discard yours and reload
          </button>
          .
        </p>
      ) : null}
      <form
        key={formKey.current.n}
        onInput={() => setDirty(true)}
        onSubmit={(e) => {
          e.preventDefault();
          if (saving) return;
          const form = new FormData(e.currentTarget);
          const sameList = (a: readonly string[], b: readonly string[]) =>
            a.length === b.length && a.every((x) => b.includes(x));
          const typed = {
            title: String(form.get("title") ?? ""),
            // The body field is there only while it is being edited.
            body: form.has("body") ? String(form.get("body")) : base.body,
            status: String(form.get("status") ?? base.status),
            dueDate: String(form.get("dueDate") ?? "") || null,
            effort: effortValue(form.get("effort")),
            milestoneId: form.has("milestoneId")
              ? String(form.get("milestoneId")) || null
              : (base.milestoneId ?? null),
            assigneeIds: form.getAll("assigneeIds").map(String),
          };
          const was = valuesOf(base);
          const now = valuesOf(task);
          const same = (a: unknown, b: unknown) =>
            Array.isArray(a) && Array.isArray(b) ? sameList(a, b) : a === b;
          // Only what the person changed since the form loaded: a field an agent changed
          // meanwhile keeps the agent's value, and old tasks keep their shape.
          const patch: Record<string, unknown> = {};
          let clash = false;
          for (const key of Object.keys(typed) as (keyof typeof typed)[]) {
            const mine = typed[key];
            if (same(mine, was[key])) continue;
            patch[key] = mine;
            if (!same(was[key], now[key])) clash = true;
          }
          if (Object.keys(patch).length === 0) {
            setDirty(false);
            return;
          }
          setSaving(true);
          // Both changed the same field: the version the form loaded makes the server refuse
          // it, so neither edit is lost without a word.
          void onSave(task.id, { ...patch, expectedVersion: clash ? base.version : task.version })
            .then((saved) => {
              // The saved task is the new baseline before the refetch lands, so it does not
              // look like a change made elsewhere. The form reloads only when it shows a
              // field that differs from what was saved (another writer's change).
              const after = valuesOf(saved);
              const stale = (Object.keys(typed) as (keyof typeof typed)[]).some(
                (key) => !same(typed[key], after[key]),
              );
              formKey.current = {
                fields: fieldsOf(saved),
                n: formKey.current.n + (stale ? 1 : 0),
                base: saved,
              };
              setDirty(false);
              setEditingBody(false);
              onToast("Saved");
              refocus.current = true;
            })
            .catch(() => undefined)
            .finally(() => setSaving(false));
        }}
      >
        <input className="field" name="title" defaultValue={task.title} aria-label="Title" />
        <div className="sheet-details">
          <h3>Details</h3>
          {editingBody || !task.body.trim() ? (
            <textarea
              ref={bodyField}
              className="field"
              name="body"
              rows={8}
              defaultValue={task.body}
              aria-label="Body"
            />
          ) : (
            <>
              <Markdown source={task.body} />
              <button
                type="button"
                onClick={() => {
                  setEditingBody(true);
                  requestAnimationFrame(() => bodyField.current?.focus());
                }}
              >
                Edit details
              </button>
            </>
          )}
        </div>
        <label className="sheet-label">
          Due date
          <input className="field" type="date" name="dueDate" defaultValue={task.dueDate ?? ""} />
        </label>
        <EffortSelect className="sheet-label" chosen={task.effort ?? null} />
        {data.milestones.length > 0 ? (
          <PlanSelect className="sheet-label" data={data} chosen={task.milestoneId ?? null} />
        ) : null}
        <Assignees data={data} chosen={task.assigneeIds ?? []} />
        <label className="sheet-label sheet-status">
          Status
          <select name="status" defaultValue={task.status}>
            {statusOptions(task.status).map((s) => (
              <option key={s} value={s}>
                {statusWord(s)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary" disabled={saving} ref={saveButton}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
      <Checklist
        version={task.version}
        items={task.checklist ?? []}
        onChange={(checklist, expectedVersion) => onSave(task.id, { checklist, expectedVersion })}
        onDraft={setStepDraft}
        onRemoved={(text, undo) => onToast(`Removed the step ${text}.`, undo)}
      />
      {feature && feature.acceptance.length > 0 ? (
        <>
          <h3>Acceptance</h3>
          <ul>
            {feature.acceptance.map((item, i) => (
              // Two lines may read the same; the position tells them apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: plain text lines have no ids
              <li key={`${i}:${item}`}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      <Thread data={data} on={task.id} {...thread} onDraft={setCommentDraft} />
      {held ? null : (
        <button
          type="button"
          className="danger sheet-delete"
          onClick={() => onDelete(task.id, task.title)}
        >
          Delete task
        </button>
      )}
    </aside>
  );
}

/**
 * What the task waits on and what came with it: the agent's question, why it is blocked, the
 * handoff left on it, and whether its branch moved after it was sent for approval. Agent text
 * is rendered as plain text, never as Markdown, because it is data.
 */
/** An actor's name; actors are machine-local, so a record from a teammate's clone carries a fallback. */
const nameOr = (data: Snapshot, id: string, fallback: string | undefined) =>
  data.actors.some((a) => a.id === id) ? nameOf(data, id) : (fallback ?? "someone");

function TaskSignals({ data, task }: { data: Snapshot; task: Task }) {
  const waiting = waitingOn(task);
  const who = holderName(data, task.claim?.actorId);
  const handoff = data.notes.find((n) => n.tags.includes("handoff") && n.links.includes(task.id));
  const drift = data.drift?.[task.id];
  if (!waiting && !(task.status === "blocked") && !handoff && !drift?.moved) return null;
  return (
    <section className="signals" aria-label="What this task waits on">
      {waiting ? (
        <p className="asking">
          <strong>
            {waiting.kind === "permission" ? `${who} needs your permission` : `${who} asks`}
          </strong>
          <span className="quote">{waiting.text}</span>
        </p>
      ) : null}
      {task.status === "blocked" ? (
        <p className="asking">
          <strong>Blocked</strong>
          <span className="quote">{task.blockedReason || "No reason given."}</span>
        </p>
      ) : null}
      {drift?.moved ? (
        <p className="drift" role="note">
          {drift.branch} has new commits since this was sent ({drift.commit.slice(0, 7)} →{" "}
          {drift.head?.slice(0, 7)}).
        </p>
      ) : null}
      {handoff ? (
        <p className="handoff">
          <strong>
            Handoff from {nameOr(data, handoff.createdBy, handoff.handoffFromName)}
            {handoff.handoffTo
              ? ` for ${nameOr(data, handoff.handoffTo, handoff.handoffToName)}`
              : ""}
          </strong>
          <span className="meta">
            {handoff.acknowledged ? (
              <>
                {` · read by ${nameOf(data, handoff.acknowledged.by)} `}
                <Ago iso={handoff.acknowledged.at} />
              </>
            ) : (
              " · not read yet"
            )}
          </span>
        </p>
      ) : null}
    </section>
  );
}

/**
 * The task's steps. Each tick, add or remove saves at once with the task's version, so a step an
 * agent ticked meanwhile is refused instead of unticked.
 */
function Checklist({
  version,
  items,
  onChange,
  onDraft,
  onRemoved,
}: {
  version: number;
  items: { text: string; done: boolean }[];
  onChange: (
    items: { text: string; done: boolean }[],
    expectedVersion: number,
  ) => Promise<{ version: number }>;
  /** Whether a step is typed but not added, so leaving can ask first. */
  onDraft: (typed: boolean) => void;
  /** A step was removed; `undo` puts it back where it was. */
  onRemoved: (text: string, undo: () => void) => void;
}) {
  // Shown at once; a refused save puts back what the server has. A new version (a save from
  // here or anywhere) resets it to the server's list without remounting, so focus stays put.
  const [shown, setShown] = useState(items);
  // Saves waiting or running: the list on screen is ahead of the server's, so a version that
  // arrives meanwhile must not reset it (the ticks would flicker back, then forward).
  const pending = useRef(0);
  const [settled, setSettled] = useState(0);
  // Quick ticks run one after another, each with the version the last save returned; sent
  // together, the second would carry a stale version and be refused.
  const latest = useRef(version);
  // biome-ignore lint/correctness/useExhaustiveDependencies: items is new on every snapshot; the version says when it changed
  useEffect(() => {
    // A save that just settled can come before the snapshot it made: the old list would bring
    // a removed step back for a moment, and Undo would then add it a second time.
    if (pending.current === 0 && version >= latest.current) setShown(items);
  }, [version, settled]);
  // The list as last saved: a refused tick goes back to it, not to the list of the render it
  // was clicked in, which misses ticks saved since.
  const saved = useRef(items);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // biome-ignore lint/correctness/useExhaustiveDependencies: items is new on every snapshot; the version says when it changed
  useEffect(() => {
    latest.current = Math.max(latest.current, version);
    saved.current = items;
  }, [version]);
  const change = (next: typeof items) => {
    setShown(next);
    pending.current++;
    queue.current = queue.current.then(() =>
      onChange(next, latest.current)
        .then(
          (result) => {
            latest.current = result.version;
            saved.current = next;
          },
          () => setShown(saved.current),
        )
        .finally(() => {
          pending.current--;
          // Take the server's list once the last save is in, for what arrived meanwhile.
          if (pending.current === 0) setSettled((n) => n + 1);
        }),
    );
  };
  // Undo runs after later renders, so it needs the list on screen then, not at the removal.
  const current = useRef(shown);
  current.current = shown;
  const done = shown.filter((c) => c.done).length;
  return (
    <section className="checklist" aria-labelledby="checklist-title">
      <h3 id="checklist-title">Checklist{shown.length ? ` · ${done}/${shown.length}` : ""}</h3>
      <ul>
        {shown.map((c, i) => (
          // Steps have no ids; the position is what a person and the CLI refer to.
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are addressed by position
          <li key={i}>
            <label>
              <input
                type="checkbox"
                checked={c.done}
                onChange={() =>
                  change(shown.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))
                }
              />
              <span className={c.done ? "done" : undefined}>{c.text}</span>
            </label>
            <button
              type="button"
              aria-label={`Remove step ${c.text}`}
              onClick={() => {
                change(shown.filter((_, j) => j !== i));
                onRemoved(c.text, () => {
                  const list = current.current;
                  change([...list.slice(0, i), c, ...list.slice(i)]);
                });
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="checklist-add"
        onInput={(e) => {
          const step = e.currentTarget.elements.namedItem("step");
          onDraft(step instanceof HTMLInputElement && step.value.trim() !== "");
        }}
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("step");
          if (!(input instanceof HTMLInputElement) || input.value.trim() === "") return;
          change([...shown, { text: input.value.trim(), done: false }]);
          input.value = "";
          onDraft(false);
        }}
      >
        <input
          className="field"
          name="step"
          maxLength={300}
          aria-label="New step"
          placeholder="Add a step"
        />
        <button type="submit">Add</button>
      </form>
    </section>
  );
}

/**
 * Who is working on the task, in plain words, with the way out: the holder releases it; anyone
 * else may take it over or release it, which ends the holder's claim, so it asks first.
 */
function ClaimBox({
  data,
  claim,
  onRelease,
  onTakeOver,
}: {
  data: Snapshot;
  claim: { actorId: string; leaseUntil: string };
  onRelease: (force: boolean) => void;
  onTakeOver: () => void;
}) {
  const mine = claim.actorId === data.you;
  const name = holderName(data, claim.actorId);
  const live = Date.parse(claim.leaseUntil) > Date.now();
  const until = (
    <time dateTime={claim.leaseUntil} title={fullTime(claim.leaseUntil)}>
      {untilTime(claim.leaseUntil)}
    </time>
  );
  const confirmed = (action: string) =>
    !live ||
    window.confirm(
      `${action} from ${name}? They stop working on it, and their next save will be refused.`,
    );
  return (
    <section className="claim" aria-label="Who is working on this">
      <p>
        {live ? `${mine ? "You are" : `${name} is`} working on this until ` : ""}
        {live ? null : `${mine ? "Your" : `${name}'s`} time on this ran out at `}
        {until}.
      </p>
      <div className="claim-actions">
        {mine ? null : (
          <button type="button" onClick={() => confirmed("Take this over") && onTakeOver()}>
            Take over
          </button>
        )}
        <button
          type="button"
          onClick={() => (mine || confirmed("Release this")) && onRelease(!mine)}
        >
          Release
        </button>
      </div>
    </section>
  );
}
