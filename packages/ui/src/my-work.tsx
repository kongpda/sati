import { type ReactNode, useState } from "react";
import { inboxCount as count, inboxOf } from "../../core/src/domain/inbox.js";
import { dueLabel, type Note, parentKind, type Snapshot, type Task, waitingOn } from "./api.js";
import { answerRefusal, moveRefusal } from "./moves.js";
import { holderName, knownName, nameOf, personName } from "./people.js";
import { capital, statusWord, waitingForYou } from "./words.js";

/** How many things wait for you: the number next to "My work". Assigned and due tasks are plans, not calls. */
export function inboxCount(data: Snapshot, now?: Date): number {
  return count(myWork(data, now));
}

/**
 * The lists a person starts the day with: needs you, mentions, waiting for approval, assigned to
 * you and due by Sunday. The rule is `inboxOf` in the core, which `sati inbox` and the MCP
 * `inbox` tool call too, so the terminal and this page show the same items.
 */
export function myWork(data: Snapshot, now?: Date) {
  // The tab title and the page ask for the same lists of one snapshot: work them out once.
  // A given `now` is a test or a what-if, and is never cached.
  if (now) return workOut(data, now);
  const known = worked.get(data);
  if (known) return known;
  const lists = workOut(data, new Date());
  worked.set(data, lists);
  return lists;
}

const worked = new WeakMap<Snapshot, ReturnType<typeof workOut>>();

function workOut(data: Snapshot, now: Date) {
  // A person's shown name is the user part of `user@worktree`: the name they are called by.
  const actors = (data.actors ?? []).map((a) => ({ ...a, displayName: personName(a) }));
  return inboxOf({ you: data.you, tasks: data.tasks, notes: data.notes, actors }, now);
}

export function MyWork({
  data,
  onOpen,
  onGo,
  onApprove,
  onSendBack,
  onAnswered,
}: {
  data: Snapshot;
  onOpen: (id: string) => void;
  /** Go to another page of the board without loading it again. */
  onGo: (page: string) => void;
  onApprove: (task: Task) => Promise<unknown>;
  /** The person answered the agent where it runs; the task stops asking. */
  onAnswered: (task: Task) => Promise<unknown>;
  /** Rejects when refused, so the reason typed stays in the box. */
  onSendBack: (task: Task, reason: string) => Promise<unknown>;
}) {
  const { needs, approval, assigned, due, end, mentions } = myWork(data);
  const [y, m, d] = end.split("-").map(Number);
  const sunday = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
  return (
    <div className="page">
      <h1>My work</h1>
      {needs.length + mentions.length + approval.length + assigned.length + due.length === 0 ? (
        <p className="empty">Nothing waits for you.</p>
      ) : null}
      {needs.length ? (
        <Section title="Needs you" count={needs.length} empty="">
          {needs.map((t) => (
            <Needs key={t.id} data={data} task={t} onOpen={onOpen} onAnswered={onAnswered} />
          ))}
        </Section>
      ) : null}
      {mentions.length ? (
        <Section title="Mentions" count={mentions.length} empty="">
          {mentions.map((n) => (
            <Mention key={n.id} data={data} note={n} onOpen={onOpen} onGo={onGo} />
          ))}
        </Section>
      ) : null}
      <Section title={waitingForYou()} count={approval.length} empty="Nothing to approve.">
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

/** A comment that names you: who wrote it, on what, and its text. Replying there clears it. */
function Mention({
  data,
  note,
  onOpen,
  onGo,
}: {
  data: Snapshot;
  note: Note;
  onOpen: (id: string) => void;
  onGo: (page: string) => void;
}) {
  const on = note.links[0] ?? "";
  const task = data.tasks.find((t) => t.id === on);
  const other =
    data.notes.find((n) => n.id === on)?.title ?? data.decisions.find((d) => d.id === on)?.title;
  const page = parentKind(data, on) === "decision" ? "/knowledge?kind=decisions" : "/knowledge";
  return (
    <article className="row">
      {task ? (
        <button type="button" className="row-link" onClick={() => onOpen(task.id)}>
          {task.title}
        </button>
      ) : (
        <a
          className="row-link"
          href={page}
          onClick={(e) => {
            // A plain link reloaded the whole board and dropped the live stream.
            e.preventDefault();
            onGo(page);
          }}
        >
          {other ?? "A record"}
        </a>
      )}
      <p className="asking">
        <strong>{nameOf(data, note.createdBy)} mentioned you</strong>
        {/* A comment is data: shown as text here; the thread renders it in full. */}
        <span className="quote">{note.body}</span>
      </p>
      <p className="hint">Reply in the comments there and it leaves this list.</p>
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
