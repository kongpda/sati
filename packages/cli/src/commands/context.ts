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
import { execute, int, list, parseJson } from "../runtime.js";
import { projectPath } from "./guard.js";

const state = (e: ContextView) =>
  e.stale === null
    ? e.sourceSeen
      ? `read at ${e.sourceSeen}`
      : "not checked"
    : e.stale
      ? "STALE"
      : "fresh";

/** Facts as a JSON array of strings, or one fact per line: commas are common inside facts. */
function facts(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (value.trim().startsWith("[")) return parseJson(value, "--facts", "USAGE");
  return value
    .split(/\r?\n/u)
    .map((f) => f.trim())
    .filter(Boolean);
}

const render = (e: ContextView) => {
  const lock = e.private ? "  (private)" : "";
  const lines = [`${shortHandle(e.id)}  ${e.path}  [${state(e)}]${lock}`, `  ${e.summary}`];
  for (const f of e.facts ?? []) lines.push(`  - ${f}`);
  if (e.tags?.length) lines.push(`  tags: ${e.tags.join(", ")}`);
  return lines.join("\n");
};

const getMeta = {
  name: "get",
  description: "Show cards, flagging STALE those whose files changed since",
};

const get = defineCommand({
  meta: getMeta,
  args: {
    path: {
      type: "positional",
      required: false,
      description: "Only entries overlapping this path or glob",
    },
    seen: {
      type: "string",
      description:
        "The file's version now (modified time or hash); the card for <path> is stale if it was saved with another",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async (rt) =>
        getContext(rt.ctx, {
          path: args.path === undefined ? undefined : projectPath(rt, args.path),
          seen: args.seen,
        }),
      (entries: ContextView[]) =>
        entries.length
          ? entries.map(render).join("\n")
          : `No cards. Add one with \`${CLI_NAME} card put <path> --summary "…"\`.`,
    ),
});

const put = defineCommand({
  meta: {
    name: "put",
    description: "Save what you learned about a file, folder or module (a card, not its contents)",
  },
  args: {
    path: { type: "positional", required: true, description: "Project-relative path or glob" },
    summary: { type: "string", required: true, description: "What it is and what matters" },
    facts: {
      type: "string",
      description: "Facts to quote: a JSON array of strings, or one per line (up to 50)",
    },
    tags: { type: "string", description: "Comma-separated tags" },
    seen: {
      type: "string",
      description: "The file version you read, such as its modified time 2026-11-08T04:01Z",
    },
    tokens: { type: "string", description: "About how many tokens reading the file took" },
    "key-files": { type: "string", description: "Comma-separated most important files" },
    private: {
      type: "boolean",
      description:
        "Keep it on this machine: never exported to .sati/. Set when made; --no-private shares it for good",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async (rt) =>
        putContext(rt.ctx, {
          path: projectPath(rt, args.path),
          summary: args.summary,
          keyFiles: list(args["key-files"]),
          facts: facts(args.facts),
          tags: list(args.tags),
          sourceSeen: args.seen,
          sourceTokens: int(args.tokens, "tokens"),
          private: args.private,
        }),
      (e: ContextEntry) => `Saved ${shortHandle(e.id)}  ${e.path}`,
    ),
});

export default defineCommand({
  meta: {
    name: "card",
    description: "Cards: what agents learned about files and modules (also `sati context`)",
  },
  // `show` reads better for a person; `get` matches the MCP tool.
  subCommands: { show: { ...get, meta: { ...getMeta, name: "show" } }, get, put },
});
