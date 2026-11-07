// Generates src/workflow.ts from the agent workflow pages in docs/guide/, so the docs and the
// `sati://workflow` resource cannot drift. Run with `pnpm --filter @sati/core gen:workflow`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const page = (name) => fileURLToPath(new URL(`../../../docs/guide/${name}`, import.meta.url));
const out = fileURLToPath(new URL("../src/workflow.ts", import.meta.url));

/** A template literal body for a Markdown page: the product name becomes `${CLI_NAME}`. */
function literal(markdown) {
  return (
    markdown
      .replace(/\\/gu, "\\\\")
      .replace(/`/gu, "\\`")
      .replace(/\$\{/gu, "\\${")
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the output is a template literal.
      .replace(/(?<![A-Za-z0-9])sati(?![A-Za-z0-9])/gu, "${CLI_NAME}")
  );
}

/** The TypeScript source for the code and general workflow pages. */
export function workflowSource(code, general) {
  return `import { CLI_NAME } from "./name.js";

/**
 * The full agent workflow: served as \`sati://workflow\` over MCP and written as the Claude Code
 * skill. The rules block in AGENTS.md points here.
 *
 * Generated from docs/guide/agent-workflow.md by scripts/gen-workflow.mjs. Edit the doc, not this.
 */
export const WORKFLOW = \`${literal(code)}\`;

/**
 * The workflow for a \`general\` project, which has no features, file locks or guard.
 *
 * Generated from docs/guide/agent-workflow-general.md by scripts/gen-workflow.mjs.
 */
export const GENERAL_WORKFLOW = \`${literal(general)}\`;
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = workflowSource(
    readFileSync(page("agent-workflow.md"), "utf8"),
    readFileSync(page("agent-workflow-general.md"), "utf8"),
  );
  if (process.argv.includes("--check")) {
    if (readFileSync(out, "utf8") !== source) {
      process.stderr.write(
        "src/workflow.ts is out of date. Run `pnpm --filter @sati/core gen:workflow`.\n",
      );
      process.exit(1);
    }
  } else {
    writeFileSync(out, source);
  }
}
