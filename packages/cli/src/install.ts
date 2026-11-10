import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { CLI_NAME } from "@sati/core";

/** The project's own binary, as npm, pnpm and yarn link it. */
export const localBin = (root: string) => join(root, "node_modules", ".bin", CLI_NAME);

/** The same binary relative to the project root, for configs that agent tools start from there. */
export const LOCAL_BIN = `node_modules/.bin/${CLI_NAME}`;

/**
 * True when this process runs the copy installed in `root`'s node_modules (a dev dependency
 * started with `npx`, a package script or the `.bin` link), not a global install.
 */
export function isLocalInstall(
  root: string,
  script: string | undefined = process.argv[1],
): boolean {
  if (!script || !existsSync(localBin(root))) return false;
  try {
    // Windows paths ignore case, and git and Node may disagree on the drive letter's case.
    const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    const modules = fold(realpathSync(join(root, "node_modules")));
    return fold(realpathSync(script)).startsWith(`${modules}${sep}`);
  } catch {
    return false;
  }
}

/** How to tell the user to run a command: through npx for a project install. */
export const runHint = (root: string, args: string) =>
  `${isLocalInstall(root) ? "npx " : ""}${CLI_NAME} ${args}`;
