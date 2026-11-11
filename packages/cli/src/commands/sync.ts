import { CLI_NAME, type ImportResult, readSettings, SatiError, updateSettings } from "@sati/core";
import { type ExportResult, exportSnapshot, importSnapshot, refusedError } from "@sati/sync";
import { defineCommand } from "citty";
import { json } from "../args.js";
import {
  openRuntime,
  output,
  readProjectConfig,
  snapshotDir,
  writeConfigShare,
} from "../runtime.js";

/** Also the top-level `sati export`. */
export const exportCmd = defineCommand({
  meta: {
    name: "export",
    description:
      "Load newer records from .sati/, then write changed ones (run by pre-commit). Exit 5 if a record holding a secret was refused; the rest are written",
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
  meta: {
    name: "import",
    description: "Load newer records and the project kind from .sati/ (run by git hooks)",
  },
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
        // In a shared folder the copies a file-sync app made hold the other person's edit.
        const result = await importSnapshot(rt.ctx, snapshotDir(rt), {
          mergeCopies: rt.project.mode === "standalone",
        });
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

const shareCmd = defineCommand({
  meta: {
    name: "share",
    description:
      "Share this standalone project through its folder: keep the records as files in .sati/ for a file-sync app (Dropbox, OneDrive, a file server) to carry",
  },
  args: { ...json },
  run: ({ args }) =>
    output(
      args.json,
      async () => {
        const rt = await openRuntime();
        if (rt.project.mode !== "standalone") {
          throw new SatiError("USAGE", `A ${rt.project.mode} project is shared through git.`, {
            hint: "Commit and push; `.sati/` travels with the repository.",
          });
        }
        const turnedOn = writeConfigShare(rt.location.root);
        const result = await exportSnapshot(rt.ctx, snapshotDir(rt));
        if (result.refused.length > 0) throw refusedError(result.refused);
        return { shared: true, turnedOn, written: result.written.length };
      },
      (r: { turnedOn: boolean; written: number }) =>
        [
          r.turnedOn
            ? `Sharing is on. Wrote ${r.written} record file(s) to .sati/.`
            : `Sharing was on already. Wrote ${r.written} record file(s) to .sati/.`,
          `Others: open this folder once it has synced, then run \`${CLI_NAME} init\`.`,
          "Changes travel as fast as the sync app moves files. Private notes and cards stay on this machine.",
        ].join("\n"),
    ),
});

export default defineCommand({
  meta: {
    name: "sync",
    description:
      "Export or import the .sati/ snapshot (git mode, or a standalone project shared through its folder)",
  },
  subCommands: { export: exportCmd, import: importCmd, share: shareCmd },
});
