import type { ImportResult } from "@sati/core";
import { type ExportResult, exportSnapshot, importSnapshot } from "@sati/sync";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute, openRuntime, output, snapshotDir } from "../runtime.js";

const exportCmd = defineCommand({
  meta: { name: "export", description: "Write changed records to .sati/ (run by pre-commit)" },
  args: { ...json },
  run: ({ args }) =>
    execute(
      args.json,
      (rt) => exportSnapshot(rt.ctx, snapshotDir(rt)),
      (r: ExportResult) => `Exported ${r.written.length} changed, ${r.unchanged} unchanged.`,
    ),
});

const importCmd = defineCommand({
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
        return importSnapshot(rt.ctx, snapshotDir(rt));
      },
      (r: ImportResult) =>
        args.quiet && r.imported.length === 0
          ? ""
          : `Imported ${r.imported.length} newer, ${r.unchanged} unchanged.`,
    ),
});

export default defineCommand({
  meta: { name: "sync", description: "Export or import the .sati/ snapshot committed to git" },
  subCommands: { export: exportCmd, import: importCmd },
});
