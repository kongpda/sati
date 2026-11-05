import { stripVTControlCharacters } from "node:util";
import { CLI_NAME } from "@sati/core/name";
import { type CommandDef, runCommand, runMain, showUsage } from "citty";

const HELP = new Set(["--help", "-h"]);

/** The command words before the first flag, e.g. `task create`. */
function words(argv: readonly string[]): string[] {
  const end = argv.findIndex((a) => a.startsWith("-"));
  return argv.slice(0, end === -1 ? argv.length : end);
}

/**
 * citty's `runMain` exits 1 on bad usage; sati documents exit code 2 (USAGE) for that, and
 * `--json` callers get the error as JSON. Help and version still go through `runMain`.
 */
export async function main(root: CommandDef): Promise<void> {
  const argv = process.argv.slice(2);
  const projectAt = argv.indexOf("--project");
  if (projectAt !== -1) {
    const slug = argv[projectAt + 1];
    if (!slug || slug.startsWith("-")) {
      process.stderr.write("error: --project needs a slug.\nhint: Run `sati projects`.\n");
      process.exitCode = 2;
      return;
    }
    process.env.SATI_PROJECT = slug;
    argv.splice(projectAt, 2);
  }
  if (argv.some((a) => HELP.has(a)) || (argv.length === 1 && argv[0] === "--version")) {
    await runMain(root);
    return;
  }
  if (argv.length === 0) {
    await showUsage(root);
    process.exitCode = 2;
    return;
  }
  try {
    await runCommand(root, { rawArgs: argv });
  } catch (err) {
    // Command handlers catch their own errors, so anything here is a parsing error from citty.
    const message = stripVTControlCharacters(err instanceof Error ? err.message : String(err));
    // An unknown subcommand is not worth repeating in the hint.
    const known = words(argv).slice(0, message.startsWith("Unknown command") ? 1 : 2);
    // Loaded only here: the core and SQLite stay out of `--version` and `--help`.
    const [{ SatiError }, { printError }] = await Promise.all([
      import("@sati/core"),
      import("./runtime.js"),
    ]);
    const usage = new SatiError("USAGE", message, {
      hint: `Run \`${[CLI_NAME, ...known, "--help"].join(" ")}\` for usage.`,
    });
    process.exitCode = printError(usage, argv.includes("--json"));
  }
}
