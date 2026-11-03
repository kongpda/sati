import { defineCommand } from "citty";
import { openRuntime, printError } from "../runtime.js";

export default defineCommand({
  meta: { name: "mcp", description: "Serve the MCP tools over stdio (started by your agent)" },
  run: async () => {
    try {
      const { ctx } = await openRuntime();
      // Loaded here so the MCP SDK never slows down the other commands.
      const { serveStdio } = await import("@brain/mcp");
      try {
        await serveStdio(ctx);
      } finally {
        await ctx.store.close();
      }
    } catch (err) {
      // stdout belongs to the protocol, so errors go to stderr only.
      process.exitCode = printError(err, false);
    }
  },
});
