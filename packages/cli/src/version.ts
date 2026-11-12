import pkg from "../package.json" with { type: "json" };

/** Set by the bundler (tsdown.config.ts): the commit the bundle was built from, or "". */
declare const __SATI_BUILD__: string | undefined;
/** Set by the bundler: the date of that commit as `2026-11-11`, or "". */
declare const __SATI_BUILD_DATE__: string | undefined;

/**
 * The commit this bundle was built from, with `.dirty` when the source had changes that were
 * not committed. Empty when the build ran outside git, and when the source runs unbundled.
 */
export const BUILD: string = typeof __SATI_BUILD__ === "string" ? __SATI_BUILD__ : "";

/** The date of the commit in `BUILD`. It tells the age of a build without looking up the commit. */
const BUILD_DATE: string = typeof __SATI_BUILD_DATE__ === "string" ? __SATI_BUILD_DATE__ : "";

/**
 * The package version with the build after `+`, as semver build metadata: `0.1.0+a8104c0`.
 * Every build of one version said the same number, so a stale build looked like a fresh one.
 */
export const VERSION: string = BUILD ? `${pkg.version}+${BUILD}` : pkg.version;

/**
 * The line `--version` prints, in the form rustc uses: `sati 0.1.0 (a8104c0 2026-11-11)`.
 * `VERSION` stays the machine form, for the MCP server info. A build made outside git has
 * nothing in brackets.
 */
export function versionLine(
  name: string,
  version: string = pkg.version,
  build: string = BUILD,
  date: string = BUILD_DATE,
): string {
  if (build === "") return `${name} ${version}`;
  const commit = build.replace(/\.dirty$/u, "-dirty");
  return `${name} ${version} (${date ? `${commit} ${date}` : commit})`;
}
