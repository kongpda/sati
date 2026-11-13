import { useState } from "react";
import { api, type ProjectKind, type ReviewMode, type Snapshot } from "./api.js";
import { personOnly } from "./moves.js";

const KINDS: [ProjectKind, string, string][] = [
  [
    "code",
    "Software project",
    "Tasks, notes and plans, plus features, file reservations and the commit guard.",
  ],
  [
    "general",
    "General project",
    "Tasks, notes and plans only, for events, marketing or office work. Features and the agents section of the Team page are hidden.",
  ],
];

const REVIEWS: [ReviewMode, string, string][] = [
  ["agents", "Agents' work waits", "Agents' finished tasks wait for a person."],
  ["all", "Everyone's work waits", "Everyone's finished tasks wait."],
  ["none", "Nothing waits", "Nothing waits: tasks go straight to Done."],
];

/** Settings: the project kind and the review mode. */
export function Settings({
  data,
  onSaved,
  onError,
}: {
  data: Snapshot;
  /** Resolves when the board has reloaded. */
  onSaved: (message: string) => Promise<void>;
  onError: (err: unknown) => void;
}) {
  const kind = data.project?.kind ?? "code";
  const [saving, setSaving] = useState<ProjectKind | null>(null);
  const review = data.project?.review ?? "agents";
  const [savingReview, setSavingReview] = useState<ReviewMode | null>(null);
  // Only a person changes who may approve; an agent's board shows it and says why not.
  const reviewRefusal = personOnly(data);
  return (
    <div className="page">
      <h1>Settings</h1>
      <section className="my-section" aria-labelledby="kind-title">
        <h2 id="kind-title">Project kind</h2>
        {/* Busy, not disabled: disabling it took focus off the radio just chosen. */}
        <fieldset className="kind-choices" aria-busy={saving !== null}>
          <legend className="dialog-note">
            What this project is for. Agents see the matching tools the next time they start.
          </legend>
          {KINDS.map(([value, label, hint]) => (
            <label
              key={value}
              className={(saving ?? kind) === value ? "kind-option chosen" : "kind-option"}
            >
              <input
                className="kind-radio"
                type="radio"
                name="kind"
                value={value}
                checked={(saving ?? kind) === value}
                onChange={() => {
                  // One change at a time; the radio stays on the choice being saved.
                  if (saving !== null) return;
                  setSaving(value);
                  api
                    .setKind(value)
                    // The choice stays shown until the board has reloaded, so the old kind
                    // does not show for a moment. It is cleared even when the reload fails:
                    // waiting for the new kind to arrive left the radios locked for good.
                    .then(() => onSaved(`This is now a ${label.toLowerCase()}.`))
                    .catch(onError)
                    .finally(() => setSaving(null));
                }}
              />
              <span>
                <strong>{label}</strong>
                <span className="meta">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>
      <section className="my-section" aria-labelledby="review-title">
        <h2 id="review-title">Review</h2>
        <fieldset className="kind-choices" aria-busy={savingReview !== null}>
          <legend className="dialog-note">
            Who needs a person's approval before a task counts as Done.
            {reviewRefusal ? ` ${reviewRefusal}` : ""}
          </legend>
          {REVIEWS.map(([value, label, hint]) => (
            <label
              key={value}
              className={(savingReview ?? review) === value ? "kind-option chosen" : "kind-option"}
            >
              <input
                className="kind-radio"
                type="radio"
                name="review"
                value={value}
                disabled={reviewRefusal !== null}
                checked={(savingReview ?? review) === value}
                onChange={() => {
                  if (savingReview !== null) return;
                  setSavingReview(value);
                  api
                    .setReview(value)
                    .then(() => onSaved(`Review mode is now: ${label}.`))
                    .catch(onError)
                    .finally(() => setSavingReview(null));
                }}
              />
              <span>
                <strong>{label}</strong>
                <span className="meta">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>
    </div>
  );
}
