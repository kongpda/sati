import { useRef, useState } from "react";
import type { Milestone, Snapshot } from "../api.js";
import { MilestoneForm, PlanForm } from "../forms.js";
import { Markdown } from "../markdown.js";
import { capital, dayWords } from "../words.js";

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
