import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR,
  TEMPLATE_DIR,
  TEMPLATE_MAX_BYTES,
  type TemplateFile,
  TemplateName,
} from "@sati/core";

/**
 * The project's own templates, `.sati/templates/<name>.md`. Read on every call, so an edit shows
 * without a restart. Only regular files are read: a symlink in a cloned repo could point anywhere.
 */
export function readTemplateFiles(root: string): TemplateFile[] {
  const dir = join(root, CONFIG_DIR, TEMPLATE_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: TemplateFile[] = [];
  for (const entry of names.sort()) {
    const name = entry.replace(/\.md$/u, "");
    if (name === entry || !TemplateName.safeParse(name).success) continue;
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > TEMPLATE_MAX_BYTES) continue;
    files.push({
      name,
      markdown: readFileSync(path, "utf8"),
      source: `${CONFIG_DIR}/${TEMPLATE_DIR}/${entry}`,
    });
  }
  return files;
}
