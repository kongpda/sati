import { CLI_NAME, claimNext } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { claimed } from "../render.js";
import { int } from "../runtime/input.js";
import { execute } from "../runtime/output.js";

export default defineCommand({
  meta: {
    name: "next",
    description: `Claim the top ready task (${CLI_NAME} task claim with no id). Never asks; \`${CLI_NAME} task claim\` asks at a terminal when several tasks are ready`,
  },
  args: {
    lease: {
      type: "string",
      description: "Lease length in minutes (default: the project setting)",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const next = await claimNext(ctx, { leaseMinutes: int(args.lease, "lease") });
        return { ...next.task, acceptance: next.acceptance };
      },
      claimed,
    ),
});
