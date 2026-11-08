import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "tsdown";

const KEPT = fileURLToPath(new URL("licenses", import.meta.url));

type Plugin = Extract<NonNullable<UserConfig["plugins"]>, { name: string }>;

/**
 * Writes THIRD_PARTY_LICENSES.md beside the bundle: the license (and NOTICE) text of every npm
 * package whose code ended up in it. Bundling copies their code into this package, so their
 * terms (MIT's notice, Apache-2.0's license and NOTICE) must ship with it.
 */
function thirdPartyLicenses(): Plugin {
  return {
    name: "third-party-licenses",
    generateBundle(_options, bundle) {
      const roots = new Set<string>();
      for (const out of Object.values(bundle)) {
        if (out.type !== "chunk") continue;
        for (const id of Object.keys(out.modules)) {
          const at = id.lastIndexOf("/node_modules/");
          if (at < 0) continue;
          const rest = id.slice(at + "/node_modules/".length).split("/");
          const name = rest[0]?.startsWith("@") ? rest.slice(0, 2).join("/") : rest[0];
          if (name) roots.add(`${id.slice(0, at)}/node_modules/${name}`);
        }
      }
      const sections: string[] = [];
      for (const root of [...roots].sort()) {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
          name: string;
          version: string;
          license?: string;
        };
        const texts = readdirSync(root)
          .filter((f) => /^(licen[cs]e|notice|copying)/i.test(f))
          .sort()
          .map((f) => readFileSync(join(root, f), "utf8").trim());
        if (texts.length === 0) {
          // A package that publishes without its license file (drizzle-orm): the text, copied
          // from its repository, is kept in licenses/<name>.txt.
          const kept = join(KEPT, `${pkg.name.replace("/", "__")}.txt`);
          if (!existsSync(kept)) {
            this.error(`${pkg.name} ships no license file; save its text as ${kept}.`);
          }
          texts.push(readFileSync(kept, "utf8").trim());
        }
        sections.push(
          `## ${pkg.name}@${pkg.version} (${pkg.license ?? "see below"})\n\n${texts.join("\n\n")}`,
        );
      }
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_LICENSES.md",
        source: `# Third-party licenses\n\nThe CLI bundles code from these packages. The web UI's are in ui/licenses.md.\n\n${sections.join("\n\n")}\n`,
      });
    },
  };
}

// Every runtime package is a devDependency, so tsdown bundles it and `npm install` fetches only
// this package: about 3 MB instead of 29. Only the code used ends up in the bundle, split per
// command, so `sati --version` loads none of it. SQLite is Node's built-in node:sqlite.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
  plugins: [thirdPartyLicenses()],
});
