import type { ImportResult } from "@sati/core";
import { type ExportResult, exportSnapshot, importSnapshot } from "@sati/sync";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute, openRuntime, output, snapshotDir } from "../runtime.js";

export const exportCommand = defineCommand({
  meta: { name: "export", description: "Write every record to .sati/" },
  args: {
    all: { type: "boolean", description: "Write the full snapshot (this is always the full set)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      (rt) => exportSnapshot(rt.ctx, snapshotDir(rt)),
      (r: ExportResult) => `Exported ${r.written.length} changed, ${r.unchanged} unchanged.`,
    ),
});

export const importCommand = defineCommand({
  meta: { name: "import", description: "Load records from .sati/ into the live database" },
  args: { ...json },
  run: ({ args }) =>
    output(
      args.json,
      async () => {
        const rt = await openRuntime();
        return importSnapshot(rt.ctx, snapshotDir(rt));
      },
      (r: ImportResult) => `Imported ${r.imported.length} newer, ${r.unchanged} unchanged.`,
    ),
});
