import pkg from "../package.json" with { type: "json" };

/** Set by the bundler (tsdown.config.ts): the commit the bundle was built from, or "". */
declare const __SATI_BUILD__: string | undefined;

/**
 * The commit this bundle was built from, with `.dirty` when the source had changes that were
 * not committed. Empty when the build ran outside git, and when the source runs unbundled.
 */
export const BUILD: string = typeof __SATI_BUILD__ === "string" ? __SATI_BUILD__ : "";

/**
 * The package version with the build after `+`, as semver build metadata: `0.1.0+a8104c0`.
 * Every build of one version said the same number, so a stale build looked like a fresh one.
 */
export const VERSION: string = BUILD ? `${pkg.version}+${BUILD}` : pkg.version;
