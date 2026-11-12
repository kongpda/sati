import {
  CLI_NAME,
  createNote,
  deleteRecord,
  getRecord,
  listRecords,
  type Note,
  resolveId,
  resolveLinks,
  restoreRecord,
  type ServiceContext,
  updateNote,
} from "@sati/core";
import { defineCommand } from "citty";
import { expectedVersion, id, json, pagination } from "../args.js";
import { askBody, askText, canAsk, missing, sameAs } from "../prompt.js";
import { record, row, rows } from "../render.js";
import { bodyText, execute, int, list, someChange } from "../runtime.js";

/** A short handle in `--links` becomes the full id, as over MCP, so the link shows in threads. */
const linksOf = async (ctx: ServiceContext, raw: string | undefined) => {
  const links = list(raw);
  return links && resolveLinks(ctx, links);
};

const fields = {
  body: { type: "string", description: "Note text in Markdown (- reads stdin)" },
  tags: { type: "string", description: "Comma-separated tags" },
  links: {
    type: "string",
    description: "Comma-separated links (URLs, paths, ids or short handles)",
  },
  pinned: { type: "boolean", description: "Pin the note (pinned notes reach every brief)" },
  private: {
    type: "boolean",
    description:
      "Keep it on this machine: never exported to .sati/. Set when made; --no-private shares it for good",
  },
} as const;

/** The flags a person typed after the command word, for the "Same as" line. */
function typedAfter(word: string): string[] {
  const argv = process.argv.slice(2);
  return argv.slice(argv.indexOf(word) + 1);
}

const create = defineCommand({
  meta: { name: "create", description: "Write a note" },
  args: {
    title: {
      type: "positional",
      required: false,
      description: "Note title (at a terminal: asked when left out)",
    },
    ...fields,
    ...json,
  },
  run: ({ args }) => {
    if (args.title === undefined && !canAsk(args.json)) throw missing("title", "note create");
    return execute(
      args.json,
      async ({ ctx }) => {
        // A person who typed no title is asked for it, then writes the text: in their editor
        // when $VISUAL or $EDITOR is set, else on one line.
        const title = args.title ?? (await askText("Note title"));
        const body =
          args.title === undefined && args.body === undefined
            ? await askBody("Note text")
            : bodyText(args.body);
        if (args.title === undefined) {
          sameAs(
            "note",
            "create",
            title,
            ...(args.body === undefined ? ["--body", body ?? ""] : []),
            ...typedAfter("create"),
          );
        }
        return createNote(ctx, {
          title,
          body,
          tags: list(args.tags),
          links: await linksOf(ctx, args.links),
          pinned: args.pinned,
          private: args.private,
        });
      },
      (n: Note) => `Created ${row(n)}`,
    );
  },
});

const ls = defineCommand({
  meta: { name: "list", description: "List notes" },
  args: { ...pagination, ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        listRecords(ctx, "note", {
          limit: int(args.limit, "limit"),
          offset: int(args.offset, "offset"),
        }),
      (items: Note[]) =>
        rows(items, `No notes. Write one with \`${CLI_NAME} note create "title"\`.`),
      { readOnly: true },
    ),
});

const show = defineCommand({
  meta: { name: "show", description: "Show one note" },
  args: { ...id("Note"), ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => getRecord(ctx, "note", await resolveId(ctx, "note", args.id)),
      record,
      { readOnly: true },
    ),
});

const update = defineCommand({
  meta: { name: "update", description: "Change a note" },
  args: {
    ...id("Note"),
    title: { type: "string", description: "New title" },
    ...fields,
    reviewed: { type: "boolean", description: "Clear needsReview" },
    ...expectedVersion,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        updateNote(
          ctx,
          await resolveId(ctx, "note", args.id),
          someChange(
            {
              title: args.title,
              body: bodyText(args.body),
              tags: list(args.tags),
              links: await linksOf(ctx, args.links),
              pinned: args.pinned,
              private: args.private,
              reviewed: args.reviewed ? true : undefined,
              expectedVersion: int(args["expected-version"], "expected-version"),
            },
            "note update",
          ),
        ),
      (n: Note) => `Updated ${row(n)}`,
    ),
});

const remove = defineCommand({
  meta: { name: "delete", description: "Soft-delete a note" },
  args: { ...id("Note"), ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        deleteRecord(ctx, "note", await resolveId(ctx, "note", args.id)) as Promise<Note>,
      (n: Note) => `Deleted ${row(n)}`,
    ),
});

const restore = defineCommand({
  meta: { name: "restore", description: "Restore a soft-deleted note" },
  args: { ...id("Note"), ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        restoreRecord(
          ctx,
          "note",
          await resolveId(ctx, "note", args.id, { deleted: true }),
        ) as Promise<Note>,
      (n: Note) => `Restored ${row(n)}`,
    ),
});

export default defineCommand({
  meta: { name: "note", description: "Keep project notes" },
  subCommands: { create, list: ls, show, update, delete: remove, restore },
});
