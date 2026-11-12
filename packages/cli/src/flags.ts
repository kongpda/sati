/**
 * Flags kept for old scripts and installed hooks: accepted, but absent from help and completion.
 * Add a flag here when a newer name replaces it (review D8, D9, D24).
 */
export const HIDDEN_FLAGS: Readonly<Record<string, readonly string[]>> = {
  // `sati doctor --reviewed <id>` is the one documented way to clear needsReview (review 7.10).
  "task update": ["reviewed"],
  "feature update": ["reviewed"],
  "note update": ["reviewed"],
  // Old installed hooks print `sati init --upgrade`; `sati upgrade` is the visible form (review 6.3).
  init: ["upgrade"],
  // Replaced by `--md` (review 7.9).
  "feature list": ["format"],
};

/** Flags that take a list by repeating: `--label a --label b` is `--label a,b`. */
export const REPEATABLE: ReadonlySet<string> = new Set(["label", "feature"]);
