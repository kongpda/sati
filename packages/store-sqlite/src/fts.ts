/**
 * Turns free text into a safe FTS5 query. Every term is quoted, so user input can
 * never use FTS operators or column filters. Terms get a prefix match.
 */
export function buildFtsQuery(input: string, match: "all" | "any"): string | undefined {
  const terms = input
    .split(/[\s"]+/u)
    .map((t) => t.replace(/[^\p{L}\p{N}\p{M}_-]/gu, ""))
    .filter((t) => t.length > 0)
    .slice(0, 32)
    .map((t) => `"${t}"*`);
  if (terms.length === 0) return undefined;
  return terms.join(match === "all" ? " " : " OR ");
}
