import { type SearchHit, search } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { hits } from "../render.js";
import { execute, int, list } from "../runtime.js";

export default defineCommand({
  meta: {
    name: "search",
    description: "Full-text search across tasks, features, notes and decisions",
  },
  args: {
    query: { type: "positional", required: true, description: "Words to find" },
    entities: { type: "string", description: "Comma-separated: task,feature,note,decision" },
    limit: { type: "string", description: "Max results (default 50)" },
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
    ),
});
