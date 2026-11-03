import { type Brief, buildBrief } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute } from "../runtime.js";

export default defineCommand({
  meta: { name: "brief", description: "Session-start summary for agents (Markdown)" },
  args: {
    format: {
      type: "string",
      description: "agent (default) or short, for resumed and compacted sessions",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      ({ ctx }) => buildBrief(ctx, { format: args.format }),
      (b: Brief) => b.markdown.trimEnd(),
    ),
});
