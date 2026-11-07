import { CLI_NAME, type ImportResult, readSettings, updateSettings } from "@sati/core";
import { type ExportResult, exportSnapshot, importSnapshot } from "@sati/sync";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute, openRuntime, output, readProjectConfig, snapshotDir } from "../runtime.js";

/** Also the top-level `sati export`; `--all` is kept for scripts and changes nothing. */
export const exportCmd = defineCommand({
  meta: { name: "export", description: "Write changed records to .sati/ (run by pre-commit)" },
  args: {
    all: {
      type: "boolean",
      description: "Accepted for older scripts; the export is always complete",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      (rt) => exportSnapshot(rt.ctx, snapshotDir(rt)),
      (r: ExportResult) => `Exported ${r.written.length} changed, ${r.unchanged} unchanged.`,
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
