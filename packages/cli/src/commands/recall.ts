import { type Recall, recall } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute, int } from "../runtime.js";
import { markdown } from "../term.js";

export default defineCommand({
  meta: {
    name: "recall",
    description: "What do we know about…? The best cards, notes, decisions and open tasks",
  },
  args: {
    question: { type: "positional", required: true, description: "A question or a few words" },
    "max-tokens": { type: "string", description: "Cap on the answer (200 to 1000, default 1000)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      ({ ctx }) =>
        recall(ctx, { question: args.question, maxTokens: int(args["max-tokens"], "max-tokens") }),
      (r: Recall) => markdown(r.markdown.trimEnd()),
    ),
});
