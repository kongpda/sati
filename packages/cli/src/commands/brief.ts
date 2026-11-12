import { BRIEF_TOOLS, type Brief, type BriefTools, buildBrief, SatiError } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute } from "../runtime/output.js";
import { markdown } from "../term.js";

export default defineCommand({
  meta: { name: "brief", description: "Session-start summary for agents (Markdown)" },
  args: {
    format: {
      type: "string",
      description: "agent (default) or short, for resumed and compacted sessions",
    },
    tools: {
      type: "string",
      description:
        "What the last line names: cli (default), or mcp when the reader has the MCP tools, as the session-start hook does",
    },
    ...json,
  },
  run: ({ args }) => {
    const tools = (args.tools ?? "cli") as BriefTools;
    if (!BRIEF_TOOLS.includes(tools)) {
      throw new SatiError("USAGE", "--tools must be mcp or cli.");
    }
    return execute(
      args.json,
      ({ ctx }) => buildBrief(ctx, { format: args.format }, tools),
      (b: Brief) => markdown(b.markdown.trimEnd()),
    );
  },
});
