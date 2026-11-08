import type { Actor, Snapshot } from "./api.js";

/** Kept in step with ACTOR_COLORS in core, which validates the choice. */
export const COLORS = ["moss", "teal", "sky", "plum", "rose", "clay", "sun", "slate"] as const;

/**
 * How an actor is shown. A person is their display name, or else the user part of
 * `user@worktree`, so the same person reads the same in every worktree. An agent keeps its
 * identity string (`claude-code@feature-a#1234`): which session it is matters.
 */
export function personName(actor: Pick<Actor, "name" | "kind" | "displayName">): string {
  if (actor.displayName) return actor.displayName;
  if (actor.kind !== "human") return actor.name;
  return actor.name.split("@")[0] || actor.name;
}

/** Built once: a Segmenter is costly to make, and initials render on every card. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** First letters (whole graphemes, so Khmer clusters stay intact) of the first two words. */
export function initialsOf(actor: Pick<Actor, "name" | "kind" | "displayName" | "initials">) {
  if (actor.initials) return actor.initials;
  const base =
    actor.kind === "human" || actor.displayName
      ? personName(actor)
      : (actor.name.split("@")[0] ?? "");
  const words = base.split(/[\s._-]+/u).filter(Boolean);
  const first = (w: string) => GRAPHEMES.segment(w)[Symbol.iterator]().next().value?.segment ?? "";
  return words.slice(0, 2).map(first).join("").toLocaleUpperCase();
}

/** The chosen colour, or one picked from the shown name, so a person's worktrees match. */
export function colorOf(actor: Pick<Actor, "name" | "kind" | "displayName" | "color">): string {
  if (actor.color) return actor.color;
  let hash = 0;
  for (const ch of personName(actor)) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return COLORS[hash % COLORS.length] ?? "moss";
}

/** The shown name of an actor id; records from a teammate's clone may name one not here. */
export function nameOf(data: Snapshot, actorId: string | null | undefined): string {
  const actor = data.actors.find((a) => a.id === actorId);
  return actor ? personName(actor) : "someone";
}

/**
 * A round badge with the initials. Next to the name it is decoration; alone (`label`) it is
 * an image named after the person.
 */
export function Avatar({ actor, label = false }: { actor: Actor; label?: boolean }) {
  const name = personName(actor);
  return (
    <span
      className={`avatar c-${colorOf(actor)}`}
      {...(label ? { role: "img", "aria-label": name, title: name } : { "aria-hidden": true })}
    >
      {initialsOf(actor)}
    </span>
  );
}
