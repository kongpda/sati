import { type ReactNode, useState } from "react";
import { dueLabel, type Snapshot, type Task, today, waitingOn } from "./api.js";
import { answerRefusal, moveRefusal } from "./moves.js";
import { holderName, knownName } from "./people.js";
import { capital, statusWord } from "./words.js";

const CLOSED = new Set(["done", "cancelled"]);

/** The last day of this week (Sunday) in the reader's time zone, as YYYY-MM-DD. */
export function weekEnd(now = new Date()): string {
  const days = (7 - now.getDay()) % 7;
  return today(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

/** Due soonest first; undated last; then the higher priority. */
const RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
function byDue(a: Task, b: Task): number {
  const left = a.dueDate ?? "9999";
  const right = b.dueDate ?? "9999";
  if (left !== right) return left < right ? -1 : 1;
  return (RANK[a.priority] ?? 9) - (RANK[b.priority] ?? 9);
}

/**
 * The lists a person starts the day with. Each task shows once, in the first list it fits:
 * needs you (an agent asks a question or waits for a permission, or the task is blocked), then
 * waiting for approval (in review), both for tasks assigned to you or to nobody; then assigned to
 * you, then due by Sunday (late ones included), so the same task never asks for attention twice.
 */
export function myWork(data: Snapshot, now = new Date()) {
  const you = data.you;
  const open = data.tasks.filter((t) => !CLOSED.has(t.status));
  const yours = (t: Task) => (t.assigneeIds ?? []).length === 0 || t.assigneeIds?.includes(you);
  const asking = open
    .filter((t) => yours(t) && waitingOn(t, now.getTime()))
    .sort((a, b) => ((a.claim?.waiting?.since ?? "") < (b.claim?.waiting?.since ?? "") ? -1 : 1));
  const blocked = open.filter((t) => yours(t) && t.status === "blocked" && !asking.includes(t));
  const needs = [...asking, ...blocked];
  const shown = new Set(needs.map((t) => t.id));
  const approval = open.filter((t) => !shown.has(t.id) && t.status === "review" && yours(t));
  for (const t of approval) shown.add(t.id);
  const assigned = open.filter((t) => !shown.has(t.id) && t.assigneeIds?.includes(you)).sort(byDue);
  for (const t of assigned) shown.add(t.id);
  const end = weekEnd(now);
  const due = open
    .filter((t) => !shown.has(t.id) && t.dueDate != null && t.dueDate <= end)
    .sort(byDue);
  return { needs, approval, assigned, due, end };
}

export function MyWork({
  data,
  onOpen,
  onApprove,
  onSendBack,
  onAnswered,
}: {
  data: Snapshot;
  onOpen: (id: string) => void;
  onApprove: (task: Task) => Promise<unknown>;
  /** The person answered the agent where it runs; the task stops asking. */
  onAnswered: (task: Task) => Promise<unknown>;
  /** Rejects when refused, so the reason typed stays in the box. */
  onSendBack: (task: Task, reason: string) => Promise<unknown>;
}) {
  const { needs, approval, assigned, due, end } = myWork(data);
  const [y, m, d] = end.split("-").map(Number);
  const sunday = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
  return (
    <div className="page">
      <h1>My work</h1>
      {needs.length ? (
        <Section title="Needs you" count={needs.length} empty="">
          {needs.map((t) => (
            <Needs key={t.id} data={data} task={t} onOpen={onOpen} onAnswered={onAnswered} />
          ))}
        </Section>
      ) : null}
      <Section
        title="Waiting for your approval"
        count={approval.length}
        empty="Nothing to approve."
      >
        {approval.map((t) => (
          <Approval
            key={t.id}
            data={data}
            task={t}
            onOpen={onOpen}
            onApprove={onApprove}
            onSendBack={onSendBack}
          />
        ))}
      </Section>
      <Section
        title="Assigned to you"
        count={assigned.length}
        empty="Nothing is assigned to you. Assign tasks in the task panel or the New task form."
      >
        {assigned.map((t) => (
          <Row key={t.id} data={data} task={t} onOpen={onOpen} />
        ))}
      </Section>
      <Section
        title={`Due by ${sunday}`}
        count={due.length}
        empty={
          // "else" only when tasks above are due this week too; each task shows once.
          approval.length + assigned.length > 0
            ? "Nothing else is due this week."
            : "Nothing is due this week."
        }
      >
        {due.map((t) => (
          <Row key={t.id} data={data} task={t} onOpen={onOpen} />
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="my-section" aria-label={title}>
      <h2>
        {title}
        {count ? <span className="count"> · {count}</span> : null}
      </h2>
      <div className="list">{count ? children : <p className="empty">{empty}</p>}</div>
    </section>
  );
}

/** One task: its title opens the panel; the line under it says where it stands. */
function Row({
  data,
  task,
  onOpen,
  children,
}: {
  data: Snapshot;
  task: Task;
  onOpen: (id: string) => void;
  children?: ReactNode;
}) {
  const feature = data.features.find((f) => f.id === task.featureId)?.title;
  const due = task.dueDate ? dueLabel(task.dueDate, task.status) : null;
  const steps = task.checklist ?? [];
  return (
    <article className="row">
      <button type="button" className="row-link" onClick={() => onOpen(task.id)}>
        {task.title}
      </button>
      <div className="meta">
        {statusWord(task.status)}
        {task.priority === "high" || task.priority === "urgent"
          ? ` · ${capital(task.priority)}`
          : ""}
        {due ? (
          <>
            {" · "}
            <time dateTime={task.dueDate ?? undefined} className={due.late ? "late" : undefined}>
              {due.late ? `late, ${due.text}` : due.text}
            </time>
          </>
        ) : null}
        {feature ? ` · ${feature}` : ""}
        {steps.length ? ` · ${steps.filter((c) => c.done).length}/${steps.length} steps` : ""}
      </div>
      {children}
    </article>
  );
}

/**
 * What an agent waits on a person for, in its own words, and where to answer: in the agent's
 * session, since sati does not pass messages. "Answered" clears it here once that is done.
 */
function Needs({
  data,
  task,
  onOpen,
  onAnswered,
}: {
  data: Snapshot;
  task: Task;
  onOpen: (id: string) => void;
  onAnswered: (task: Task) => Promise<unknown>;
}) {
  const waiting = waitingOn(task);
  const who = holderName(data, task.claim?.actorId);
  // One click at a time: a second request would be refused and shown as an error.
  const [busy, setBusy] = useState(false);
  const refused = answerRefusal(data, task);
  return (
    <Row data={data} task={task} onOpen={onOpen}>
      {waiting ? (
        <>
          <p className="asking">
            <strong>
              {waiting.kind === "permission" ? `${who} needs your permission` : `${who} asks`}
            </strong>
            {/* The agent's text is data: rendered as text, never as Markdown or HTML. */}
            <span className="quote">{waiting.text}</span>
          </p>
          <p className="hint">Answer in {who}'s session, then mark it answered here.</p>
          <div className="approval-actions">
            <button
              type="button"
              aria-label={`${task.title}: I answered`}
              disabled={busy || refused !== null}
              title={refused ?? undefined}
              onClick={() => {
                setBusy(true);
                void onAnswered(task).finally(() => setBusy(false));
              }}
            >
              I answered
            </button>
          </div>
        </>
      ) : (
        <p className="asking">
          <strong>Blocked</strong>
          <span className="quote">{task.blockedReason || "No reason given."}</span>
        </p>
      )}
    </Row>
  );
}

/** A task in review: what was done and by whom, with Approve or Send back (which needs a why). */
function Approval({
  data,
  task,
  onOpen,
  onApprove,
  onSendBack,
}: {
  data: Snapshot;
  task: Task;
  onOpen: (id: string) => void;
  onApprove: (task: Task) => Promise<unknown>;
  onSendBack: (task: Task, reason: string) => Promise<unknown>;
}) {
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const by = task.completion ? knownName(data, task.completion.completedBy) : null;
  const files = task.completion?.filesTouched.length ?? 0;
  const drift = data.drift?.[task.id];
  // Known before the click: an agent-run board cannot approve, and a held task takes no save.
  const noApprove = moveRefusal(data, task, "done");
  const noSendBack = moveRefusal(data, task, "todo");
  return (
    <Row data={data} task={task} onOpen={onOpen}>
      {task.completion ? (
        <p className="summary">
          {by ? `${by}: ` : ""}
          {task.completion.summary}
          {files ? ` (${files} file${files === 1 ? "" : "s"})` : ""}
        </p>
      ) : null}
      {drift?.moved ? (
        <p className="drift" role="note">
          {drift.branch} has new commits since this was sent ({drift.commit.slice(0, 7)} →{" "}
          {drift.head?.slice(0, 7)}). Look at them before you approve.
        </p>
      ) : null}
      {sending ? (
        <form
          className="send-back"
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem("reason");
            if (!(input instanceof HTMLInputElement) || input.value.trim() === "") return;
            onSendBack(task, input.value.trim()).then(
              () => setSending(false),
              () => undefined,
            );
          }}
        >
          <input
            className="field"
            name="reason"
            required
            maxLength={2000}
            aria-label={`Why ${task.title} needs more work`}
            placeholder="What still needs doing"
          />
          <button type="submit">Send back</button>
          <button type="button" onClick={() => setSending(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="primary"
            // The name starts with the visible text, so voice control finds it (WCAG 2.5.3).
            aria-label={`${drift?.moved ? "Approve latest" : "Approve"}: ${task.title}`}
            disabled={busy || noApprove !== null}
            title={noApprove ?? undefined}
            onClick={() => {
              setBusy(true);
              void onApprove(task).finally(() => setBusy(false));
            }}
          >
            {drift?.moved ? "Approve latest" : "Approve"}
          </button>
          <button
            type="button"
            aria-label={`Send back ${task.title}`}
            disabled={noSendBack !== null}
            title={noSendBack ?? undefined}
            onClick={() => setSending(true)}
          >
            Send back…
          </button>
        </div>
      )}
    </Row>
  );
}
