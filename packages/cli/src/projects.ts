import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_NAME, SatiError } from "@sati/core";
import type { DbLocation } from "@sati/store-sqlite";
import { parseJson } from "./runtime.js";

interface KnownProject {
  slug: string;
  name: string;
  projectId: string;
  root: string;
  mode: "git" | "stealth" | "standalone";
  db: string;
}

function file(home = homedir()): string {
  return join(home, ".sati", "projects.json");
}

export function readProjects(home = homedir()): KnownProject[] {
  const path = file(home);
  if (!existsSync(path)) return [];
  const parsed = parseJson(readFileSync(path, "utf8"), path);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row): row is KnownProject => {
    if (row === null || typeof row !== "object") return false;
    const rec = row as Partial<KnownProject>;
    return (
      typeof rec.slug === "string" && typeof rec.db === "string" && typeof rec.root === "string"
    );
  });
}

export function rememberProject(project: KnownProject, home = homedir()): void {
  const all = readProjects(home).filter(
    (p) => p.slug !== project.slug && p.projectId !== project.projectId,
  );
  all.push(project);
  const path = file(home);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
}

export function projectLocation(slug: string, home = homedir()): DbLocation {
  const found = readProjects(home).find((p) => p.slug === slug);
  if (!found) {
    throw new SatiError("NOT_FOUND", `No project named ${slug} on this machine.`, {
      hint: `Run \`${CLI_NAME} projects\` to see them, or \`${CLI_NAME} init\` in the repository.`,
    });
  }
  return {
    path: found.db,
    root: found.root,
    mode: found.mode === "standalone" ? "standalone" : "git",
  };
}
