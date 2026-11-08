import { importPlan, type PlanImport } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute, readText } from "../runtime.js";

export default defineCommand({
  meta: { name: "plan", description: "Import tasks from a Markdown checklist" },
  subCommands: {
    import: defineCommand({
      meta: {
        name: "import",
        description: "One milestone per heading, one task per unchecked item",
      },
      args: {
        file: { type: "positional", required: true, description: "Markdown file (- reads stdin)" },
        "dry-run": { type: "boolean", description: "Show what would be added" },
        ...json,
      },
      run: ({ args }) =>
        execute(
          args.json,
          ({ ctx }) =>
            importPlan(ctx, {
              markdown: readText(args.file),
              dryRun: args["dry-run"],
            }),
          (result: PlanImport) => {
            const line = (c: PlanImport["added"][number]) => `- ${c.kind} ${c.title}`;
            return [
              result.added.length ? `Add\n${result.added.map(line).join("\n")}` : "Add\nnothing",
              result.skipped.length
                ? `Skip\n${result.skipped.map(line).join("\n")}`
                : "Skip\nnothing",
            ].join("\n");
          },
        ),
    }),
  },
});
