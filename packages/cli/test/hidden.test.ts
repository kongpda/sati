import { defineCommand } from "citty";
import { describe, expect, it } from "vitest";
import { tree } from "../src/commands/completion.js";
import { type HelpLayout, usage } from "../src/help.js";

const noop = () => undefined;
const root = defineCommand({
  meta: { name: "sati", version: "0.0.0", description: "test root" },
  subCommands: {
    keep: defineCommand({
      meta: { name: "keep", description: "Shown." },
      args: {
        shown: { type: "boolean", description: "A flag people use" },
        old: { type: "boolean", description: "A flag kept for scripts" },
        legacy: { type: "boolean", alias: "gone", description: "Another kept flag" },
      },
      run: noop,
    }),
    twin: defineCommand({ meta: { name: "twin", description: "Same job as keep." }, run: noop }),
    meta: defineCommand({
      meta: { name: "meta", description: "Hidden by its own meta.", hidden: true },
      run: noop,
    }),
  },
});
const layout: HelpLayout = {
  groups: { Work: ["keep", "twin", "meta"] },
  aliases: {},
  hidden: ["twin"],
  hiddenFlags: { keep: ["old", "legacy"] },
};

describe("hidden commands and flags", () => {
  // D8, D9: an old name keeps working for scripts and old rule files, but help and completion
  // must offer one name per job, or the clean-up the review asks for never shows.
  it("a hidden command and a hidden flag still run but are not offered by help or completion", async () => {
    const rootHelp = await usage(root, [], layout);
    expect(rootHelp).toMatch(/^ {2}keep\s/mu);
    expect(rootHelp).not.toMatch(/^ {2}twin\s/mu);
    expect(rootHelp).not.toMatch(/^ {2}meta\s/mu);

    const keepHelp = await usage(root, ["keep"], layout);
    expect(keepHelp).toContain("--shown");
    expect(keepHelp).not.toContain("--old");
    expect(keepHelp).not.toContain("--legacy");

    const node = await tree(root, "sati", layout);
    expect(node.subs.map((s) => s.name)).toEqual(["keep"]);
    const flags = node.subs[0]?.flags.map((f) => f.name) ?? [];
    expect(flags).toContain("shown");
    expect(flags).not.toContain("old");
    expect(flags).not.toContain("legacy");

    // Not offered is not removed: citty still resolves the names.
    expect(Object.keys((root.subCommands ?? {}) as object)).toContain("twin");
    expect(Object.keys((await keepArgs()) as object)).toContain("old");
  });

  it("lists everything when nothing is hidden", async () => {
    const open: HelpLayout = {
      groups: { Work: ["keep", "twin"] },
      aliases: {},
      hidden: [],
      hiddenFlags: {},
    };
    expect(await usage(root, [], open)).toMatch(/^ {2}twin\s/mu);
    expect(await usage(root, ["keep"], open)).toContain("--old");
  });
});

async function keepArgs() {
  const subs = root.subCommands as Record<string, ReturnType<typeof defineCommand>>;
  return subs.keep?.args;
}
