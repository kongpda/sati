import { CLI_NAME, claimNext, type Task } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { row } from "../render.js";
import { execute, int } from "../runtime.js";

export default defineCommand({
  meta: {
    name: "next",
    description: `Claim the top ready task (${CLI_NAME} task claim with no id)`,
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
      (t: Task & { acceptance?: string[] }) =>
        `Claimed ${row(t)} until ${t.claim?.leaseUntil}, token ${t.claim?.token}${
          t.acceptance?.length ? `\n${t.acceptance.map((line) => `- ${line}`).join("\n")}` : ""
        }`,
    ),
});
