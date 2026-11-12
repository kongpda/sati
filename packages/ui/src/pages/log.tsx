import type { ReactNode } from "react";
import type { Snapshot } from "../api.js";
import { nameOf } from "../people.js";
import { threadOf } from "../thread.js";
import { Ago } from "../time.js";
import { activityWords, fullTime } from "../words.js";

/** The Log tab of Changes: every write, newest first. */
export function Activity({ data, tabs }: { data: Snapshot; tabs: ReactNode }) {
  // Name the record each row touched when it is still on screen elsewhere in the snapshot.
  const titles = new Map<string, string>([
    ...data.tasks.map((t) => [t.id, t.title] as const),
    ...data.features.map((f) => [f.id, f.title] as const),
    ...data.notes.map((n) => [n.id, n.title] as const),
    ...data.decisions.map((d) => [d.id, d.title] as const),
    ...data.milestones.map((m) => [m.id, m.title] as const),
  ]);
  const notes = new Map(data.notes.map((n) => [n.id, n]));
  return (
    // Rows have no controls, so the scrolling page itself takes focus (WCAG scrollable region).
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-reachable
    <section className="page" tabIndex={0} aria-labelledby="activity-title">
      <div className="page-head">
        <h1 id="activity-title">Changes</h1>
      </div>
      {tabs}
      <div className="list">
        {data.activity.map((row) => {
          // A new comment reads "commented on <the task>", not "added the note Comment on …".
          const note = row.entity === "note" ? notes.get(row.entityId) : undefined;
          const on = note && row.verb === "create" ? threadOf(note) : undefined;
          const handoff = note?.tags.includes("handoff");
          const subject = titles.get(on ?? row.entityId);
          return (
            <article key={row.id} className="row">
              <strong>{nameOf(data, row.actorId)}</strong>{" "}
              {on
                ? handoff
                  ? "left a handoff on"
                  : "commented on"
                : activityWords(row.verb, row.entity, row.diff)}
              {subject ? <span className="subject"> {subject}</span> : null}
              <div className="meta">
                <time dateTime={row.at} title={fullTime(row.at)}>
                  <Ago iso={row.at} />
                </time>
                {row.branch ? ` · ${row.branch}` : ""}
              </div>
            </article>
          );
        })}
        {data.activity.length === 0 ? (
          <p className="empty">No activity yet. Changes appear here as they happen.</p>
        ) : null}
      </div>
    </section>
  );
}
