import { CLI_NAME, type ImportResult, readSettings, updateSettings } from "@sati/core";
import { type ExportResult, exportSnapshot, importSnapshot, refusedError } from "@sati/sync";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { openRuntime, output, readProjectConfig, snapshotDir } from "../runtime.js";

/** Also the top-level `sati export`. */
export const exportCmd = defineCommand({
  meta: {
    name: "export",
    description: "Load newer records from .sati/, then write changed ones (run by pre-commit)",
  },
  args: {
    ...json,
  },
  run: ({ args }) =>
    // Not `execute`: its export after writes would only repeat the full export below.
    output(
      args.json,
      async () => {
        const rt = await openRuntime();
        const dir = snapshotDir(rt);
        // A teammate's edit that no hook imported (stash pop, cherry-pick, `git apply`) is loaded
        // first, so the commit carries it as it is. A refused import throws here and stops the
        // commit: committing over a snapshot that cannot be read spreads it to every clone.
        const { problems } = await importSnapshot(rt.ctx, dir);
        for (const p of problems) process.stderr.write(`warning: ${p}\n`);
        const result = await exportSnapshot(rt.ctx, dir);
        // The other records are written; a refused one fails the command, and so the commit.
        if (result.refused.length > 0) throw refusedError(result.refused);
        return result;
      },
      (r: ExportResult) =>
        `Exported ${r.written.length} changed, ${r.unchanged} unchanged.${
          r.newer.length > 0
            ? `\n${r.newer.length} newer in .sati/ left as they are. Run \`${CLI_NAME} import\` to load them.`
            : ""
        }`,
    ),
});

/** Also the top-level `sati import`. */
export const importCmd = defineCommand({
  meta: { name: "import", description: "Load newer records from .sati/ (run by git hooks)" },
  args: {
    quiet: { type: "boolean", description: "Print nothing unless records were imported" },
    ...json,
  },
  run: ({ args }) =>
    // Not `execute`: its export after writes would put newer DB records back into .sati/ after
    // checking out an older branch, leaving the tree dirty.
    output(
      args.json,
      async () => {
        const rt = await openRuntime();
        const result = await importSnapshot(rt.ctx, snapshotDir(rt));
        // A teammate's kind switch arrives in the committed config, not in the snapshot. An
        // older config without `kind` says nothing, so it never resets the project.
        const kind = readProjectConfig(rt.location.root)?.kind;
        if (kind && readSettings(rt.project.settings).kind !== kind) {
          await updateSettings(rt.ctx, { kind });
        }
        return result;
      },
      (r: ImportResult) => {
        // Problems need a person even in quiet mode: they come from a merge nobody saw.
        const problems = r.problems.length
          ? `\nwarning: ${r.problems.join("\nwarning: ")}\nhint: Run \`${CLI_NAME} doctor\`, then fix the links with \`${CLI_NAME} task update\`.`
          : "";
        if (args.quiet && r.imported.length === 0) return problems.trimStart();
        return `Imported ${r.imported.length} newer, ${r.unchanged} unchanged.${problems}`;
      },
    ),
});

export default defineCommand({
  meta: { name: "sync", description: "Export or import the .sati/ snapshot committed to git" },
  subCommands: { export: exportCmd, import: importCmd },
});
