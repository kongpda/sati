import {
  actorIdentity,
  adoptClaims,
  ensureActor,
  readSettings,
  type ServiceContext,
} from "@sati/core";
import { defineCommand } from "citty";
import pkg from "../../package.json" with { type: "json" };
import {
  exportWritten,
  openRuntime,
  osUser,
  printError,
  processProbe,
  sharedDir,
} from "../runtime.js";
import { markSeen, watchFolder } from "../shared-folder.js";
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
      const rt = await openRuntime(process.cwd(), "");
      const { project, location } = rt;
      // No variable named the tool, so the client's own name does: Cursor and Claude Desktop in
      // one folder are then two actors, and neither is taken for the person.
      const named = async (c: ServiceContext, client: string) => {
        if (rt.actor.tool !== "mcp" || process.env.SATI_ACTOR?.trim()) return;
        const who = actorIdentity({
          env: process.env,
          worktree: location.root,
          user: osUser(),
          mcpClient: client,
        });
        c.actorId = (await ensureActor(c, who)).id;
        await adoptClaims(c);
      };
      // The MCP server lives as long as the agent session, so its claims name it as the holder.
      const ctx = { ...rt.ctx, processes: processProbe(true) };
      // A reloaded server takes over the claims its exited predecessor held for this actor.
      const adopt = (c: typeof ctx) =>
        adoptClaims(c).catch((err: unknown) => printError(err, false));
      // Loaded here so the MCP SDK never slows down the other commands.
      const { serveStdio } = await import("@sati/mcp");
      const { kind } = readSettings(project.settings);
      const templates = () => readTemplateFiles(location.root);
      const dir = sharedDir(rt);
      if (!dir) {
        try {
          await adopt(ctx);
          await serveStdio(ctx, pkg.version, kind, location.root, templates, named);
        } finally {
          await ctx.store.close();
        }
        return;
      }
      // Git mode keeps .sati/ current while the agent works; pre-commit exports again anyway.
      const { afterWrites } = await import("@sati/sync");
      const report = (err: unknown) => printError(err, false);
      // A shared folder has no git hooks: this process loads what the file-sync app brings.
      const folder = project.mode === "standalone";
      const synced = afterWrites(
        ctx.store,
        EXPORT_DEBOUNCE_MS,
        async (written) => {
          const files = await exportWritten(ctx, dir, written, report);
          if (folder) await markSeen(dir, location.path, files);
        },
        report,
      );
      await syncAtStart(ctx, dir).catch(report);
      const stop = folder ? watchFolder(ctx, dir, location.path, report) : () => {};
      try {
        await adopt({ ...ctx, store: synced.store });
        await serveStdio(
          { ...ctx, store: synced.store },
          pkg.version,
          kind,
          location.root,
          templates,
          named,
        );
      } finally {
        stop();
        await synced.flush();
        await ctx.store.close();
      }
    } catch (err) {
      // stdout belongs to the protocol, so errors go to stderr only.
      process.exitCode = printError(err, false);
    }
  },
});
