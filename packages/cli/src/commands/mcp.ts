import { join } from "node:path";
import { CONFIG_DIR, readSettings } from "@sati/core";
import { defineCommand } from "citty";
import pkg from "../../package.json" with { type: "json" };
import { openRuntime, printError, processProbe } from "../runtime.js";
import { readTemplateFiles } from "../templates.js";

/** Agents write in bursts; export once the burst is over. */
const EXPORT_DEBOUNCE_MS = 2000;

export default defineCommand({
  meta: { name: "mcp", description: "Serve the MCP tools over stdio (started by your agent)" },
  run: async () => {
    try {
      const rt = await openRuntime();
      const { project, location } = rt;
      // The MCP server lives as long as the agent session, so its claims name it as the holder.
      const ctx = { ...rt.ctx, processes: processProbe(true) };
      // Loaded here so the MCP SDK never slows down the other commands.
      const { serveStdio } = await import("@sati/mcp");
      const { kind } = readSettings(project.settings);
      const templates = () => readTemplateFiles(location.root);
      if (project.mode !== "git") {
        try {
          await serveStdio(ctx, pkg.version, kind, location.root, templates);
        } finally {
          await ctx.store.close();
        }
        return;
      }
      // Git mode keeps .sati/ current while the agent works; pre-commit exports again anyway.
      const { afterWrites, exportSnapshot } = await import("@sati/sync");
      const dir = join(location.root, CONFIG_DIR);
      const synced = afterWrites(
        ctx.store,
        EXPORT_DEBOUNCE_MS,
        async (written) => {
          await exportSnapshot(ctx, dir, { only: written });
        },
        (err) => printError(err, false),
      );
      try {
        await serveStdio(
          { ...ctx, store: synced.store },
          pkg.version,
          kind,
          location.root,
          templates,
        );
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
