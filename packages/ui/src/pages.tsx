import { useEffect, useRef, useState } from "react";
import { ago, type Decision, type Milestone, type Note, type Snapshot } from "./api.js";
import { Assignees, DecisionForm, MilestoneForm, NoteForm, PlanSelect } from "./forms.js";
import { Markdown } from "./markdown.js";
import { Avatar, nameOf, personName } from "./people.js";
import { activityWords, dayWords, fullTime, statusWord, untilTime } from "./words.js";

export function Agents({
  data,
  onRelease,
  onReleaseTask,
}: {
  data: Snapshot;
  onRelease: () => void;
  onReleaseTask: (id: string) => void;
}) {
  return (
    <div className="page">
      <h1>Agents</h1>
      <button type="button" onClick={onRelease}>
        Free up tasks whose time ran out
      </button>
      <div className="list" style={{ marginTop: 12 }}>
        {data.actors.map((actor) => {
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
  onSavePaths: (id: string, paths: string, version: number) => void;
  onReviewed: (id: string, version: number) => void;
}) {
  return (
    <div className="page">
      <h1>Features</h1>
      <div className="list">
        {data.features.map((f) => (
          <article key={f.id} className="row">
            <h2 className="row-title">{f.title}</h2>
            <div className="meta">
              {f.status}
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
            {f.acceptance.length > 0 ? (
              <ul className="acceptance">
                {f.acceptance.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            <form
              className="paths"
              onSubmit={(e) => {
                e.preventDefault();
                const input = new FormData(e.currentTarget).get("paths");
                onSavePaths(f.id, String(input ?? ""), f.version);
              }}
            >
              <textarea
                className="field"
                name="paths"
                rows={Math.max(2, f.paths.length)}
                defaultValue={f.paths.join("\n")}
                aria-label={`Paths for ${f.title}, one per line`}
              />
              <button type="submit">Save paths</button>
            </form>
          </article>
        ))}
        {data.features.length === 0 ? (
          <p className="empty">No features yet. An agent records one with feature_upsert.</p>
        ) : null}
      </div>
    </div>
  );
}

export function Roadmap({ data, onSaved }: { data: Snapshot; onSaved: (message: string) => void }) {
  // "new" opens an empty form; a milestone opens it to edit that one.
  const [editing, setEditing] = useState<Milestone | "new" | null>(null);
  return (
    <div className="page">
      <div className="page-head">
        <h1>Roadmap</h1>
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          New milestone
        </button>
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
                {m.status}
                {m.targetDate ? ` · ${dayWords(m.targetDate)}` : ""}
                {tasks.length ? ` · ${done}/${tasks.length} tasks done` : ""}
                <button type="button" aria-label={`Edit ${m.title}`} onClick={() => setEditing(m)}>
                  Edit
                </button>
              </div>
              {m.goal ? <p>{m.goal}</p> : null}
              {features.map((f) => (
                <div key={f.id}>{f.title}</div>
              ))}
            </article>
          );
        })}
        {data.milestones.length === 0 ? (
          <p className="empty">
            No milestones yet. Add one with New milestone, or ask your agent to plan the roadmap.
          </p>
        ) : null}
      </div>
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
}: {
  data: Snapshot;
  onCreate: (title: string, body: string) => Promise<void>;
  onPatch: (id: string, patch: Record<string, unknown>) => void;
  onSaved: (message: string) => void;
  onDelete: (id: string, title: string) => void;
}) {
  const [editing, setEditing] = useState<Note | null>(null);
  const [tag, setTag] = useState("");
  const tags = [...new Set(data.notes.flatMap((n) => n.tags))].sort();
  // Pinned notes first; the rest keep the newest-first order the server sends.
  const shown = data.notes
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
          onCreate(String(form.get("title") ?? ""), String(form.get("body") ?? "")).then(
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
        <button type="submit">Save note</button>
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
          <article key={n.id} className="row">
            <h2 className="row-title">
              {n.pinned ? <span className="badge">Pinned</span> : null}
              {n.title}
            </h2>
            <div className="meta">
              <time dateTime={n.updatedAt} title={fullTime(n.updatedAt)}>
                {ago(n.updatedAt)}
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
            <Backlinks notes={data.notes} id={n.id} />
          </article>
        ))}
        {data.notes.length === 0 ? (
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

function Backlinks({ notes, id }: { notes: Snapshot["notes"]; id: string }) {
  const linked = notes.filter((note) => note.id !== id && note.links.includes(id));
  if (linked.length === 0) return null;
  return <div className="meta">Linked from {linked.map((note) => note.title).join(", ")}</div>;
}

export function Decisions({
  data,
  onSaved,
  onDelete,
}: {
  data: Snapshot;
  onSaved: (message: string) => void;
  onDelete: (id: string, title: string) => void;
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
          <article key={d.id} className="row">
            <h2 className="row-title">{d.title}</h2>
            <div className="meta">
              <time dateTime={d.createdAt} title={fullTime(d.createdAt)}>
                {ago(d.createdAt)}
              </time>
              {d.supersedes ? ` · replaces ${titles.get(d.supersedes) ?? d.supersedes}` : ""}
              {replacedBy.has(d.id) ? ` · replaced by ${replacedBy.get(d.id)}` : ""}
              {d.featureIds.length
                ? ` · ${d.featureIds.map((id) => features.get(id) ?? id).join(", ")}`
                : ""}
              <button
                type="button"
                aria-label={`Replace ${d.title}`}
                onClick={() => setRecording(d)}
              >
                Replace
              </button>
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
  return (
    // Rows have no controls, so the scrolling page itself takes focus (WCAG scrollable region).
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-reachable
    <section className="page" tabIndex={0} aria-labelledby="activity-title">
      <h1 id="activity-title">Activity</h1>
      <div className="list">
        {data.activity.map((row) => (
          <article key={row.id} className="row">
            <strong>{nameOf(data, row.actorId)}</strong>{" "}
            {activityWords(row.verb, row.entity, row.diff)}
            {titles.has(row.entityId) ? (
              <span className="subject"> {titles.get(row.entityId)}</span>
            ) : null}
            <div className="meta">
              <time dateTime={row.at} title={fullTime(row.at)}>
                {ago(row.at)}
              </time>
              {row.branch ? ` · ${row.branch}` : ""}
            </div>
          </article>
        ))}
        {data.activity.length === 0 ? (
          <p className="empty">No activity yet. Changes appear here as they happen.</p>
        ) : null}
      </div>
    </section>
  );
}

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
  onClose,
  onSave,
  onRelease,
  onTakeOver,
  onDelete,
}: {
  data: Snapshot;
  id: string;
  onClose: () => void;
  /** Rejects when the save is refused (the reason is already shown). */
  onSave: (id: string, patch: Record<string, unknown>) => Promise<{ version: number }>;
  onRelease: (id: string, force: boolean) => void;
  onTakeOver: (id: string) => void;
  onDelete: (id: string, title: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const task = data.tasks.find((t) => t.id === id);
  const found = task !== undefined;
  useEffect(() => {
    if (!found) return;
    const previous = document.activeElement;
    heading.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [found]);
  if (!task) return null;
  const feature = data.features.find((f) => f.id === task.featureId);
  // Someone else's live claim is ended with Take over or Release first, not deleted under them.
  const held =
    task.claim !== null &&
    task.claim.actorId !== data.you &&
    Date.parse(task.claim.leaseUntil) > Date.now();
  return (
    <aside className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <button type="button" onClick={onClose}>
        Close
      </button>
      <h2 id="sheet-title" ref={heading} tabIndex={-1}>
        {task.title}
      </h2>
      {task.claim ? (
        <ClaimBox
          data={data}
          claim={task.claim}
          onRelease={(force) => onRelease(task.id, force)}
          onTakeOver={() => onTakeOver(task.id)}
        />
      ) : null}
      {/* Keyed by version, so a change made elsewhere reloads the fields instead of being overwritten. */}
      <form
        key={task.version}
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const status = String(form.get("status") ?? task.status);
          const dueDate = String(form.get("dueDate") ?? "") || null;
          const milestoneId = form.has("milestoneId")
            ? String(form.get("milestoneId")) || null
            : (task.milestoneId ?? null);
          const assigneeIds = form.getAll("assigneeIds").map(String);
          const sameAssignees =
            assigneeIds.length === (task.assigneeIds ?? []).length &&
            assigneeIds.every((a) => task.assigneeIds?.includes(a));
          // Unchanged planning fields stay out of the patch, so old tasks keep their shape.
          void onSave(task.id, {
            title: String(form.get("title") ?? ""),
            body: String(form.get("body") ?? ""),
            ...(status === task.status ? {} : { status }),
            ...(dueDate === (task.dueDate ?? null) ? {} : { dueDate }),
            ...(milestoneId === (task.milestoneId ?? null) ? {} : { milestoneId }),
            ...(sameAssignees ? {} : { assigneeIds }),
            expectedVersion: task.version,
          }).catch(() => undefined);
        }}
      >
        <input className="field" name="title" defaultValue={task.title} aria-label="Title" />
        <textarea
          className="field"
          name="body"
          rows={8}
          defaultValue={task.body}
          aria-label="Body"
        />
        <label className="sheet-label">
          Due date
          <input className="field" type="date" name="dueDate" defaultValue={task.dueDate ?? ""} />
        </label>
        {data.milestones.length > 0 ? (
          <PlanSelect className="sheet-label" data={data} chosen={task.milestoneId ?? null} />
        ) : null}
        <Assignees data={data} chosen={task.assigneeIds ?? []} />
        <select name="status" defaultValue={task.status} aria-label="Status">
          {statusOptions(task.status).map((s) => (
            <option key={s} value={s}>
              {statusWord(s)}
            </option>
          ))}
        </select>
        <button type="submit">Save</button>
      </form>
      <Checklist
        version={task.version}
        items={task.checklist ?? []}
        onChange={(checklist, expectedVersion) => onSave(task.id, { checklist, expectedVersion })}
      />
      {held ? null : (
        <button type="button" className="danger" onClick={() => onDelete(task.id, task.title)}>
          Delete task
        </button>
      )}
      {feature && feature.acceptance.length > 0 ? (
        <>
          <h3>Acceptance</h3>
          <ul>
            {feature.acceptance.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      <Markdown source={task.body} />
    </aside>
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
}: {
  version: number;
  items: { text: string; done: boolean }[];
  onChange: (
    items: { text: string; done: boolean }[],
    expectedVersion: number,
  ) => Promise<{ version: number }>;
}) {
  // Shown at once; a refused save puts back what the server has. A new version (a save from
  // here or anywhere) resets it to the server's list without remounting, so focus stays put.
  const [shown, setShown] = useState(items);
  // biome-ignore lint/correctness/useExhaustiveDependencies: items is new on every snapshot; the version says when it changed
  useEffect(() => setShown(items), [version]);
  // Quick ticks run one after another, each with the version the last save returned; sent
  // together, the second would carry a stale version and be refused.
  const latest = useRef(version);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    latest.current = Math.max(latest.current, version);
  }, [version]);
  const change = (next: typeof items) => {
    setShown(next);
    queue.current = queue.current.then(() =>
      onChange(next, latest.current).then(
        (saved) => {
          latest.current = saved.version;
        },
        () => setShown(items),
      ),
    );
  };
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
              onClick={() => change(shown.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="checklist-add"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("step");
          if (!(input instanceof HTMLInputElement) || input.value.trim() === "") return;
          change([...shown, { text: input.value.trim(), done: false }]);
          input.value = "";
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
  const name = nameOf(data, claim.actorId);
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
