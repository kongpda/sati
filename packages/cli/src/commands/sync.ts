import { join } from "node:path";
import { CONFIG_DIR, type ImportResult, SatiError } from "@sati/core";
import { type ExportResult, exportSnapshot, importSnapshot } from "@sati/sync";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute, type Runtime } from "../runtime.js";

/** The `.sati/` folder. Only git mode has one: stealth and standalone commit nothing. */
function snapshotDir(rt: Runtime): string {
  if (rt.project.mode !== "git") {
    throw new SatiError(
      "USAGE",
      `\`sati sync\` needs git mode; this project is ${rt.project.mode}.`,
      {
        hint: "Only git mode keeps a committed snapshot in .sati/.",
      },
    );
  }
  return join(rt.location.root, CONFIG_DIR);
}

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
  args: { ...json },
  run: ({ args }) =>
    execute(
      args.json,
      (rt) => importSnapshot(rt.ctx, snapshotDir(rt)),
      (r: ImportResult) => `Imported ${r.imported.length} newer, ${r.unchanged} unchanged.`,
    ),
});

export default defineCommand({
  meta: { name: "sync", description: "Export or import the .sati/ snapshot committed to git" },
  subCommands: { export: exportCmd, import: importCmd },
});
