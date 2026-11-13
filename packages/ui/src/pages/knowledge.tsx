import { useMemo, useState } from "react";
import type { Decision, Note, Snapshot } from "../api.js";
import { DecisionForm, NoteForm } from "../forms.js";
import { Markdown } from "../markdown.js";
import type { ThreadActions } from "../thread.js";
import { isThreadNote, Thread, threadOf } from "../thread.js";
import { Ago } from "../time.js";
import { fullTime } from "../words.js";

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
  thread,
}: {
  data: Snapshot;
  onSaved: (message: string) => void;
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
              {replacedBy.has(d.id) ? ` · Superseded by ${replacedBy.get(d.id)}` : ""}
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
