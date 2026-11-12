import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createFeature, listAll } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute } from "../runtime/output.js";

const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".sati",
  ".turbo",
  "build",
  "out",
  "target",
  "vendor",
]);
const ROUTE_ROOTS = ["src/app", "app", "src/pages", "src/routes", "app/routes"];
const PAGE_FILES = ["page.tsx", "page.ts", "page.jsx", "+page.svelte", "route.ts"];

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function topLevel(root: string): { title: string; paths: string[] }[] {
  return readdirSync(root)
    .filter((name) => !name.startsWith(".") && !SKIP.has(name) && isDir(join(root, name)))
    .map((name) => ({ title: name, paths: [`${name}/**`] }));
}

function routeFolders(root: string): { title: string; paths: string[] }[] {
  const out: { title: string; paths: string[] }[] = [];
  for (const rel of ROUTE_ROOTS) {
    const base = join(root, rel);
    if (!isDir(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (name.startsWith(".") || !isDir(dir)) continue;
      const routeDir = rel.includes("route");
      const hasPage = PAGE_FILES.some((file) => existsSync(join(dir, file)));
      if (!routeDir && !hasPage) continue;
      out.push({ title: name, paths: [`${rel}/${name}/**`] });
    }
  }
  return out;
}

function dedupe(rows: { title: string; paths: string[] }[]): { title: string; paths: string[] }[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = row.paths[0] ?? row.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default defineCommand({
  meta: { name: "scan", description: "Propose features from top-level folders" },
  args: {
    apply: { type: "boolean", description: "Create the proposed features" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async (rt) => {
        const proposals = dedupe([
          ...topLevel(rt.location.root),
          ...routeFolders(rt.location.root),
        ]);
        // Skip what an earlier run (or a person) already made, so a rerun adds nothing.
        const existing = await rt.ctx.store.read((r) => listAll(r, rt.ctx, "feature"));
        const names = new Set(existing.map((f) => f.title.toLowerCase()));
        const globs = new Set(existing.flatMap((f) => f.paths));
        const fresh = proposals.filter(
          (p) => !names.has(p.title.toLowerCase()) && !p.paths.some((g) => globs.has(g)),
        );
        if (args.apply) {
          for (const proposal of fresh) await createFeature(rt.ctx, proposal);
        }
        return { proposals: fresh, created: Boolean(args.apply) && fresh.length > 0 };
      },
      (result) =>
        result.proposals.length
          ? result.proposals
              .map((p) => `${result.created ? "created" : "propose"} ${p.title}  ${p.paths[0]}`)
              .join("\n")
          : "No folders to propose.",
    ),
});
