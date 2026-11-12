import { resolve } from "node:path";
import {
  approveCard,
  CLI_NAME,
  type ContextEntry,
  type ContextView,
  getContext,
  putContext,
  SatiError,
  shortHandle,
} from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { fileSha256 } from "../file-hash.js";
import { handle } from "../render.js";
import { int, list, parseJson } from "../runtime/input.js";
import type { Runtime } from "../runtime/location.js";
import { execute } from "../runtime/output.js";
import { bold, dim, green, red, term, wrap, yellow } from "../term.js";
import { projectPath } from "./guard.js";

/** A card as shown: with how its file compares with the version a person approved. */
type Shown = ContextView & { approval?: "kept" | "changed" | "missing" };

function withApproval(rt: Runtime, e: ContextView): Shown {
  if (e.approved === undefined) return e;
  const hash = fileSha256(resolve(rt.location.root, e.path));
  const approval = hash === undefined ? "missing" : hash === e.approved.hash ? "kept" : "changed";
  return { ...e, approval };
}

const APPROVAL = {
  kept: "approved",
  changed: "CHANGED since it was approved",
  missing: "approved file is MISSING",
} as const;

const state = (e: ContextView) =>
  e.stale === null
    ? e.sourceSeen
      ? `read at ${e.sourceSeen}`
      : "not checked"
    : e.stale
      ? "STALE"
      : "fresh";

/** A web link is kept as typed: resolved like a file name it would land inside the project. */
const cardPath = (rt: Runtime, path: string) =>
  /^https?:\/\//iu.test(path.trim()) ? path : projectPath(rt, path);

/** Facts as a JSON array of strings, or one fact per line: commas are common inside facts. */
function facts(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (value.trim().startsWith("[")) return parseJson(value, "--facts", "USAGE");
  return value
    .split(/\r?\n/u)
    .map((f) => f.trim())
    .filter(Boolean);
}

const render = (e: Shown) => {
  const lock = `${e.approval ? `  [${APPROVAL[e.approval]}]` : ""}${e.private ? "  (private)" : ""}`;
  if (!term().rich) {
    const lines = [`${shortHandle(e.id)}  ${e.path}  [${state(e)}]${lock}`, `  ${e.summary}`];
    for (const f of e.facts ?? []) lines.push(`  - ${f}`);
    if (e.tags?.length) lines.push(`  tags: ${e.tags.join(", ")}`);
    return lines.join("\n");
  }
  const max = Math.min(term().width, 120);
  const mark = e.stale
    ? yellow(`[${state(e)}]`)
    : e.stale === false
      ? green("[fresh]")
      : dim(`[${state(e)}]`);
  const alarm = e.approval === "changed" || e.approval === "missing";
  const lines = [
    `${handle(e.id)}  ${bold(e.path)}  ${mark}${alarm ? red(lock) : lock}`,
    wrap(`  ${e.summary}`, max),
  ];
  for (const f of e.facts ?? []) lines.push(wrap(`  - ${f}`, max, "  "));
  if (e.tags?.length) lines.push(dim(`  tags: ${e.tags.join(", ")}`));
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
      description: "Only entries overlapping this path or glob, or the card for this link",
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
      async (rt) => {
        const cards = await getContext(rt.ctx, {
          path: args.path === undefined ? undefined : cardPath(rt, args.path),
          seen: args.seen,
        });
        return cards.map((e) => withApproval(rt, e));
      },
      (entries: Shown[]) =>
        entries.length
          ? entries.map(render).join(term().rich ? "\n\n" : "\n")
          : `No cards. Add one with \`${CLI_NAME} card put <path> --summary "…"\`.`,
    ),
});

const put = defineCommand({
  meta: {
    name: "put",
    description: "Save what you learned about a file, folder or module (a card, not its contents)",
  },
  args: {
    path: {
      type: "positional",
      required: true,
      description:
        "Project-relative path or glob, a web link, or the full path of a file outside the project",
    },
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
          path: cardPath(rt, args.path),
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

const approve = defineCommand({
  meta: {
    name: "approve",
    description:
      "Sign off a file as it is now: the guard then blocks a change to it until it is approved again",
  },
  args: {
    path: { type: "positional", required: true, description: "The file, inside the project" },
    clear: { type: "boolean", description: "Take the approval away" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async (rt) => {
        const path = projectPath(rt, args.path);
        if (args.clear) return approveCard(rt.ctx, { path, hash: null });
        // Hashed here and dropped: the bytes never reach the database.
        const hash = fileSha256(resolve(rt.location.root, path));
        if (hash === undefined) {
          throw new SatiError("NOT_FOUND", `There is no file at ${args.path}.`);
        }
        return approveCard(rt.ctx, { path, hash });
      },
      (e: ContextEntry) =>
        e.approved
          ? `Approved ${shortHandle(e.id)}  ${e.path}  (sha256 ${e.approved.hash.slice(0, 12)})`
          : `${e.path} is no longer approved.`,
    ),
});

export default defineCommand({
  meta: {
    name: "card",
    description: "Cards: what agents learned about files and modules",
  },
  // `show` is the old name of `get` (the MCP tool's name); it still runs but is not listed.
  subCommands: {
    show: { ...get, meta: { ...getMeta, name: "show", hidden: true } },
    get,
    put,
    approve,
  },
});
