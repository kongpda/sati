import { ago, type Snapshot } from "./api.js";
import { Markdown } from "./markdown.js";

export function Agents({ data, onRelease }: { data: Snapshot; onRelease: () => void }) {
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
                <div key={t.id}>
                  Holding {t.title} until {t.claim?.leaseUntil.slice(11, 16)}Z
                </div>
              ))}
              {locks.map((l) => (
                <div key={l.id} className="meta">
                  {l.mode} lock on {l.paths.join(", ")} by {name.get(l.actorId)}
                </div>
              ))}
              {tasks.length === 0 && locks.length === 0 ? <div className="meta">Idle</div> : null}
            </article>
          );
        })}
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
            <strong>{f.title}</strong>
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
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = new FormData(e.currentTarget).get("paths");
                onSavePaths(f.id, String(input ?? ""), f.version);
              }}
            >
              <input
                className="field"
                name="paths"
                defaultValue={f.paths.join(", ")}
                aria-label={`Paths for ${f.title}`}
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
          <p className="empty">
            No milestones yet. The command is sati milestone create, once that checklist item lands.
          </p>
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
  onCreate: (title: string, body: string) => void;
  onReviewed: (id: string, version: number) => void;
}) {
  return (
    <div className="page">
      <h1>Notes</h1>
      <form
        className="list"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          onCreate(String(form.get("title") ?? ""), String(form.get("body") ?? ""));
          e.currentTarget.reset();
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
            <strong>{n.title}</strong>
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
            <strong>{d.title}</strong>
            <div className="meta">
              <time dateTime={d.createdAt} title={d.createdAt}>
                {ago(d.createdAt)}
              </time>
              {d.supersedes ? ` · supersedes ${titles.get(d.supersedes) ?? d.supersedes}` : ""}
            </div>
            <Markdown source={d.decision} />
          </article>
        ))}
        {data.decisions.length === 0 ? (
          <p className="empty">No decisions yet. Record one with sati decision record.</p>
        ) : null}
      </div>
    </div>
  );
}

export function Activity({ data }: { data: Snapshot }) {
  const names = new Map(data.actors.map((a) => [a.id, a.name]));
  return (
    <div className="page">
      <h1>Activity</h1>
      <div className="list">
        {data.activity.map((row) => (
          <article key={row.id} className="row">
            <strong>{names.get(row.actorId) ?? row.actorId}</strong> {row.verb} {row.entity}
            <div className="meta">
              <time dateTime={row.at} title={row.at}>
                {ago(row.at)}
              </time>
              {row.branch ? ` · ${row.branch}` : ""}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export function TaskSheet({
  data,
  id,
  onClose,
  onSave,
}: {
  data: Snapshot;
  id: string;
  onClose: () => void;
  onSave: (id: string, patch: Record<string, unknown>) => void;
}) {
  const task = data.tasks.find((t) => t.id === id);
  if (!task) return null;
  const feature = data.features.find((f) => f.id === task.featureId);
  return (
    <aside className="sheet" role="dialog" aria-label={task.title}>
      <button type="button" onClick={onClose}>
        Close
      </button>
      <h2>{task.title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          onSave(task.id, {
            title: String(form.get("title") ?? ""),
            body: String(form.get("body") ?? ""),
            status: String(form.get("status") ?? task.status),
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
          {["backlog", "todo", "in_progress", "review", "blocked", "cancelled"].map((s) => (
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
