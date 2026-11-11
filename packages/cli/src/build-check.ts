import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD } from "./version.js";

/** The paths whose changes make a build old. Kept in step with tsdown.config.ts. */
const SOURCE = ["packages", "pnpm-lock.yaml"];

export interface BuildCheck {
  name: "build";
  ok: boolean;
  detail: string;
}

/**
 * Whether this bundle is behind the source it runs from. Only for a bundle inside a checkout of
 * the source (`packages/cli/dist`), which is how a source install runs: after `git pull`,
 * nothing else says the command still runs the old code. `undefined` when there is nothing to
 * compare: no build stamp, or an installed package.
 */
export function buildCheck(
  build: string = BUILD,
  dist: string = dirname(fileURLToPath(import.meta.url)),
): BuildCheck | undefined {
  if (build === "") return undefined;
  const root = join(dist, "..", "..", "..");
  if (!existsSync(join(root, ".git")) || !existsSync(join(root, "packages", "cli", "src"))) {
    return undefined;
  }
  const [sha = ""] = build.split(".");
  if (build.endsWith(".dirty")) {
    return {
      name: "build",
      ok: true,
      detail: `Built from ${sha} with changes that were not committed.`,
    };
  }
  const behind = `Run \`pnpm build\` in ${root}.`;
  try {
    execFileSync("git", ["diff", "--quiet", sha, "HEAD", "--", ...SOURCE], {
      cwd: root,
      stdio: "ignore",
    });
    return { name: "build", ok: true, detail: `Built from ${sha}; the source has no newer code.` };
  } catch (err) {
    // Exit 1 is "there are differences". Anything else: git is missing, or the commit is gone.
    return (err as { status?: number }).status === 1
      ? { name: "build", ok: false, detail: `Built from ${sha}; the source is newer. ${behind}` }
      : {
          name: "build",
          ok: false,
          detail: `Built from ${sha}, which this checkout cannot compare with. ${behind}`,
        };
  }
}
