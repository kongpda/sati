import { SEARCHABLE, type SearchHit, SearchInput, search } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { cutNote, hits, withCut } from "../render.js";
import { int, list } from "../runtime/input.js";
import { execute } from "../runtime/output.js";

const DEFAULT_LIMIT = 50;
const SEARCH_MAX = SearchInput.shape.limit.unwrap().maxValue ?? 200;

export default defineCommand({
  meta: {
    name: "search",
    description: "Exact full-text search with filters (--entities, --limit, --any)",
  },
  args: {
    query: { type: "positional", required: true, description: "Words to find" },
    entities: { type: "string", description: `Comma-separated: ${SEARCHABLE.join(",")}` },
    limit: { type: "string", description: "Max results (default 50, max 200)" },
    any: { type: "boolean", description: "Match any word instead of all words" },
    ...json,
  },
  run: ({ args }) => {
    let cut: string | null = null;
    return execute(
      args.json,
      async ({ ctx }) => {
        const limit = int(args.limit, "limit") ?? DEFAULT_LIMIT;
        // Search has no offset: one more hit is asked for. At the maximum that is not allowed,
        // so a full page of SEARCH_MAX hits counts as cut, as the MCP tool does. A limit over the
        // maximum goes to core as given, which refuses it.
        const found = await search(ctx, {
          query: args.query,
          entities: list(args.entities),
          limit: limit < SEARCH_MAX ? limit + 1 : limit,
          match: args.any ? "any" : undefined,
        });
        if (found.length > limit || found.length === SEARCH_MAX) {
          const more =
            limit < SEARCH_MAX
              ? `Use --limit up to ${SEARCH_MAX} for more`
              : "Use more words to narrow the search";
          cut = cutNote(`Showing the first ${limit}. ${more}.`, args.json);
        }
        return found.slice(0, limit);
      },
      (items: SearchHit[]) => withCut(hits(items), cut),
      { readOnly: true },
    );
  },
});
