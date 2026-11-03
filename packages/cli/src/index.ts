import { CLI_NAME } from "@brain/core";
import { defineCommand, runMain } from "citty";
import pkg from "../package.json" with { type: "json" };

const main = defineCommand({
  meta: {
    name: CLI_NAME,
    version: pkg.version,
    description: pkg.description,
  },
});

await runMain(main);
