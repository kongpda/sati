/**
 * Turns free text into a safe FTS5 query. Every term is quoted, so user input can
 * never use FTS operators or column filters. Terms get a prefix match.
 *
 * Punctuation inside a word becomes a space, so the word is a phrase of the same tokens the
 * index holds: the tokenizer stores `v1.2` as `v1` `2`, and the phrase `"v1 2"*` finds exactly
 * that (dropping the dot searched `v12`, which matched nothing).
 */
export function buildFtsQuery(input: string, match: "all" | "any"): string | undefined {
  const terms = input
    .split(/[\s"]+/u)
    .map((t) => t.replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim())
    .filter((t) => t.length > 0)
    .slice(0, 32)
    .map((t) => `"${t}"*`);
  if (terms.length === 0) return undefined;
  return terms.join(match === "all" ? " " : " OR ");
}
