import { join } from "node:path";
import { adoptClaims, CONFIG_DIR, readSettings, type ServiceContext } from "@sati/core";
import { defineCommand } from "citty";
import pkg from "../../package.json" with { type: "json" };
import { exportWritten, openRuntime, printError, processProbe } from "../runtime.js";
import { readTemplateFiles } from "../templates.js";

/**
 * Each write exports only what it touched, so one full export before serving repairs anything an
 * earlier process could not write (a crash inside the debounce window, a failed export). It runs
 * before any write can race it, and imports first: a teammate's edit that no git hook loaded
 * (stash pop, cherry-pick, `git apply`) reaches the database now, not at the next hook. A refused
 * import skips the export, so a snapshot that cannot be read is not built on.
 */
async function syncAtStart(ctx: ServiceContext, dir: string): Promise<void> {
  const { exportSnapshot, importSnapshot, refusedError } = await import("@sati/sync");
  const { problems } = await importSnapshot(ctx, dir);
  for (const p of problems) process.stderr.write(`warning: ${p}\n`);
  const { refused } = await exportSnapshot(ctx, dir);
  if (refused.length > 0) printError(refusedError(refused), false);
}

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
      // A reloaded server takes over the claims its exited predecessor held for this actor.
      const adopt = (c: typeof ctx) =>
        adoptClaims(c).catch((err: unknown) => printError(err, false));
      // Loaded here so the MCP SDK never slows down the other commands.
      const { serveStdio } = await import("@sati/mcp");
      const { kind } = readSettings(project.settings);
      const templates = () => readTemplateFiles(location.root);
      if (project.mode !== "git") {
        try {
          await adopt(ctx);
          await serveStdio(ctx, pkg.version, kind, location.root, templates);
        } finally {
          await ctx.store.close();
        }
        return;
      }
      // Git mode keeps .sati/ current while the agent works; pre-commit exports again anyway.
      const { afterWrites } = await import("@sati/sync");
      const dir = join(location.root, CONFIG_DIR);
      const report = (err: unknown) => printError(err, false);
      const synced = afterWrites(
        ctx.store,
        EXPORT_DEBOUNCE_MS,
        (written) => exportWritten(ctx, dir, written, report),
        report,
      );
      await syncAtStart(ctx, dir).catch(report);
      try {
        await adopt({ ...ctx, store: synced.store });
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
