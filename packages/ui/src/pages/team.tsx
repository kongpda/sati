import type { Snapshot } from "../api.js";
import { claimRefusal } from "../moves.js";
import { Avatar, personName } from "../people.js";
import { useMinute } from "../time.js";
import { untilTime } from "../words.js";

/** The agents section of the Team page: who works now, and the claims they hold. */
export function Agents({
  data,
  onRelease,
  onReleaseTask,
}: {
  data: Snapshot;
  onRelease: () => void;
  onReleaseTask: (id: string) => void;
}) {
  useMinute();
  // Who is working comes first; the idle stay in their usual order below.
  const busy = new Set([
    ...data.tasks.flatMap((t) => (t.claim ? [t.claim.actorId] : [])),
    ...data.locks.map((l) => l.actorId),
  ]);
  const actors = [...data.actors].sort((a, b) => Number(busy.has(b.id)) - Number(busy.has(a.id)));
  return (
    <section className="my-section" aria-labelledby="agents-title">
      <h2 id="agents-title">Agents</h2>
      <button type="button" onClick={onRelease}>
        Free up tasks whose time ran out
      </button>
      <div className="list" style={{ marginTop: 12 }}>
        {actors.map((actor) => {
          const tasks = data.tasks.filter((t) => t.claim?.actorId === actor.id);
          const locks = data.locks.filter((l) => l.actorId === actor.id);
          return (
            <article key={actor.id} className="row">
              <strong className="who">
                <Avatar actor={actor} />
                {personName(actor)}
              </strong>
              <div className="meta">
                {actor.kind === "human" ? "Person" : "AI agent"}
                {actor.tool ? ` · ${actor.tool}` : ""}
                {actor.worktree ? ` · ${actor.worktree}` : ""}
              </div>
              {tasks.map((t) => (
                <div key={t.id} className="claim-row">
                  <span>
                    Working on {t.title}
                    {t.claim
                      ? Date.parse(t.claim.leaseUntil) > Date.now()
                        ? ` until ${untilTime(t.claim.leaseUntil)}`
                        : `, time ran out at ${untilTime(t.claim.leaseUntil)}`
                      : ""}
                  </span>
                  <button
                    type="button"
                    aria-label={`Release ${t.title}`}
                    // Only a person ends someone else's live claim; the banner says how.
                    disabled={t.claim !== null && claimRefusal(data, t.claim) !== null}
                    title={(t.claim && claimRefusal(data, t.claim)) ?? undefined}
                    onClick={() => onReleaseTask(t.id)}
                  >
                    Release
                  </button>
                </div>
              ))}
              {locks.map((l) => (
                <div key={l.id} className="meta">
                  {l.mode === "exclusive" ? "Reserved" : "Sharing"} {l.paths.join(", ")} for editing
                  until {untilTime(l.leaseUntil)}
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
    </section>
  );
}
