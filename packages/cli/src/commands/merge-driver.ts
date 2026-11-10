import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { CLI_NAME } from "@sati/core";
import { decodeRecord, encodeRecord, mergeRecord, parseRecord, stableJson } from "@sati/sync";
import { defineCommand } from "citty";

/**
 * Git merge driver for the record files in `.sati/` (`<cli> merge-driver %O %A %B`). Writes the
 * merged record over `%A`. Conflicts never fail the merge: they flag the record `needsReview`. A
 * file that is not JSON, or is not a record (the config file under an older `.gitattributes`
 * line), exits 1, which leaves git's normal conflict in place.
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
      // Each side may be in the compact or the full form; the merge works on full records.
      const side = (text: string, name: string) =>
        decodeRecord(parseRecord(text, name)) as ReturnType<typeof parseRecord>;
      const base = baseText.trim() === "" ? undefined : side(baseText, "base");
      const ours = side(read(args.ours), "ours");
      const theirs = side(read(args.theirs), "theirs");
      if (typeof ours.id !== "string" || typeof theirs.id !== "string") {
        throw new Error("not a record file, so git merges it as text");
      }
      const { record, conflict } = mergeRecord(base, ours, theirs);
      const tmp = `${args.ours}.${process.pid}.tmp`;
      writeFileSync(tmp, stableJson(encodeRecord(record)));
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
