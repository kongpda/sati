import { useEffect, useId, useState } from "react";
import { ago, type Note, type Snapshot } from "./api.js";
import { Markdown } from "./markdown.js";
import { Avatar, personName } from "./people.js";
import { Ago } from "./time.js";
import { fullTime } from "./words.js";

/** Kept in step with COMMENT_TAG and COMMENT_MAX in core, which validate them. */
export const COMMENT_TAG = "comment";
export const COMMENT_MAX = 10_000;

/** Comments and handoffs are notes linked to the record they are on. */
export const isThreadNote = (n: Note) => n.tags.includes(COMMENT_TAG) || n.tags.includes("handoff");

/** The record a comment or handoff note is on, if it is one. */
export const threadOf = (n: Note): string | undefined => (isThreadNote(n) ? n.links[0] : undefined);

/**
 * Every record's thread, oldest first, built once per snapshot. A list page draws one Thread per
 * note or decision, so filtering all notes for each would be quadratic.
 */
const index = new WeakMap<Note[], Map<string, Note[]>>();
function threadsOf(notes: Note[]): Map<string, Note[]> {
  let byRecord = index.get(notes);
  if (byRecord) return byRecord;
  byRecord = new Map();
  for (const n of notes) {
    if (!isThreadNote(n)) continue;
    for (const link of n.links) byRecord.set(link, [...(byRecord.get(link) ?? []), n]);
  }
  for (const list of byRecord.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  index.set(notes, byRecord);
  return byRecord;
}

const NONE: Note[] = [];

/**
 * The comments and handoffs on one task, note or decision, oldest first, with a box to add one.
 * The draft stays when a save fails, and Ctrl/⌘+Enter sends it. `folded` puts it behind a
 * "Comments" toggle, for list pages where every row has one.
 */
export function Thread({
  data,
  on,
  onAdd,
  onDelete,
  folded = false,
  onDraft,
}: {
  data: Snapshot;
  on: string;
  onAdd: (on: string, body: string) => Promise<unknown>;
  onDelete: (id: string, title: string) => void;
  folded?: boolean;
  /** Tells the caller whether a comment is typed but not sent, so leaving can ask first. */
  onDraft?: (typed: boolean, on: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // The fold's own state, so a snapshot refresh never closes it on a half-typed comment.
  const [open, setOpen] = useState(false);
  const items = threadsOf(data.notes).get(on) ?? NONE;
  const typed = draft.trim() !== "";
  useEffect(() => {
    onDraft?.(typed, on);
    return () => onDraft?.(false, on);
  }, [typed, on, onDraft]);
  const send = () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    onAdd(on, body)
      .then(() => setDraft(""))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const title = `Comments${items.length ? ` · ${items.length}` : ""}`;
  const body = (
    <>
      {items.length ? (
        <ol>
          {items.map((c) => {
            const author = data.actors.find((a) => a.id === c.createdBy);
            const name = author ? personName(author) : "someone";
            return (
              <li key={c.id}>
                <div className="meta thread-head">
                  {author ? <Avatar actor={author} /> : null}
                  <strong>{name}</strong>
                  {c.tags.includes("handoff") ? <span className="badge">Handoff</span> : null}
                  <time dateTime={c.createdAt} title={fullTime(c.createdAt)}>
                    <Ago iso={c.createdAt} />
                  </time>
                  {c.createdBy === data.you ? (
                    <button
                      type="button"
                      aria-label={`Delete your comment from ${ago(c.createdAt)}`}
                      onClick={() => onDelete(c.id, "the comment")}
                    >
                      Delete
                    </button>
                  ) : null}
                </div>
                <Markdown source={c.body} />
              </li>
            );
          })}
        </ol>
      ) : null}
      <form
        className="thread-add"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          className="field"
          rows={2}
          maxLength={COMMENT_MAX}
          value={draft}
          aria-label="Add a comment"
          placeholder="Add a comment. Agents read it in their brief."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" disabled={busy || draft.trim() === ""}>
          {busy ? "Sending…" : "Comment"}
        </button>
      </form>
    </>
  );
  return folded ? (
    <details className="thread" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{title}</summary>
      {body}
    </details>
  ) : (
    <section className="thread" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{title}</h3>
      {body}
    </section>
  );
}
