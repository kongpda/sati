import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Card, type RecallItem, type Snapshot } from "./api.js";
import { FormDialog } from "./forms.js";
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
 * Memory: what people and agents learned about the project's files, and an Ask box that gives
 * the same answer `recall` gives an agent. sati never opens the files; cards are what someone
 * wrote after reading them.
 */
export function Memory({
  data,
  onSaved,
  onCopied,
  onCopyFailed,
  onFailed,
  onOpenTask,
  onGo,
}: {
  data: Snapshot;
  onSaved: (message: string) => void;
  /** Copying changes no record, so it says so without refetching. */
  onCopied: (message: string) => void;
  onCopyFailed: () => void;
  /** Shows why an approval was refused. */
  onFailed: (err: unknown) => void;
  onOpenTask: (id: string) => void;
  /** Opens a list page at one record. */
  onGo: (path: string, id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [question, setQuestion] = useState("");
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
  const answer = useQuery({
    queryKey: ["recall", question, data.version],
    queryFn: () => api.recall(question),
    enabled: question !== "",
    // A write elsewhere bumps the version: keep showing this question's answer while it
    // refreshes. Another question's answer is never shown for this one.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === question ? previous : undefined,
  });

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
  const open = (item: RecallItem) => {
    if (item.kind === "task") onOpenTask(item.id);
    else if (item.kind === "card") {
      const card = data.cards.find((c) => c.id === item.id);
      if (card) setEditing(card);
    } else onGo(item.kind === "note" ? "/notes" : "/decisions", item.id);
  };

  return (
    <section className="page" aria-labelledby="memory-title">
      <div className="page-head">
        <h1 id="memory-title">Memory</h1>
        <button type="button" className="primary" onClick={() => setEditing("new")}>
          New card
        </button>
      </div>
      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          setQuestion(draft.trim());
        }}
      >
        <label htmlFor="ask-input">Ask what the team knows</label>
        <div className="ask-row">
          <input
            id="ask-input"
            className="field"
            value={draft}
            maxLength={500}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What did the venue quote say?"
          />
          <button type="submit" className="primary" disabled={draft.trim() === ""}>
            Ask
          </button>
        </div>
      </form>
      {question && answer.error ? (
        <p className="form-error" role="alert">
          {plainError(answer.error)}
        </p>
      ) : null}
      {question && answer.isPending && !answer.error ? (
        <p className="meta" role="status">
          Looking for “{question}”…
        </p>
      ) : null}
      {question && answer.data ? (
        <section className="answer" aria-label="Answer" aria-live="polite">
          <div className="answer-head">
            <h2>
              {answer.data.items.length === 0
                ? "Nothing in memory matches yet"
                : `What is known about “${question}”`}
            </h2>
            {answer.data.items.length > 0 ? (
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(answer.data?.markdown ?? "")
                    .then(() => onCopied("Copied the answer as Markdown."))
                    .catch(onCopyFailed)
                }
              >
                Copy as Markdown
              </button>
            ) : null}
          </div>
          {answer.data.items.length === 0 ? (
            <p className="meta">
              Ask an agent to read the files and save cards, or add one with New card.
            </p>
          ) : null}
          {answer.data.items.map((item) => (
            <article key={item.id} className="row">
              <span className={`badge kind-${item.kind}`}>{kindLabel(item.kind)}</span>
              <button type="button" className="row-link" onClick={() => open(item)}>
                {item.title}
              </button>
              {item.private ? <span className="badge private">Private</span> : null}
              <p className="summary">
                {item.text.length > 300 ? `${item.text.slice(0, 299)}…` : item.text}
              </p>
              {item.facts.length ? (
                <ul className="facts">
                  {item.facts.slice(0, 5).map((f, i) => (
                    // Two lines may read the same; the position tells them apart.
                    // biome-ignore lint/suspicious/noArrayIndexKey: plain text lines have no ids
                    <li key={`${i}:${f}`}>{f}</li>
                  ))}
                </ul>
              ) : null}
              {item.stale ? (
                <p className="meta late">The file changed since; read it again.</p>
              ) : null}
            </article>
          ))}
          {answer.data.omitted > 0 ? (
            <p className="meta">
              {answer.data.omitted} more matched. Ask a narrower question to see them.
            </p>
          ) : null}
        </section>
      ) : null}

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
                {c.approved ? <span className="badge kind-done">Approved</span> : null}
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
                  {oneFile(c.path) || c.approved ? (
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
