import { describe, expect, it } from "vitest";
import { CLI_NAME, PACKAGE_NAME } from "../src/index.js";

describe("name", () => {
  // The package name must end with the CLI name so `npx <pkg>` resolves the right binary.
  it("keeps package and CLI names consistent", () => {
    expect(PACKAGE_NAME.endsWith(`/${CLI_NAME}`)).toBe(true);
  });
});
