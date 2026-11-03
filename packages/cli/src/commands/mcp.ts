import { join } from "node:path";
import { CONFIG_DIR } from "@brain/core";
import { defineCommand } from "citty";
import { openRuntime, printError } from "../runtime.js";

/** Agents write in bursts; export once the burst is over. */
const EXPORT_DEBOUNCE_MS = 2000;

export default defineCommand({
  meta: { name: "mcp", description: "Serve the MCP tools over stdio (started by your agent)" },
  run: async () => {
    try {
      const { ctx, project, location } = await openRuntime();
      // Loaded here so the MCP SDK never slows down the other commands.
      const { serveStdio } = await import("@brain/mcp");
      if (project.mode !== "git") {
        try {
          await serveStdio(ctx);
        } finally {
          await ctx.store.close();
        }
        return;
      }
      // Git mode keeps .brain/ current while the agent works; pre-commit exports again anyway.
      const { afterWrites, exportSnapshot } = await import("@brain/sync");
      const dir = join(location.root, CONFIG_DIR);
      const synced = afterWrites(
        ctx.store,
        EXPORT_DEBOUNCE_MS,
        async () => {
          await exportSnapshot(ctx, dir);
        },
        (err) => printError(err, false),
      );
      try {
        await serveStdio({ ...ctx, store: synced.store });
      } finally {
        await synced.flush();
        await ctx.store.close();
      }
    } catch (err) {
      // stdout belongs to the protocol, so errors go to stderr only.
      process.exitCode = printError(err, false);
    }
  },
});
