import { CHANGE_FORMATS, type Changes, formatChanges, listChanges, parseInput } from "@sati/core";
import { defineCommand } from "citty";
import { z } from "zod";
import { json } from "../args.js";
import { actorRef, execute } from "../runtime.js";

const Format = z.enum(CHANGE_FORMATS).default("plain");

export default defineCommand({
  meta: {
    name: "changes",
    description: "What changed: done tasks, features, decisions, notes; as a changelog or digest",
  },
  args: {
    since: {
      type: "string",
      description: "2026-11-01, 24h, 7d (default), 2w, last-session, or a done milestone",
    },
    milestone: { type: "string", description: "Only what belongs to this milestone" },
    actor: { type: "string", description: "Only what this person or agent did (id or name)" },
    format: {
      type: "string",
      description: "plain (default), changelog (Markdown) or digest (to paste into chat)",
    },
    ...json,
  },
  run: ({ args }) => {
    let format: z.infer<typeof Format> = "plain";
    return execute(
      args.json,
      async ({ ctx }) => {
        format = parseInput(Format, args.format);
        return listChanges(ctx, {
          since: args.since,
          milestoneId: args.milestone,
          actorId: await actorRef(ctx, args.actor),
        });
      },
      (c: Changes) => formatChanges(c, format).trimEnd(),
    );
  },
});
