import { useState } from "react";
import { type Actor, api, type Snapshot } from "./api.js";
import { FormDialog } from "./forms.js";
import { Avatar, COLORS, colorOf, initialsOf, personName } from "./people.js";

const COLOR_NAMES: Record<string, string> = {
  moss: "Moss",
  teal: "Teal",
  sky: "Sky",
  plum: "Plum",
  rose: "Rose",
  clay: "Clay",
  sun: "Amber",
  slate: "Slate",
};

/** The folder an actor works in, in words: the worktree's last part. */
function place(actor: Actor): string {
  const parts = (actor.worktree ?? "").split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? "this folder";
}

/** Settings: how the people on this project are shown. Agents keep their session names. */
export function Settings({
  data,
  onSaved,
}: {
  data: Snapshot;
  onSaved: (message: string) => void;
}) {
  const [editing, setEditing] = useState<Actor | null>(null);
  const people = data.actors
    .filter((a) => a.kind === "human")
    .sort((a, b) => Number(b.id === data.you) - Number(a.id === data.you));
  return (
    <div className="page">
      <h1>Settings</h1>
      <section className="my-section" aria-labelledby="people-title">
        <h2 id="people-title">People</h2>
        <p className="dialog-note">
          The name, initials and colour shown for each person on the board. Agents are shown by
          their session name.
        </p>
        <div className="list">
          {people.map((p) => (
            <article key={p.id} className="row person">
              <Avatar actor={p} />
              <div>
                <h3 className="row-title">
                  {personName(p)}
                  {p.id === data.you ? " (you)" : ""}
                </h3>
                <div className="meta">Works in {place(p)}</div>
              </div>
              <button
                type="button"
                aria-label={`Edit ${personName(p)}`}
                onClick={() => setEditing(p)}
              >
                Edit
              </button>
            </article>
          ))}
          {people.length === 0 ? <p className="empty">No people yet.</p> : null}
        </div>
      </section>
      {editing ? (
        <PersonForm
          person={editing}
          onClose={() => setEditing(null)}
          onSaved={(p) => {
            setEditing(null);
            onSaved(`Saved ${personName(p)}.`);
          }}
        />
      ) : null}
    </div>
  );
}

/** Blank fields fall back to the defaults shown as placeholders, so clearing one resets it. */
function PersonForm({
  person,
  onClose,
  onSaved,
}: {
  person: Actor;
  onClose: () => void;
  onSaved: (person: Actor) => void;
}) {
  const [opened] = useState(person);
  const auto = { ...opened, displayName: undefined, initials: undefined, color: undefined };
  const [preview, setPreview] = useState({
    displayName: opened.displayName ?? "",
    initials: opened.initials ?? "",
    color: opened.color ?? "",
  });
  const shown = {
    ...opened,
    displayName: preview.displayName.trim() || undefined,
    initials: preview.initials.trim() || undefined,
    color: preview.color || undefined,
  };
  return (
    <FormDialog
      title="Edit person"
      submit="Save"
      busy="Saving…"
      onClose={onClose}
      onSubmit={(form) => {
        const value = (k: string) => String(form.get(k) ?? "").trim() || null;
        return api
          .patchProfile(opened.id, {
            displayName: value("displayName"),
            initials: value("initials"),
            color: value("color"),
          })
          .then(onSaved);
      }}
    >
      <div className="person-preview" aria-hidden="true">
        <Avatar actor={shown} />
        {personName(shown)}
      </div>
      <div className="dialog-row">
        <label>
          Display name
          <input
            className="field"
            name="displayName"
            maxLength={80}
            defaultValue={opened.displayName}
            placeholder={personName(auto)}
            onChange={(e) => setPreview((p) => ({ ...p, displayName: e.target.value }))}
          />
        </label>
        <label>
          Initials
          <input
            className="field"
            name="initials"
            maxLength={8}
            defaultValue={opened.initials}
            placeholder={initialsOf({ ...auto, displayName: shown.displayName })}
            onChange={(e) => setPreview((p) => ({ ...p, initials: e.target.value }))}
          />
        </label>
      </div>
      <fieldset className="dialog-choices swatches">
        <legend>Colour</legend>
        <label>
          <input
            type="radio"
            name="color"
            value=""
            defaultChecked={!opened.color}
            onChange={() => setPreview((p) => ({ ...p, color: "" }))}
          />
          <span className={`swatch c-${colorOf({ ...auto, displayName: shown.displayName })}`} />
          Automatic
        </label>
        {COLORS.map((c) => (
          <label key={c}>
            <input
              type="radio"
              name="color"
              value={c}
              defaultChecked={opened.color === c}
              onChange={() => setPreview((p) => ({ ...p, color: c }))}
            />
            <span className={`swatch c-${c}`} />
            {COLOR_NAMES[c] ?? c}
          </label>
        ))}
      </fieldset>
    </FormDialog>
  );
}
