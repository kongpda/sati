import {
  type AcquireLockResult,
  acquireLock,
  type Lock,
  listLocks,
  releaseLock,
  resolveId,
  shortHandle,
} from "@brain/core";
import { defineCommand } from "citty";
import { id, json } from "../args.js";
import { execute, int, list, ref } from "../runtime.js";

const line = (l: Lock) =>
  `${shortHandle(l.id)}  ${l.mode}  ${l.paths.join(", ")}  by ${shortHandle(l.actorId)} until ${l.leaseUntil}`;

const acquire = defineCommand({
  meta: { name: "acquire", description: "Lock paths so other agents do not edit them" },
  args: {
    paths: {
      type: "positional",
      required: true,
      description: "Comma-separated repo-relative paths or globs (quote globs)",
    },
    shared: { type: "boolean", description: "Shared lock: overlaps only warn" },
    task: { type: "string", description: "Task id or handle; completing it releases the lock" },
    reason: { type: "string", description: "Why the paths are locked" },
    lease: { type: "string", description: "Lease length in minutes (default: project setting)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        acquireLock(ctx, {
          paths: list(args.paths),
          mode: args.shared ? "shared" : "exclusive",
          taskId: await ref(ctx, "task", args.task),
          reason: args.reason,
          leaseMinutes: int(args.lease, "lease"),
        }),
      ({ lock, warnings }: AcquireLockResult) =>
        [
          `Locked ${line(lock)}`,
          ...warnings.map(
            (w) => `warning: overlaps ${w.mode} lock ${shortHandle(w.lockId)} by ${w.holderName}`,
          ),
        ].join("\n"),
    ),
});

const release = defineCommand({
  meta: { name: "release", description: "Release a lock" },
  args: {
    ...id("Lock"),
    force: { type: "boolean", description: "Release another agent's lock (logged)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        releaseLock(ctx, await resolveId(ctx, "lock", args.id), { force: args.force }),
      (l: Lock) => `Released ${shortHandle(l.id)}  ${l.paths.join(", ")}`,
    ),
});

const ls = defineCommand({
  meta: { name: "list", description: "List live locks" },
  args: { ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => listLocks(ctx),
      (locks: Lock[]) =>
        locks.length
          ? locks.map(line).join("\n")
          : 'No locks. Lock paths with `brain lock acquire "src/area/**"`.',
    ),
});

export default defineCommand({
  meta: { name: "lock", description: "Lock paths while you edit them" },
  subCommands: { acquire, release, list: ls },
});
