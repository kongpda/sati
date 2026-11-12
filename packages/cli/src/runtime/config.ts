import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_NAME,
  CONFIG_DIR,
  CONFIG_FILE,
  invalidConfig,
  type ProjectKind,
  type SatiConfig,
  SatiConfigSchema,
  SatiError,
} from "@sati/core";
import { writeFileAtomic } from "@sati/sync";
import { parseJson } from "./input.js";
import type { Runtime } from "./location.js";

/**
 * The `.sati/` folder of a project that keeps its records there as files: git mode, or a
 * standalone project shared through a synced folder (ADR 0009). Stealth and a plain standalone
 * project keep nothing outside the database.
 */
export function sharedDir(rt: Pick<Runtime, "project" | "location">): string | undefined {
  const dir = join(rt.location.root, CONFIG_DIR);
  if (rt.project.mode === "git") return dir;
  if (rt.project.mode !== "standalone") return undefined;
  return readProjectConfig(rt.location.root)?.share === true ? dir : undefined;
}

/** `sharedDir`, or a usage error for a project that has no snapshot. */
export function snapshotDir(rt: Runtime): string {
  const dir = sharedDir(rt);
  if (dir) return dir;
  throw new SatiError(
    "USAGE",
    `\`${CLI_NAME} sync\` needs a snapshot in .sati/; this ${rt.project.mode} project keeps none.`,
    {
      hint:
        rt.project.mode === "standalone"
          ? `Run \`${CLI_NAME} sync share\` to share this folder's project through a file-sync app.`
          : "Only git mode keeps a committed snapshot in .sati/.",
    },
  );
}

/** `.sati/sati.config.json` of a project, or undefined when it has none (stealth mode). */
export function readProjectConfig(root: string): SatiConfig | undefined {
  const file = join(root, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = SatiConfigSchema.safeParse(parseJson(readFileSync(file, "utf8"), file));
  if (!parsed.success) throw invalidConfig(file, parsed.error);
  return parsed.data;
}

/**
 * Records the project kind in the committed config, so a teammate's clone gets it too (the
 * project row itself is not in the snapshot). Always written, both values: a config without
 * `kind` (made before kinds existed) means "no opinion", never a switch. Stealth has no file.
 */
/** Turns on sharing through the folder for a standalone project; false when it was on already. */
export function writeConfigShare(root: string): boolean {
  const config = readProjectConfig(root);
  if (!config || config.share === true) return false;
  writeFileAtomic(
    join(root, CONFIG_DIR, CONFIG_FILE),
    `${JSON.stringify({ ...config, share: true }, null, 2)}\n`,
  );
  return true;
}

export function writeConfigKind(root: string, kind: ProjectKind): void {
  const config = readProjectConfig(root);
  if (!config || config.kind === kind) return;
  writeFileAtomic(
    join(root, CONFIG_DIR, CONFIG_FILE),
    `${JSON.stringify({ ...config, kind }, null, 2)}\n`,
  );
}
