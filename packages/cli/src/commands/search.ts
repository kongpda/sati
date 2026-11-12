import { SEARCHABLE, type SearchHit, search } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { hits } from "../render.js";
import { int, list } from "../runtime/input.js";
import { execute } from "../runtime/output.js";

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
  run: ({ args }) =>
    execute(
      args.json,
      ({ ctx }) =>
        search(ctx, {
          query: args.query,
          entities: list(args.entities),
          limit: int(args.limit, "limit"),
          match: args.any ? "any" : undefined,
        }),
      (items: SearchHit[]) => hits(items),
      { readOnly: true },
    ),
});
