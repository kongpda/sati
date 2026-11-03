import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { CLI_NAME } from "@sati/core";
import { mergeRecord, parseRecord, stableJson } from "@sati/sync";
import { defineCommand } from "citty";

/**
 * Git merge driver for `.sati/**\/*.json` (`<cli> merge-driver %O %A %B`). Writes the merged
 * record over `%A`. Conflicts never fail the merge: they flag the record `needsReview`. Only a
 * file that is not JSON exits 1, which leaves git's normal conflict in place.
 */
export default defineCommand({
  meta: {
    name: "merge-driver",
    description: "Git merge driver for .sati/ records (set up by init)",
  },
  args: {
    base: { type: "positional", required: true, description: "%O: the common ancestor" },
    ours: { type: "positional", required: true, description: "%A: our version; gets the result" },
    theirs: { type: "positional", required: true, description: "%B: their version" },
  },
  run: ({ args }) => {
    try {
      const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
      const baseText = read(args.base);
      const base = baseText.trim() === "" ? undefined : parseRecord(baseText, "base");
      const ours = parseRecord(read(args.ours), "ours");
      const theirs = parseRecord(read(args.theirs), "theirs");
      const { record, conflict } = mergeRecord(base, ours, theirs);
      const tmp = `${args.ours}.${process.pid}.tmp`;
      writeFileSync(tmp, stableJson(record));
      renameSync(tmp, args.ours);
      if (conflict) {
        process.stderr.write(
          `${CLI_NAME}: merged ${String(record.id)} with conflicts; flagged needsReview.\n`,
        );
      }
    } catch (err) {
      process.stderr.write(
        `${CLI_NAME} merge-driver: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  },
});
