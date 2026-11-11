import { useEffect, useId, useRef, useState } from "react";
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

/** A name offered after `@`: the word that calls the person, and how they are shown. */
export interface MentionName {
  handle: string;
  name: string;
}

/** The `@word` the caret is at the end of, if any. Not inside a word or an email address. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const found = /(?<![\p{L}\p{N}_.])@([^\s@]*)$/u.exec(text.slice(0, caret));
  return found ? { start: found.index, query: found[1] ?? "" } : null;
}

const MENTION_MAX = 6;

/**
 * The people, then the agents, whose name starts with what was typed after `@`. The handle is a
 * word My work answers to (the first word of the shown name, or the user part of
 * `user@worktree`), so a picked name always reaches its person. Sessions of one agent share a
 * handle and are offered once.
 */
export function mentionNames(data: Snapshot, query: string): MentionName[] {
  const typed = query.toLowerCase();
  const seen = new Set<string>();
  const names: MentionName[] = [];
  const people = (data.actors ?? []).filter((a) => a.id !== data.you);
  for (const a of [...people].sort(
    (x, y) =>
      Number(x.kind !== "human") - Number(y.kind !== "human") ||
      personName(x).localeCompare(personName(y)),
  )) {
    const name = personName(a);
    const handle = (a.displayName?.trim().split(/\s+/u)[0] || a.name.split("@")[0]) ?? "";
    const key = handle.toLowerCase();
    if (!handle || seen.has(key)) continue;
    seen.add(key);
    const words = [key, ...name.toLowerCase().split(/\s+/u)];
    if (words.some((w) => w.startsWith(typed))) names.push({ handle, name });
  }
  return names.slice(0, MENTION_MAX);
}

/**
 * The comments and handoffs on one task, note or decision, oldest first, with a box to add one.
 * The draft stays when a save fails, and Ctrl/⌘+Enter sends it. Typing `@` offers the names in
 * the project. `folded` puts it behind a "Comments" toggle, for list pages where every row has
 * one.
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
  const box = useRef<HTMLTextAreaElement>(null);
  // The `@word` being typed and the offered name the arrow keys are on; null when none is offered.
  const [at, setAt] = useState<{ start: number; query: string; active: number } | null>(null);
  const offered = at ? mentionNames(data, at.query) : [];
  const active = Math.min(at?.active ?? 0, offered.length - 1);
  const pick = (name: MentionName) => {
    const field = box.current;
    if (!at || !field) return;
    const head = `${draft.slice(0, at.start)}@${name.handle} `;
    setDraft(head + draft.slice(field.selectionStart));
    setAt(null);
    // After the new text is in the box, or the caret would land at its end.
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(head.length, head.length);
    });
  };
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
        <div className="thread-box">
          <textarea
            ref={box}
            className="field"
            rows={2}
            maxLength={COMMENT_MAX}
            value={draft}
            aria-label="Add a comment"
            aria-autocomplete="list"
            aria-controls={offered.length ? `${id}-names` : undefined}
            aria-activedescendant={offered.length ? `${id}-name-${active}` : undefined}
            placeholder="Add a comment. @name puts it in that person's My work. Agents read it in their brief."
            onChange={(e) => {
              setDraft(e.target.value);
              const found = mentionAt(e.target.value, e.target.selectionStart);
              setAt(found ? { ...found, active: 0 } : null);
            }}
            onBlur={() => setAt(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
                return;
              }
              const name = offered[active];
              if (!at || !name) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const step = e.key === "ArrowDown" ? 1 : offered.length - 1;
                setAt({ ...at, active: (active + step) % offered.length });
              } else if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pick(name);
              } else if (e.key === "Escape") {
                // Closes the names only, not the sheet the comment box is in.
                e.preventDefault();
                e.stopPropagation();
                setAt(null);
              }
            }}
          />
          {offered.length ? (
            <div id={`${id}-names`} className="mention-list" role="listbox" aria-label="Names">
              {offered.map((n, i) => (
                <div
                  key={n.handle}
                  id={`${id}-name-${i}`}
                  role="option"
                  // Focus stays in the box; the arrow keys move `aria-activedescendant`.
                  tabIndex={-1}
                  aria-selected={i === active}
                  // Before the box loses focus, which would close the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(n);
                  }}
                >
                  <strong>@{n.handle}</strong>
                  {n.name === n.handle ? null : <span>{n.name}</span>}
                </div>
              ))}
            </div>
          ) : null}
        </div>
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
