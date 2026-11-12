import { useEffect, useRef, useState } from "react";
import { type Snapshot, type Task, waitingOn } from "../api.js";
import { Assignees, EffortSelect, PlanSelect } from "../forms.js";
import { Markdown } from "../markdown.js";
import { canTakeOver, claimRefusal, heldByOther, moveTargets, needsReason } from "../moves.js";
import { holderName, nameOf } from "../people.js";
import type { ThreadActions } from "../thread.js";
import { Thread } from "../thread.js";
import { Ago } from "../time.js";
import { capital, fullTime, statusWord, untilTime } from "../words.js";

/** The effort select's value: standard is the default, stored as unset. */
const effortValue = (v: FormDataEntryValue | null) => (v === "light" || v === "deep" ? v : null);

/** The task fields the panel's form edits; the form reloads when one of them changes. */
const fieldsOf = (t: Task | undefined) =>
  JSON.stringify([
    t?.id,
    t?.title,
    t?.body,
    t?.status,
    t?.dueDate ?? null,
    t?.effort ?? null,
    t?.milestoneId ?? null,
    t?.assigneeIds ?? [],
  ]);

/** The same fields as the form reads them, to compare what was typed with a task. */
const valuesOf = (t: Task) => ({
  title: t.title,
  body: t.body,
  status: t.status,
  dueDate: t.dueDate ?? null,
  effort: effortValue(t.effort ?? null),
  milestoneId: t.milestoneId ?? null,
  assigneeIds: t.assigneeIds ?? [],
});

const STATUS_ORDER = ["backlog", "todo", "in_progress", "review", "blocked", "done", "cancelled"];

/** A person approves work in review by moving it to done; done is otherwise read-only here. */
function statusOptions(data: Snapshot, task: Task): string[] {
  const open = new Set([task.status, ...moveTargets(data, task)]);
  return STATUS_ORDER.filter((s) => open.has(s));
}

/** Keep this keyed by task id: it moves focus into the dialog on open and back on close. */
export function TaskSheet({
  data,
  id,
  modal,
  inert,
  onDirty,
  onClose,
  onSave,
  onRelease,
  onTakeOver,
  onDelete,
  onToast,
  thread,
}: {
  data: Snapshot;
  id: string;
  /** False on a wide screen, where the panel sits beside a board that stays usable. */
  modal: boolean;
  /** True while a dialog (search, a form) is open over the panel: it then takes no focus. */
  inert: boolean;
  /** Tells the app whether there are unsaved edits, so leaving can ask first. */
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
  /** Resolves with the saved task; rejects when the save is refused (the reason is already shown). */
  onSave: (id: string, patch: Record<string, unknown>) => Promise<Task>;
  onRelease: (id: string, force: boolean) => void;
  onTakeOver: (id: string) => void;
  onDelete: (id: string, title: string) => void;
  /** Shows a short message, with an Undo button when `undo` is given. */
  onToast: (message: string, undo?: () => void) => void;
  thread: ThreadActions;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const task = data.tasks.find((t) => t.id === id);
  const found = task !== undefined;
  useEffect(() => {
    if (!found) return;
    const previous = document.activeElement;
    heading.current?.focus();
    return () => {
      // After the panel closes, so the board is no longer inert: back to what had focus, or,
      // when that was the body (j/k stepped here) or is gone, to this task's card.
      requestAnimationFrame(() => {
        if (document.querySelector(".sheet")) return; // another task's panel opened instead
        const card = document.querySelector<HTMLElement>(`button[data-task="${id}"]`);
        const back =
          previous instanceof HTMLElement && previous.isConnected && previous !== document.body
            ? previous
            : card;
        back?.focus();
      });
    };
  }, [found, id]);
  // The form reloads only when a field it edits changes, and never while the person is typing
  // in it: an agent's write would otherwise throw their edit away. It then says the task
  // changed, and Save sends only the fields the person changed since the form loaded.
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // The status picked in the form, with the form it was picked in: a reloaded form starts over.
  const [picked, setPicked] = useState<{ form: number; status: string } | null>(null);
  // The body shows rendered until the person chooses to edit it (owner decision, review 6.2).
  const [editingBody, setEditingBody] = useState(false);
  const bodyField = useRef<HTMLTextAreaElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  // Save is disabled while saving, so focus goes back to it only once it is enabled again.
  const refocus = useRef(false);
  useEffect(() => {
    if (saving || !refocus.current) return;
    refocus.current = false;
    saveButton.current?.focus();
  }, [saving]);
  const fields = fieldsOf(task);
  const formKey = useRef({ fields, n: 0, base: task });
  // After a save the snapshot still holds the older task until the refetch lands; reloading
  // from it would flash the old values back and drop focus from Save.
  const older = task !== undefined && task.version < (formKey.current.base?.version ?? 0);
  if (formKey.current.fields !== fields && !dirty && !older) {
    formKey.current = { fields, n: formKey.current.n + 1, base: task };
  }
  const changedElsewhere = dirty && formKey.current.fields !== fields;
  // Typing in the comment box or the new-step box is unsaved work too.
  const [commentDraft, setCommentDraft] = useState(false);
  const [stepDraft, setStepDraft] = useState(false);
  // A task deleted elsewhere takes its unsaved edits with it: nothing is left to ask about.
  const anyDirty = found && (dirty || commentDraft || stepDraft);
  useEffect(() => onDirty(anyDirty), [anyDirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  if (!task) {
    return (
      <aside
        className="sheet"
        role="dialog"
        aria-modal={modal ? "true" : "false"}
        aria-label="Task deleted"
        inert={inert}
      >
        <p role="status">This task was deleted.</p>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </aside>
    );
  }
  const base = formKey.current.base ?? task;
  const feature = data.features.find((f) => f.id === task.featureId);
  // Core refuses every save on a task someone else holds, so the form says so instead of failing.
  const locked = heldByOther(data, task);
  const sendsBack =
    picked !== null && picked.form === formKey.current.n && needsReason(task, picked.status);
  // Someone else's live claim is ended with Take over or Release first, not deleted under them.
  const held =
    task.claim !== null &&
    task.claim.actorId !== data.you &&
    Date.parse(task.claim.leaseUntil) > Date.now();
  return (
    <aside
      className="sheet"
      role="dialog"
      aria-modal={modal ? "true" : "false"}
      aria-labelledby="sheet-title"
      inert={inert}
      data-modal={inert ? "" : undefined}
    >
      <button type="button" onClick={onClose}>
        Close
      </button>
      <h2 id="sheet-title" ref={heading} tabIndex={-1}>
        {task.title}
      </h2>
      <p className="meta sheet-meta">
        {capital(task.priority)} priority{feature ? ` · ${feature.title}` : ""}
        {(task.labels ?? []).map((l) => (
          <span key={l} className="badge">
            {l}
          </span>
        ))}
      </p>
      {task.completion?.summary ? (
        <section className="done-summary" aria-label="What was done">
          <h3>What was done</h3>
          <Markdown source={task.completion.summary} />
        </section>
      ) : null}
      {task.claim ? (
        <ClaimBox
          data={data}
          claim={task.claim}
          takeOver={canTakeOver(task)}
          onRelease={(force) => onRelease(task.id, force)}
          onTakeOver={() => onTakeOver(task.id)}
        />
      ) : null}
      <TaskSignals data={data} task={task} />
      {changedElsewhere ? (
        <p className="banner" role="status">
          This task changed while you were editing. Save keeps your changes to the fields you
          edited;{" "}
          <button type="button" className="link" onClick={() => setDirty(false)}>
            discard yours and reload
          </button>
          .
        </p>
      ) : null}
      <form
        key={formKey.current.n}
        onInput={() => setDirty(true)}
        onSubmit={(e) => {
          e.preventDefault();
          if (saving) return;
          const form = new FormData(e.currentTarget);
          const sameList = (a: readonly string[], b: readonly string[]) =>
            a.length === b.length && a.every((x) => b.includes(x));
          const typed = {
            title: String(form.get("title") ?? ""),
            // The body field is there only while it is being edited.
            body: form.has("body") ? String(form.get("body")) : base.body,
            status: String(form.get("status") ?? base.status),
            dueDate: String(form.get("dueDate") ?? "") || null,
            effort: effortValue(form.get("effort")),
            milestoneId: form.has("milestoneId")
              ? String(form.get("milestoneId")) || null
              : (base.milestoneId ?? null),
            assigneeIds: form.getAll("assigneeIds").map(String),
          };
          const was = valuesOf(base);
          const now = valuesOf(task);
          const same = (a: unknown, b: unknown) =>
            Array.isArray(a) && Array.isArray(b) ? sameList(a, b) : a === b;
          // Only what the person changed since the form loaded: a field an agent changed
          // meanwhile keeps the agent's value, and old tasks keep their shape.
          const patch: Record<string, unknown> = {};
          let clash = false;
          for (const key of Object.keys(typed) as (keyof typeof typed)[]) {
            const mine = typed[key];
            if (same(mine, was[key])) continue;
            patch[key] = mine;
            if (!same(was[key], now[key])) clash = true;
          }
          if (Object.keys(patch).length === 0) {
            setDirty(false);
            return;
          }
          if (typeof patch.status === "string" && needsReason(task, patch.status)) {
            patch.reason = String(form.get("reason") ?? "").trim();
          }
          setSaving(true);
          // Both changed the same field: the version the form loaded makes the server refuse
          // it, so neither edit is lost without a word.
          void onSave(task.id, { ...patch, expectedVersion: clash ? base.version : task.version })
            .then((saved) => {
              // The saved task is the new baseline before the refetch lands, so it does not
              // look like a change made elsewhere. The form reloads only when it shows a
              // field that differs from what was saved (another writer's change).
              const after = valuesOf(saved);
              const stale = (Object.keys(typed) as (keyof typeof typed)[]).some(
                (key) => !same(typed[key], after[key]),
              );
              formKey.current = {
                fields: fieldsOf(saved),
                n: formKey.current.n + (stale ? 1 : 0),
                base: saved,
              };
              setDirty(false);
              setEditingBody(false);
              setPicked(null);
              onToast("Saved");
              refocus.current = true;
            })
            .catch(() => undefined)
            .finally(() => setSaving(false));
        }}
      >
        <fieldset className="sheet-lock" disabled={locked}>
          <input
            className="field"
            name="title"
            defaultValue={task.title}
            aria-label="Title"
            required
            maxLength={300}
          />
          <div className="sheet-details">
            <h3>Details</h3>
            {editingBody || !task.body.trim() ? (
              <textarea
                ref={bodyField}
                className="field"
                name="body"
                rows={8}
                defaultValue={task.body}
                aria-label="Body"
              />
            ) : (
              <>
                <Markdown source={task.body} />
                <button
                  type="button"
                  onClick={() => {
                    setEditingBody(true);
                    requestAnimationFrame(() => bodyField.current?.focus());
                  }}
                >
                  Edit details
                </button>
              </>
            )}
          </div>
          <label className="sheet-label">
            Due date
            <input className="field" type="date" name="dueDate" defaultValue={task.dueDate ?? ""} />
          </label>
          <EffortSelect className="sheet-label" chosen={task.effort ?? null} />
          {data.milestones.length > 0 ? (
            <PlanSelect className="sheet-label" data={data} chosen={task.milestoneId ?? null} />
          ) : null}
          <Assignees data={data} chosen={task.assigneeIds ?? []} />
          <label className="sheet-label sheet-status">
            Status
            <select
              name="status"
              defaultValue={task.status}
              onChange={(e) =>
                setPicked({ form: formKey.current.n, status: e.currentTarget.value })
              }
            >
              {statusOptions(data, task).map((s) => (
                <option key={s} value={s}>
                  {statusWord(s)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary" disabled={saving} ref={saveButton}>
            {saving ? "Saving…" : "Save"}
          </button>
          {sendsBack ? (
            <label className="sheet-label">
              What still needs doing
              <input className="field" name="reason" required maxLength={2000} />
            </label>
          ) : null}
        </fieldset>
      </form>
      <fieldset className="bare" disabled={locked}>
        <Checklist
          version={task.version}
          items={task.checklist ?? []}
          onChange={(checklist, expectedVersion) => onSave(task.id, { checklist, expectedVersion })}
          onDraft={setStepDraft}
          onRemoved={(text, undo) => onToast(`Removed the step ${text}.`, undo)}
        />
      </fieldset>
      {feature && feature.acceptance.length > 0 ? (
        <>
          <h3>Acceptance</h3>
          <ul>
            {feature.acceptance.map((item, i) => (
              // Two lines may read the same; the position tells them apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: plain text lines have no ids
              <li key={`${i}:${item}`}>{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      <Thread data={data} on={task.id} {...thread} onDraft={setCommentDraft} />
      {held ? null : (
        <button
          type="button"
          className="danger sheet-delete"
          onClick={() => onDelete(task.id, task.title)}
        >
          Delete task
        </button>
      )}
    </aside>
  );
}

/** An actor's name; actors are machine-local, so a record from a teammate's clone carries a fallback. */
const nameOr = (data: Snapshot, id: string, fallback: string | undefined) =>
  data.actors.some((a) => a.id === id) ? nameOf(data, id) : (fallback ?? "someone");

/**
 * What the task waits on and what came with it: the agent's question, why it is blocked, the
 * handoff left on it, and whether its branch moved after it was sent for approval. Agent text
 * here is rendered as plain text, never as Markdown, because it is data. (The task body and
 * the completion summary above are Markdown, through a renderer that never parses HTML.)
 */
function TaskSignals({ data, task }: { data: Snapshot; task: Task }) {
  const waiting = waitingOn(task);
  const who = holderName(data, task.claim?.actorId);
  const handoff = data.notes.find((n) => n.tags.includes("handoff") && n.links.includes(task.id));
  const drift = data.drift?.[task.id];
  if (!waiting && !(task.status === "blocked") && !handoff && !drift?.moved) return null;
  return (
    <section className="signals" aria-label="What this task waits on">
      {waiting ? (
        <p className="asking">
          <strong>
            {waiting.kind === "permission" ? `${who} needs your permission` : `${who} asks`}
          </strong>
          <span className="quote">{waiting.text}</span>
        </p>
      ) : null}
      {task.status === "blocked" ? (
        <p className="asking">
          <strong>Blocked</strong>
          <span className="quote">{task.blockedReason || "No reason given."}</span>
        </p>
      ) : null}
      {drift?.moved ? (
        <p className="drift" role="note">
          {drift.branch} has new commits since this was sent ({drift.commit.slice(0, 7)} →{" "}
          {drift.head?.slice(0, 7)}).
        </p>
      ) : null}
      {handoff ? (
        <p className="handoff">
          <strong>
            Handoff from {nameOr(data, handoff.createdBy, handoff.handoffFromName)}
            {handoff.handoffTo
              ? ` for ${nameOr(data, handoff.handoffTo, handoff.handoffToName)}`
              : ""}
          </strong>
          <span className="meta">
            {handoff.acknowledged ? (
              <>
                {` · read by ${nameOf(data, handoff.acknowledged.by)} `}
                <Ago iso={handoff.acknowledged.at} />
              </>
            ) : (
              " · not read yet"
            )}
          </span>
        </p>
      ) : null}
    </section>
  );
}

/**
 * The task's steps. Each tick, add or remove saves at once with the task's version, so a step an
 * agent ticked meanwhile is refused instead of unticked.
 */
function Checklist({
  version,
  items,
  onChange,
  onDraft,
  onRemoved,
}: {
  version: number;
  items: { text: string; done: boolean }[];
  onChange: (
    items: { text: string; done: boolean }[],
    expectedVersion: number,
  ) => Promise<{ version: number }>;
  /** Whether a step is typed but not added, so leaving can ask first. */
  onDraft: (typed: boolean) => void;
  /** A step was removed; `undo` puts it back where it was. */
  onRemoved: (text: string, undo: () => void) => void;
}) {
  // Shown at once; a refused save puts back what the server has. A new version (a save from
  // here or anywhere) resets it to the server's list without remounting, so focus stays put.
  const [shown, setShown] = useState(items);
  // Saves waiting or running: the list on screen is ahead of the server's, so a version that
  // arrives meanwhile must not reset it (the ticks would flicker back, then forward).
  const pending = useRef(0);
  const [settled, setSettled] = useState(0);
  // Quick ticks run one after another, each with the version the last save returned; sent
  // together, the second would carry a stale version and be refused.
  const latest = useRef(version);
  // biome-ignore lint/correctness/useExhaustiveDependencies: items is new on every snapshot; the version says when it changed
  useEffect(() => {
    // A save that just settled can come before the snapshot it made: the old list would bring
    // a removed step back for a moment, and Undo would then add it a second time.
    if (pending.current === 0 && version >= latest.current) setShown(items);
  }, [version, settled]);
  // The list as last saved: a refused tick goes back to it, not to the list of the render it
  // was clicked in, which misses ticks saved since.
  const saved = useRef(items);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // biome-ignore lint/correctness/useExhaustiveDependencies: items is new on every snapshot; the version says when it changed
  useEffect(() => {
    latest.current = Math.max(latest.current, version);
    saved.current = items;
  }, [version]);
  const change = (next: typeof items) => {
    setShown(next);
    pending.current++;
    queue.current = queue.current.then(() =>
      onChange(next, latest.current)
        .then(
          (result) => {
            latest.current = result.version;
            saved.current = next;
          },
          () => setShown(saved.current),
        )
        .finally(() => {
          pending.current--;
          // Take the server's list once the last save is in, for what arrived meanwhile.
          if (pending.current === 0) setSettled((n) => n + 1);
        }),
    );
  };
  // Undo runs after later renders, so it needs the list on screen then, not at the removal.
  const current = useRef(shown);
  current.current = shown;
  const done = shown.filter((c) => c.done).length;
  return (
    <section className="checklist" aria-labelledby="checklist-title">
      <h3 id="checklist-title">Checklist{shown.length ? ` · ${done}/${shown.length}` : ""}</h3>
      <ul>
        {shown.map((c, i) => (
          // Steps have no ids; the position is what a person and the CLI refer to.
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are addressed by position
          <li key={i}>
            <label>
              <input
                type="checkbox"
                checked={c.done}
                onChange={() =>
                  change(shown.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))
                }
              />
              <span className={c.done ? "done" : undefined}>{c.text}</span>
            </label>
            <button
              type="button"
              aria-label={`Remove step ${c.text}`}
              onClick={() => {
                change(shown.filter((_, j) => j !== i));
                onRemoved(c.text, () => {
                  const list = current.current;
                  change([...list.slice(0, i), c, ...list.slice(i)]);
                });
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="checklist-add"
        onInput={(e) => {
          const step = e.currentTarget.elements.namedItem("step");
          onDraft(step instanceof HTMLInputElement && step.value.trim() !== "");
        }}
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("step");
          if (!(input instanceof HTMLInputElement) || input.value.trim() === "") return;
          change([...shown, { text: input.value.trim(), done: false }]);
          input.value = "";
          onDraft(false);
        }}
      >
        <input
          className="field"
          name="step"
          maxLength={300}
          aria-label="New step"
          placeholder="Add a step"
        />
        <button type="submit">Add</button>
      </form>
    </section>
  );
}

/**
 * Who is working on the task, in plain words, with the way out: the holder releases it; anyone
 * else may take it over or release it, which ends the holder's claim, so it asks first.
 */
function ClaimBox({
  data,
  claim,
  takeOver,
  onRelease,
  onTakeOver,
}: {
  data: Snapshot;
  claim: { actorId: string; leaseUntil: string };
  /** False where the task cannot be claimed again (blocked, in review): then only Release ends it. */
  takeOver: boolean;
  onRelease: (force: boolean) => void;
  onTakeOver: () => void;
}) {
  const mine = claim.actorId === data.you;
  const name = holderName(data, claim.actorId);
  const live = Date.parse(claim.leaseUntil) > Date.now();
  const until = (
    <time dateTime={claim.leaseUntil} title={fullTime(claim.leaseUntil)}>
      {untilTime(claim.leaseUntil)}
    </time>
  );
  // Core lets only a person end someone else's live claim; a claim that ran out is anyone's.
  const agentOnly = claimRefusal(data, claim);
  const confirmed = (action: string) =>
    !live ||
    window.confirm(
      `${action} from ${name}? They stop working on it, and their next save will be refused.`,
    );
  return (
    <section className="claim" aria-label="Who is working on this">
      <p>
        {live ? `${mine ? "You are" : `${name} is`} working on this until ` : ""}
        {live ? null : `${mine ? "Your" : `${name}'s`} time on this ran out at `}
        {until}.
      </p>
      {mine ? null : (
        <p className="claim-note">
          It cannot be changed here until {name} releases it
          {agentOnly ? "." : takeOver ? " or you take it over." : " or you release it."}
          {agentOnly ? ` Only a person can take it from them. ${agentOnly}` : ""}
        </p>
      )}
      {agentOnly ? null : (
        <div className="claim-actions">
          {mine || !takeOver ? null : (
            <button type="button" onClick={() => confirmed("Take this over") && onTakeOver()}>
              Take over
            </button>
          )}
          <button
            type="button"
            onClick={() => (mine || confirmed("Release this")) && onRelease(!mine)}
          >
            Release
          </button>
        </div>
      )}
    </section>
  );
}
