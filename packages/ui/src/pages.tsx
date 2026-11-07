import { useEffect, useRef } from "react";
import { ago, clockTime, leaseLeft, type Snapshot } from "./api.js";
import { Markdown } from "./markdown.js";

export function Agents({
  data,
  onRelease,
  onReleaseTask,
}: {
  data: Snapshot;
  onRelease: () => void;
  onReleaseTask: (id: string) => void;
}) {
  const name = new Map(data.actors.map((a) => [a.id, a.name]));
  return (
    <div className="page">
      <h1>Agents</h1>
      <button type="button" onClick={onRelease}>
        Release expired claims
      </button>
      <div className="list" style={{ marginTop: 12 }}>
        {data.actors.map((actor) => {
          const tasks = data.tasks.filter((t) => t.claim?.actorId === actor.id);
          const locks = data.locks.filter((l) => l.actorId === actor.id);
          return (
            <article key={actor.id} className="row">
              <strong>{actor.name}</strong>
              <div className="meta">
                {actor.kind}
                {actor.tool ? ` · ${actor.tool}` : ""}
                {actor.worktree ? ` · ${actor.worktree}` : ""}
              </div>
              {tasks.map((t) => (
                <div key={t.id} className="claim-row">
                  <span>
                    Working on {t.title}
                    {t.claim ? ` (${leaseLeft(t.claim.leaseUntil)})` : ""}
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
                  {l.mode} lock on {l.paths.join(", ")} by {name.get(l.actorId) ?? l.actorId}
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
                <button type="button" onClick={() => onReviewed(f.id, f.version)}>
                  mark reviewed
                </button>
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

export function Roadmap({ data }: { data: Snapshot }) {
  return (
    <div className="page">
      <h1>Roadmap</h1>
      <div className="timeline">
        {data.milestones.map((m) => (
          <div key={m.id} className="tick">
            <time dateTime={m.targetDate ?? undefined}>{m.targetDate ?? "open"}</time>
            <strong>{m.title}</strong>
          </div>
        ))}
      </div>
      <div className="list">
        {data.milestones.map((m) => {
          const features = data.features.filter((f) => f.milestoneId === m.id);
          const tasks = data.tasks.filter((t) => features.some((f) => f.id === t.featureId));
          const done = tasks.filter((t) => t.status === "done").length;
          return (
            <article key={m.id} className="row">
              <strong>{m.title}</strong>
              <div className="meta">
                {m.status}
                {m.targetDate ? ` · ${m.targetDate}` : ""}
                {tasks.length ? ` · ${done}/${tasks.length} tasks done` : ""}
              </div>
              {m.goal ? <p>{m.goal}</p> : null}
              {features.map((f) => (
                <div key={f.id}>{f.title}</div>
              ))}
            </article>
          );
        })}
        {data.milestones.length === 0 ? (
          <p className="empty">No milestones yet. Run {__CLI_NAME__} milestone create "Name".</p>
        ) : null}
      </div>
    </div>
  );
}

export function Notes({
  data,
  onCreate,
  onReviewed,
}: {
  data: Snapshot;
  onCreate: (title: string, body: string) => Promise<void>;
  onReviewed: (id: string, version: number) => void;
}) {
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
      <div className="list" style={{ marginTop: 16 }}>
        {data.notes.map((n) => (
          <article key={n.id} className="row">
            <h2 className="row-title">{n.title}</h2>
            <div className="meta">
              <time dateTime={n.updatedAt} title={n.updatedAt}>
                {ago(n.updatedAt)}
              </time>
              {n.tags.length ? ` · ${n.tags.join(", ")}` : ""}
              {n.needsReview ? (
                <button type="button" onClick={() => onReviewed(n.id, n.version)}>
                  mark reviewed
                </button>
              ) : null}
            </div>
            <Markdown source={n.body} />
            <Backlinks notes={data.notes} id={n.id} />
          </article>
        ))}
        {data.notes.length === 0 ? (
          <p className="empty">No notes yet. Write one above, or an agent records one.</p>
        ) : null}
      </div>
    </div>
  );
}

function Backlinks({ notes, id }: { notes: Snapshot["notes"]; id: string }) {
  const linked = notes.filter((note) => note.id !== id && note.links.includes(id));
  if (linked.length === 0) return null;
  return <div className="meta">Linked from {linked.map((note) => note.title).join(", ")}</div>;
}

export function Decisions({ data }: { data: Snapshot }) {
  const titles = new Map(data.decisions.map((d) => [d.id, d.title]));
  return (
    <div className="page">
      <h1>Decisions</h1>
      <div className="list">
        {data.decisions.map((d) => (
          <article key={d.id} className="row">
            <h2 className="row-title">{d.title}</h2>
            <div className="meta">
              <time dateTime={d.createdAt} title={d.createdAt}>
                {ago(d.createdAt)}
              </time>
              {d.supersedes ? ` · supersedes ${titles.get(d.supersedes) ?? d.supersedes}` : ""}
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
          <p className="empty">No decisions yet. Record one with {__CLI_NAME__} decision record.</p>
        ) : null}
      </div>
    </div>
  );
}

export function Activity({ data }: { data: Snapshot }) {
  const names = new Map(data.actors.map((a) => [a.id, a.name]));
  // Name the record each row touched when it is still on screen elsewhere in the snapshot.
  const titles = new Map<string, string>([
    ...data.tasks.map((t) => [t.id, t.title] as const),
    ...data.features.map((f) => [f.id, f.title] as const),
    ...data.notes.map((n) => [n.id, n.title] as const),
    ...data.decisions.map((d) => [d.id, d.title] as const),
    ...data.milestones.map((m) => [m.id, m.title] as const),
  ]);
  return (
    <div className="page">
      <h1>Activity</h1>
      <div className="list">
        {data.activity.map((row) => (
          <article key={row.id} className="row">
            <strong>{names.get(row.actorId) ?? row.actorId}</strong> {row.verb} {row.entity}
            {titles.has(row.entityId) ? (
              <span className="subject"> {titles.get(row.entityId)}</span>
            ) : null}
            <div className="meta">
              <time dateTime={row.at} title={row.at}>
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
    </div>
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
}: {
  data: Snapshot;
  id: string;
  onClose: () => void;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onRelease: (id: string, force: boolean) => void;
  onTakeOver: (id: string) => void;
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
          onSave(task.id, {
            title: String(form.get("title") ?? ""),
            body: String(form.get("body") ?? ""),
            ...(status === task.status ? {} : { status }),
            expectedVersion: task.version,
          });
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
        <select name="status" defaultValue={task.status} aria-label="Status">
          {statusOptions(task.status).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit">Save</button>
      </form>
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
  const name = data.actors.find((a) => a.id === claim.actorId)?.name ?? claim.actorId;
  const live = Date.parse(claim.leaseUntil) > Date.now();
  const until = (
    <time dateTime={claim.leaseUntil} title={claim.leaseUntil}>
      {clockTime(claim.leaseUntil)}
    </time>
  );
  const confirmed = (action: string) =>
    !live ||
    window.confirm(`${action} from ${name}? Their claim ends and their next save is refused.`);
  return (
    <section className="claim" aria-label="Who is working on this">
      <p>
        {live ? `${mine ? "You are" : `${name} is`} working on this until ` : ""}
        {live ? null : `${mine ? "Your" : `${name}'s`} claim ran out at `}
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
