import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every `sati init` in a test registers its temp repo. Without this, a test run adds about a
// hundred entries to the developer's real ~/.sati/projects.json (review 5.7). One registry per
// test file, so files running in parallel do not rewrite the same file.
process.env.SATI_REGISTRY = join(mkdtempSync(join(tmpdir(), "sati-registry-")), "projects.json");
