import {
  CLI_NAME,
  type ContextEntry,
  type ContextView,
  getContext,
  putContext,
  shortHandle,
} from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute, list } from "../runtime.js";

const state = (e: ContextView) =>
  e.stale === null ? "unknown (no git)" : e.stale ? "STALE" : "fresh";

const get = defineCommand({
  meta: { name: "get", description: "Show cached module summaries; flags stale ones" },
  args: {
    path: {
      type: "positional",
      required: false,
      description: "Only entries overlapping this path or glob",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => getContext(ctx, { path: args.path }),
      (entries: ContextView[]) =>
        entries.length
          ? entries
              .map((e) => `${shortHandle(e.id)}  ${e.path}  [${state(e)}]\n  ${e.summary}`)
              .join("\n")
          : `No context entries. Add one with \`${CLI_NAME} context put src/area --summary "…"\`.`,
    ),
});

const put = defineCommand({
  meta: { name: "put", description: "Save what you learned about a module (summary, not code)" },
  args: {
    path: { type: "positional", required: true, description: "Repo-relative path or glob" },
    summary: { type: "string", required: true, description: "What the module does and how" },
    "key-files": { type: "string", description: "Comma-separated most important files" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        putContext(ctx, {
          path: args.path,
          summary: args.summary,
          keyFiles: list(args["key-files"]),
        }),
      (e: ContextEntry) => `Saved ${shortHandle(e.id)}  ${e.path}`,
    ),
});

export default defineCommand({
  meta: { name: "context", description: "Cached module summaries, stale when files change" },
  subCommands: { get, put },
});
