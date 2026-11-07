import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ChangeItem, type ChangesFilter, type Snapshot } from "./api.js";
import { nameOf } from "./people.js";
import { capital, dayWords, fullTime, plainError } from "./words.js";

const RANGES = [
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["2w", "Last 2 weeks"],
  ["30d", "Last 30 days"],
  ["last-session", "Since my last visit"],
] as const;

const FEATURE_WORDS: Record<string, string> = {
  shipped: "Shipped",
  building: "Started building",
  deprecated: "Deprecated",
  removed: "Removed",
  planned: "Moved back to planned",
};

function what(item: ChangeItem): string {
  if (item.kind === "done") return "Done";
  if (item.kind === "feature") return FEATURE_WORDS[item.status] ?? capital(item.status);
  if (item.kind === "decision") return "Decided";
  return item.edited ? "Edited note" : "New note";
}

/** The reader's own calendar day, so "today" means their today. */
function localDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Today" and "Yesterday" read faster than a date in a timeline. */
function dayLabel(day: string): string {
  const now = new Date();
  if (day === localDay(now.toISOString())) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day === localDay(yesterday.toISOString())) return "Yesterday";
  return dayWords(day);
}

/**
 * What changed, day by day, with the same changelog and feature list `sati changes` prints, so a
 * person can paste release notes into an email or a release page without asking an agent.
 */
export function Changes({
  data,
  onOpenTask,
  onGo,
  onCopied,
}: {
  data: Snapshot;
  onOpenTask: (id: string) => void;
  onGo: (path: string) => void;
  onCopied: (message: string) => void;
}) {
  const [filter, setFilter] = useState<ChangesFilter>({
    since: "7d",
    milestoneId: "",
    actorId: "",
  });
  const general = data.project?.kind === "general";
  // Keyed by the snapshot version, so the page follows every write as the board does.
  const query = useQuery({
    queryKey: ["changes", filter, data.version],
    queryFn: () => api.changes(filter),
    placeholderData: (previous) => previous,
  });
  const set = (patch: Partial<ChangesFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const copy = async (label: string, text: () => Promise<string>) => {
    try {
      await navigator.clipboard.writeText(await text());
      onCopied(`Copied the ${label}.`);
    } catch (err) {
      onCopied(`Could not copy the ${label}: ${plainError(err)}`);
    }
  };

  const changes = query.data?.changes;
  const days = new Map<string, ChangeItem[]>();
  for (const item of changes?.items ?? []) {
    const day = localDay(item.at);
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  // People first, then agents, each by the name shown.
  const people = [...data.actors].sort(
    (a, b) =>
      Number(a.kind !== "human") - Number(b.kind !== "human") ||
      nameOf(data, a.id).localeCompare(nameOf(data, b.id)),
  );
  const isDate = /^\d{4}-\d{2}-\d{2}$/u.test(filter.since);

  return (
    <section className="page" aria-labelledby="changes-title">
      <div className="page-head">
        <h1 id="changes-title">Changes</h1>
        <div className="page-actions">
          <button
            type="button"
            disabled={!query.data}
            onClick={() => void copy("changelog", async () => query.data?.changelog ?? "")}
          >
            Copy changelog
          </button>
          {general ? null : (
            <button
              type="button"
              onClick={() =>
                void copy("feature list", async () => (await api.featureList()).markdown)
              }
            >
              Copy feature list
            </button>
          )}
        </div>
      </div>
      <fieldset className="changes-filters">
        <legend className="sr-only">Show changes</legend>
        <label>
          When
          <select
            value={isDate ? "" : filter.since}
            onChange={(e) => set({ since: e.target.value })}
          >
            {isDate ? <option value="">From a day</option> : null}
            {RANGES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            className="field"
            value={isDate ? filter.since : ""}
            max={localDay(new Date().toISOString())}
            onChange={(e) => set({ since: e.target.value || "7d" })}
          />
        </label>
        {data.milestones.length > 0 ? (
          <label>
            Plan
            <select
              value={filter.milestoneId}
              onChange={(e) => set({ milestoneId: e.target.value })}
            >
              <option value="">All plans</option>
              {data.milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Who
          <select value={filter.actorId} onChange={(e) => set({ actorId: e.target.value })}>
            <option value="">Everyone</option>
            {people.map((a) => (
              <option key={a.id} value={a.id}>
                {nameOf(data, a.id)}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      {query.error ? (
        <p className="empty" role="alert">
          {plainError(query.error)}
        </p>
      ) : null}
      {changes ? (
        <p className="meta changes-basis" aria-live="polite">
          {capital(changes.basis)}: {changes.items.length}{" "}
          {changes.items.length === 1 ? "change" : "changes"}.
        </p>
      ) : null}
      <div className="list">
        {[...days].map(([day, items]) => (
          <section key={day} className="change-day" aria-label={dayLabel(day)}>
            <h2>{dayLabel(day)}</h2>
            {items.map((item) => (
              <article key={`${item.kind}-${item.id}`} className="row change">
                <span className={`badge kind-${item.kind}`}>{what(item)}</span>
                {item.kind === "done" ? (
                  <button type="button" className="row-link" onClick={() => onOpenTask(item.id)}>
                    {item.title}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="row-link"
                    onClick={() =>
                      onGo(
                        item.kind === "feature"
                          ? "/features"
                          : item.kind === "decision"
                            ? "/decisions"
                            : "/notes",
                      )
                    }
                  >
                    {item.title}
                  </button>
                )}
                {item.kind === "done" ? (
                  <p className="summary">{item.releaseNote ?? item.summary}</p>
                ) : null}
                <div className="meta">
                  {item.by ? nameOf(data, item.by) : "someone"}
                  {" · "}
                  <time dateTime={item.at} title={fullTime(item.at)}>
                    {new Date(item.at).toLocaleTimeString([], { timeStyle: "short" })}
                  </time>
                  {item.kind === "done" && item.labels.includes("internal") ? " · internal" : ""}
                </div>
              </article>
            ))}
          </section>
        ))}
        {changes && changes.items.length === 0 ? (
          <p className="empty">Nothing changed in this time. Try a longer range.</p>
        ) : null}
        {changes && changes.blocked.length + changes.overdue.length > 0 ? (
          <section className="change-day" aria-label="Needs attention">
            <h2>Needs attention now</h2>
            {changes.overdue.map((t) => (
              <article key={t.id} className="row change">
                <span className="badge kind-late">Overdue</span>
                <button type="button" className="row-link" onClick={() => onOpenTask(t.id)}>
                  {t.title}
                </button>
                <div className="meta">Was due {dayWords(t.dueDate)}</div>
              </article>
            ))}
            {changes.blocked.map((t) => (
              <article key={t.id} className="row change">
                <span className="badge kind-late">Blocked</span>
                <button type="button" className="row-link" onClick={() => onOpenTask(t.id)}>
                  {t.title}
                </button>
              </article>
            ))}
          </section>
        ) : null}
      </div>
    </section>
  );
}
