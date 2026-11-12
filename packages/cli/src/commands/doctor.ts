import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  CLI_NAME,
  type ContextEntry,
  cardFile,
  type DoctorCheck,
  doctorChecks,
  ERROR_EXIT_CODES,
  isExternalKey,
  LEAN_DONE_DAYS,
  type LinkedWorktree,
  leanCleanup,
  leanReport,
  markReviewed,
  removableWorktrees,
  type ServiceContext,
  shortHandle,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { buildCheck, sourceRoot } from "../build-check.js";
import { defaultBase, samePath } from "../git.js";
import { installedSelf } from "../hooks.js";
import { runHint } from "../install.js";
import { checks } from "../render.js";
import { closeRuntime, execute, openRuntime, output, worktreePaths } from "../runtime.js";
import { versionLine } from "../version.js";
import { pendingUpgrade, syncedDbWarning } from "./init.js";

/**
 * The git hooks of this clone: the pre-commit runner init writes under the git common dir, and
 * the binary it starts. Each clone needs its own `init`, so a fresh clone fails here.
 */
function hooksCheck(root: string): DoctorCheck {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const runner = resolve(
    isAbsolute(common) ? common : resolve(root, common),
    CLI_NAME,
    "hooks",
    "pre-commit",
  );
  const fix = `Run \`${runHint(root, "upgrade")}\`.`;
  if (!existsSync(runner)) {
    return { name: "hooks", ok: false, detail: `This clone has no ${CLI_NAME} git hooks. ${fix}` };
  }
  // Every word of the command the hooks start is a path: node and the script, or the binary.
  const self = installedSelf(root) ?? [];
  const bin = self.at(-1);
  const gone = self.find((word) => !existsSync(resolve(root, word)));
  if (gone !== undefined) {
    return {
      name: "hooks",
      ok: false,
      detail: `The git hooks start ${gone}, which is gone. ${fix}`,
    };
  }
  return { name: "hooks", ok: true, detail: `The git hooks start ${bin ?? CLI_NAME}.` };
}

/**
 * Whether the hooks, merge driver (git mode) and agent files match this version. After an
 * update they lag behind until `init --upgrade` runs, and nothing else would say so.
 */
async function upgradeCheck(root: string): Promise<DoctorCheck> {
  let files: Awaited<ReturnType<typeof pendingUpgrade>>;
  try {
    files = await pendingUpgrade(root);
  } catch (err) {
    // A failed plan is one failed check, not a lost report.
    return { name: "setup", ok: false, detail: `Cannot check: ${(err as Error).message}` };
  }
  if (files.length === 0) {
    return { name: "setup", ok: true, detail: "The git hooks and agent files are current." };
  }
  return {
    name: "setup",
    ok: false,
    detail: [
      `${files.length} managed file(s) are out of date. Run \`${runHint(root, "upgrade")}\`.`,
      ...files.map((f) => `  ${f.action === "create" ? "missing" : "stale  "} ${f.path}`),
    ].join("\n"),
  };
}

const quiet = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/**
 * Linked worktrees that are finished: clean, merged into the base branch and not used by any
 * open task. Lists the command to remove each; never removes one. Informational, so always ok.
 */
async function worktreesCheck(ctx: ServiceContext, root: string): Promise<DoctorCheck | null> {
  const base = defaultBase(root);
  let linked: { path: string; branch: string | null }[];
  try {
    // The first entry is the main worktree. The one doctor runs in is in use, so it is left out
    // too: inside a linked worktree it is not the first.
    linked = worktreePaths(root)
      .slice(1)
      .filter((w) => !samePath(w.path, root));
  } catch {
    // `git worktree list -z` needs git 2.36; older git just skips this check.
    return null;
  }
  if (!base || linked.length === 0) return null;
  const seen: LinkedWorktree[] = [];
  for (const w of linked) {
    try {
      const clean = quiet(w.path, ["status", "--porcelain=v1", "-z"]) === "";
      let merged = false;
      try {
        quiet(w.path, ["merge-base", "--is-ancestor", "HEAD", base]);
        merged = true;
      } catch {
        // Exit 1: HEAD has commits the base does not.
      }
      seen.push({ ...w, clean, merged });
    } catch {
      // A worktree whose folder is gone: `git worktree prune` is git's own business.
    }
  }
  const removable = await removableWorktrees(ctx, seen);
  return {
    name: "worktrees",
    ok: true,
    detail:
      removable.length === 0
        ? `No finished worktrees to remove (${linked.length} linked).`
        : [
            `${removable.length} finished worktree(s), clean and merged into ${base}. Remove with:`,
            ...removable.map((r) => `  ${r.command}`),
          ].join("\n"),
  };
}

const GLOB = /[*?[\]{}]/u;

/**
 * Cards whose file is gone: not on disk and, in a git repo, on no branch. A card for a file that
 * lives on another branch is not bloat. A glob card is never counted, nor one for a web link or a
 * file outside the project: that file may be on another machine.
 */
function goneCards(root: string, git: boolean, cards: ContextEntry[]): ContextEntry[] {
  const missing = cards.filter(
    (c) =>
      !isExternalKey(c.path) &&
      // A missing approved file is a lost deliverable, not bloat: `card get` reports it.
      c.approved === undefined &&
      !GLOB.test(c.path) &&
      !existsSync(resolve(root, c.path)) &&
      !existsSync(resolve(root, cardFile(c.path))),
  );
  if (missing.length === 0 || !git) return missing;
  // One `cat-file` for every branch and missing path, instead of listing each branch's whole tree
  // (review 8.8). `<ref>:<path>` names a file or a folder; an absent one prints "missing".
  const big = { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 } as const;
  let answers: string[];
  const asked: { card: ContextEntry; query: string }[] = [];
  try {
    const refs = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"],
      big,
    )
      .split("\n")
      .filter(Boolean);
    for (const card of missing) {
      for (const ref of refs) {
        for (const path of new Set([card.path, cardFile(card.path)])) {
          asked.push({ card, query: `${ref}:${path}` });
        }
      }
    }
    if (asked.length === 0) return missing;
    answers = execFileSync("git", ["cat-file", "--batch-check"], {
      ...big,
      input: `${asked.map((a) => a.query).join("\n")}\n`,
    }).split("\n");
  } catch {
    // The branches cannot be read, so no card can be called gone.
    return [];
  }
  const found = new Set(
    asked.filter((_, i) => !(answers[i] ?? "missing").endsWith(" missing")).map((a) => a.card),
  );
  return missing.filter((c) => !found.has(c));
}

/** Informational: what could be cleaned up, and how. With `fix`, cleans it up first. */
async function leanCheck(
  ctx: ServiceContext,
  root: string,
  git: boolean,
  fix: boolean,
): Promise<DoctorCheck> {
  const report = await leanReport(ctx);
  const gone = goneCards(root, git, report.cards);
  const parts: string[] = [];
  if (fix) {
    const done = await leanCleanup(
      ctx,
      gone.map((c) => c.id),
    );
    if (done.locks > 0) parts.push(`Released ${done.locks} expired lock(s).`);
    if (done.cards.length > 0) {
      parts.push(
        `Removed ${done.cards.length} card(s) whose file is gone: ${done.cards.join(", ")}.`,
      );
    }
  } else if (gone.length > 0) {
    const names = gone.slice(0, 8).map((c) => c.path);
    parts.push(
      `${gone.length} card(s) describe a file that is gone: ${names.join(", ")}${gone.length > 8 ? ", …" : ""}. Remove them with \`${CLI_NAME} doctor --fix\`.`,
    );
  }
  if (report.oldDone > 0) {
    parts.push(
      `${report.oldDone} finished task(s) are older than ${LEAN_DONE_DAYS} days. They are kept as history and stay out of the brief.`,
    );
  }
  return { name: "lean", ok: true, detail: parts.join(" ") || "Nothing to clean up." };
}

/** What a bug report needs beside the checks: which build, on what, installed how, storing where. */
interface Environment {
  version: string;
  node: string;
  os: string;
  /** `source` runs the bundle inside a checkout of the code; `package` is an installed copy. */
  install: "source" | "package";
  bin: string;
  store: string;
}

function environment(store: string): Environment {
  return {
    version: versionLine(CLI_NAME),
    node: process.version,
    os: `${process.platform} ${process.arch}`,
    install: sourceRoot() === undefined ? "package" : "source",
    bin: process.argv[1] ?? "",
    store,
  };
}

const environmentText = (e: Environment): string =>
  [
    e.version,
    `node ${e.node}, ${e.os}`,
    `install: ${e.install === "source" ? "source checkout" : "package"}, ${e.bin}`,
    `store: ${e.store}`,
  ].join("\n");

export default defineCommand({
  meta: {
    name: "doctor",
    description:
      "Check leases, locks, integrity, hooks, setup files, finished worktrees and bloat. Exit 5 if a check fails",
  },
  args: {
    vacuum: { type: "boolean", description: "Run VACUUM after the checks" },
    fix: {
      type: "boolean",
      description: "Release expired locks and remove cards whose file is gone; each is logged",
    },
    reviewed: {
      type: "string",
      description: "Clear needsReview on the record with this id, once you have looked at it",
    },
    ...json,
  },
  run: ({ args }) => {
    if (args.reviewed !== undefined) {
      const id = args.reviewed;
      return execute(
        args.json,
        ({ ctx }) => markReviewed(ctx, id),
        (r) => `Cleared needsReview on ${shortHandle(r.id)}.`,
      );
    }
    return output(
      args.json,
      async () => {
        const rt = await openRuntime();
        try {
          const git = rt.location.mode !== "standalone";
          // Before the checks, so the report shows the project as the cleanup left it.
          const lean = await leanCheck(rt.ctx, rt.location.root, git, args.fix === true);
          const checks: DoctorCheck[] = await doctorChecks(rt.ctx);
          checks.push(lean);
          const store = rt.ctx.store;
          if (store instanceof SqliteStore) {
            const integrity = await store.integrityCheck();
            checks.push({ name: "integrity", ok: integrity === "ok", detail: integrity });
            if (args.vacuum) await store.vacuum();
          }
          const synced = syncedDbWarning(rt.location.path);
          if (synced) checks.push({ name: "synced folder", ok: false, detail: synced });
          if (git) {
            const hooks = hooksCheck(rt.location.root);
            checks.push(hooks);
            if (hooks.ok) checks.push(await upgradeCheck(rt.location.root));
            const worktrees = await worktreesCheck(rt.ctx, rt.location.root);
            if (worktrees) checks.push(worktrees);
          }
          const build = buildCheck();
          if (build) checks.push(build);
          const ok = checks.every((c) => c.ok);
          // A failed check fails the command, or CI and scripts read a broken project as healthy.
          if (!ok) process.exitCode = ERROR_EXIT_CODES.VALIDATION;
          return { ok, environment: environment(rt.location.path), checks };
        } finally {
          await closeRuntime();
        }
      },
      (report: { ok: boolean; environment: Environment; checks: DoctorCheck[] }) =>
        `${environmentText(report.environment)}\n\n${checks(report.checks)}`,
    );
  },
});
