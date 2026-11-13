import { type ReactNode, useState } from "react";
import { api, type Card, type Snapshot } from "./api.js";
import { FormDialog } from "./forms.js";
import { personOnly } from "./moves.js";
import { nameOf } from "./people.js";
import { Ago } from "./time.js";
import { kindLabel, plainError } from "./words.js";

/** The folder a card is filed under: everything before its last `/`, or the top level. */
function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "Top level";
}

/**
 * True when the card is about one file in the project: only that can be approved. A folder, a
 * wildcard, a part of a file (`#`) and a web link have no single version to sign off.
 */
export const oneFile = (path: string): boolean =>
  !/[*?[\]{}#]/u.test(path) && !/^(?:[a-z][a-z0-9+.-]*:|[\\/])/iu.test(path) && !path.endsWith("/");

const field = (form: FormData, name: string) => String(form.get(name) ?? "");

/** Edits one card through the same `putContext` agents use. Facts are one per line. */
function CardForm({
  card,
  onClose,
  onSaved,
}: {
  card: Card | "new";
  onClose: () => void;
  onSaved: (card: Card) => void;
}) {
  const [opened] = useState(card === "new" ? undefined : card);
  return (
    <FormDialog
      title={opened ? "Edit card" : "New card"}
      submit="Save card"
      busy="Saving…"
      onClose={onClose}
      onSubmit={(form) => {
        const facts = field(form, "facts")
          .split(/\r?\n/u)
          .map((f) => f.trim())
          .filter(Boolean);
        const tags = field(form, "tags")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        const seen = field(form, "sourceSeen").trim();
        return api
          .saveCard({
            path: opened?.path ?? field(form, "path").trim(),
            summary: field(form, "summary").trim(),
            facts,
            tags,
            ...(seen ? { sourceSeen: seen } : {}),
            ...(opened?.keyFiles.length ? { keyFiles: opened.keyFiles } : {}),
            ...(opened?.sourceTokens !== undefined ? { sourceTokens: opened.sourceTokens } : {}),
            private: form.get("private") === "on",
          })
          .then(onSaved);
      }}
    >
      {opened ? (
        <p className="dialog-note">
          <code>{opened.path}</code>
        </p>
      ) : (
        <label>
          File or folder
          <input
            className="field"
            name="path"
            required
            maxLength={1000}
            placeholder="venue/hall-b-quote.pdf"
          />
        </label>
      )}
      <label>
        Summary
        <textarea
          className="field"
          name="summary"
          required
          rows={3}
          maxLength={2000}
          defaultValue={opened?.summary}
          placeholder="What it is and what matters in it"
        />
      </label>
      <label>
        Facts, one per line
        <textarea
          className="field"
          name="facts"
          rows={5}
          defaultValue={opened?.facts?.join("\n")}
          placeholder={"Price: $2,400 for the day\nValid until 1 December"}
        />
      </label>
      <label>
        Tags
        <input
          className="field"
          name="tags"
          defaultValue={opened?.tags?.join(", ")}
          placeholder="venue, fair"
        />
      </label>
      <label>
        Version read, such as the file's modified date
        <input
          className="field"
          name="sourceSeen"
          maxLength={200}
          defaultValue={opened?.sourceSeen}
          placeholder="2026-11-07"
        />
      </label>
      {/* A shared card is already in git history; it cannot be taken back, so it is not offered. */}
      {opened && !opened.private ? (
        <p className="dialog-note">Shared with the team through the project folder.</p>
      ) : (
        <label className="dialog-check">
          <input type="checkbox" name="private" defaultChecked={opened?.private ?? false} />
          Keep on this computer only (never shared)
        </label>
      )}
    </FormDialog>
  );
}

/**
 * Memory: what people and agents learned about the project's files. sati never opens the files; cards are what someone
 * wrote after reading them.
 */
export function Memory({
  data,
  tabs,
  onSaved,
  onFailed,
}: {
  data: Snapshot;
  /** The Notes, Decisions and File cards tabs, shown under the heading. */
  tabs: ReactNode;
  onSaved: (message: string) => void;
  /** Shows why an approval was refused. */
  onFailed: (err: unknown) => void;
}) {
  const [editing, setEditing] = useState<Card | "new" | null>(null);
  const [filter, setFilter] = useState("");
  // The path being approved: its button waits, so a second click cannot send it twice.
  const [approving, setApproving] = useState<string | null>(null);
  const approve = (c: Card) => {
    const clear = c.approved !== undefined;
    setApproving(c.path);
    api
      .approveCard(c.path, clear)
      .then(() =>
        onSaved(
          clear
            ? `${c.path} is no longer approved.`
            : `Approved ${c.path} as it is now. A change to it is stopped until a person approves it again.`,
        ),
      )
      .catch(onFailed)
      .finally(() => setApproving(null));
  };
  const needle = filter.trim().toLowerCase();
  const cards = data.cards.filter(
    (c) =>
      !needle ||
      [c.path, c.summary, ...(c.facts ?? []), ...(c.tags ?? [])].some((t) =>
        t.toLowerCase().includes(needle),
      ),
  );
  const folders = new Map<string, Card[]>();
  for (const c of [...cards].sort((a, b) => a.path.localeCompare(b.path))) {
    const f = folderOf(c.path);
    folders.set(f, [...(folders.get(f) ?? []), c]);
  }
  return (
    <section className="page" aria-labelledby="memory-title">
      <div className="page-head">
        <h1 id="memory-title">Knowledge</h1>
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          New card
        </button>
      </div>
      {tabs}
      <div className="memory-filter">
        <input
          className="field"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter cards"
          aria-label="Filter cards"
        />
        <span className="meta">
          {cards.length} of {data.cards.length} {data.cards.length === 1 ? "card" : "cards"}
        </span>
      </div>
      <div className="list">
        {[...folders].map(([folder, list]) => (
          <section key={folder} className="change-day" aria-label={folder}>
            <h2>{folder}</h2>
            {list.map((c) => (
              <article key={c.id} className="row">
                <h3 className="row-title">{c.path.slice(c.path.lastIndexOf("/") + 1) || c.path}</h3>
                {c.private ? <span className="badge private">Private</span> : null}
                {c.stale ? <span className="badge kind-late">Changed since</span> : null}
                {c.approved ? (
                  c.approval === "changed" ? (
                    <span className="badge kind-late">Changed since approval</span>
                  ) : c.approval === "missing" ? (
                    <span className="badge kind-late">Approved file is gone</span>
                  ) : (
                    <span className="badge kind-done">Approved</span>
                  )
                ) : null}
                <p className="summary">{c.summary}</p>
                {c.facts?.length ? (
                  <ul className="facts">
                    {c.facts.map((f, i) => (
                      // Two lines may read the same; the position tells them apart.
                      // biome-ignore lint/suspicious/noArrayIndexKey: plain text lines have no ids
                      <li key={`${i}:${f}`}>{f}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="meta">
                  {nameOf(data, c.createdBy)} ·{" "}
                  <time dateTime={c.updatedAt}>
                    <Ago iso={c.updatedAt} />
                  </time>
                  {c.sourceSeen ? ` · read at ${c.sourceSeen}` : ""}
                  {c.tags?.length ? ` · ${c.tags.join(", ")}` : ""}
                  {c.approved
                    ? ` · approved by ${nameOf(data, c.approved.by)} on ${c.approved.at.slice(0, 10)}`
                    : ""}
                  <button type="button" aria-label={`Edit ${c.path}`} onClick={() => setEditing(c)}>
                    Edit
                  </button>
                  {/* Approval is a person's: a board run by an agent has no button to fail. */}
                  {(oneFile(c.path) || c.approved) && personOnly(data) === null ? (
                    <button
                      type="button"
                      disabled={approving === c.path}
                      aria-label={
                        c.approved
                          ? `Remove the approval of ${c.path}`
                          : `Approve ${c.path} as it is now`
                      }
                      onClick={() => approve(c)}
                    >
                      {c.approved ? "Remove approval" : "Approve"}
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
          </section>
        ))}
        {data.cards.length === 0 ? (
          <p className="empty">
            No cards yet. When an agent reads a document, it saves what matters here, so nobody
            reads it twice.
          </p>
        ) : null}
        {data.cards.length > 0 && cards.length === 0 ? (
          <p className="empty">No card matches the filter.</p>
        ) : null}
      </div>
      {editing ? (
        <CardForm
          card={editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            setEditing(null);
            onSaved(`Saved the card for ${c.path}.`);
          }}
        />
      ) : null}
    </section>
  );
}
