import {
  CLI_NAME,
  createNote,
  deleteRecord,
  getRecord,
  listRecords,
  type Note,
  resolveId,
  restoreRecord,
  updateNote,
} from "@sati/core";
import { defineCommand } from "citty";
import { expectedVersion, id, json, pagination } from "../args.js";
import { record, row, rows } from "../render.js";
import { bodyText, execute, int, list } from "../runtime.js";

const fields = {
  body: { type: "string", description: "Note text in Markdown (- reads stdin)" },
  tags: { type: "string", description: "Comma-separated tags" },
  links: { type: "string", description: "Comma-separated links (URLs, paths or ids)" },
  pinned: { type: "boolean", description: "Pin the note (pinned notes reach every brief)" },
  private: {
    type: "boolean",
    description: "Keep it on this machine: never exported to .sati/ (--no-private shares it)",
  },
} as const;

const create = defineCommand({
  meta: { name: "create", description: "Write a note" },
  args: {
    title: { type: "positional", required: true, description: "Note title" },
    ...fields,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        createNote(ctx, {
          title: args.title,
          body: bodyText(args.body),
          tags: list(args.tags),
          links: list(args.links),
          pinned: args.pinned,
          private: args.private,
        }),
      (n: Note) => `Created ${row(n)}`,
    ),
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
        updateNote(ctx, await resolveId(ctx, "note", args.id), {
          title: args.title,
          body: bodyText(args.body),
          tags: list(args.tags),
          links: list(args.links),
          pinned: args.pinned,
          private: args.private,
          reviewed: args.reviewed ? true : undefined,
          expectedVersion: int(args["expected-version"], "expected-version"),
        }),
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
