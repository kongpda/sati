import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIdFactory,
  createNote,
  createTask,
  fixedClock,
  initProject,
  type ServiceContext,
} from "@brain/core";
import { SqliteStore } from "@brain/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { detectSecret, exportSnapshot, scanRecord } from "../src/index.js";

// Fake secrets are built from pieces so this file itself never trips a secret scanner.
const fake = {
  aws: `AK${"IA"}${"ABCDEFGHIJ234567"}`,
  github: `gh${"p_"}${"a1".repeat(18)}`,
  githubPat: `github${"_pat_"}${"B2".repeat(15)}`,
  slack: `xo${"xb-"}1234567890-abcdef`,
  sk: `s${"k-"}ant-${"x9".repeat(15)}`,
  stripe: `s${"k_live_"}${"Q".repeat(24)}`,
  google: `AI${"za"}${"S".repeat(35)}`,
  jwt: `ey${"J"}hbGciOiJIUzI1.ey${"J"}zdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4`,
  pem: `-----BEGIN RSA ${"PRIVATE"} KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----`,
  env: `DATABASE_URL=postgres://db\nSTRIPE_SECRET=${"r".repeat(4)}9a8b7c6d`,
};

describe("detectSecret", () => {
  // PLAN Security: scan every exported record for API keys, tokens, private keys and .env lines.
  it.each(Object.entries(fake))("finds a %s secret inside prose", (_name, secret) => {
    expect(detectSecret(`Notes from today:\n${secret}\nthat is all`)).toBeDefined();
  });

  // False positives block commits, so ordinary task text must pass.
  it.each([
    "Rotate the API key before Friday",
    "token = getToken(); password = prompt()",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} reference is the input.
    "API_KEY=$API_KEY\nSECRET_TOKEN=${SECRET_TOKEN}\nPASSWORD=<your password>",
    "GITHUB_TOKEN=xxxxxxxxxxxx",
    "PRIMARY_KEY_COLUMN=id",
    "Use sk-learn for the model; see task-1234",
    "-----BEGIN PUBLIC KEY-----",
  ])("passes ordinary text: %s", (text) => {
    expect(detectSecret(text)).toBeUndefined();
  });
});

describe("scanRecord", () => {
  it("names the entity, id and nested field, and never the secret", () => {
    const found = scanRecord("task", {
      id: "tsk_1",
      title: "ok",
      acceptance: ["fine", `token ${fake.github}`],
      meta: { deep: fake.aws },
    });
    expect(found).toEqual([
      { entity: "task", id: "tsk_1", field: "acceptance.1", kind: "GitHub token" },
      { entity: "task", id: "tsk_1", field: "meta.deep", kind: "AWS access key" },
    ]);
    expect(JSON.stringify(found)).not.toContain(fake.github);
  });
});

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function clone(): Promise<{ ctx: ServiceContext; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "brain-secrets-"));
  dirs.push(dir);
  const store = await SqliteStore.open(join(dir, "brain.db"));
  stores.push(store);
  const deps = { store, clock: fixedClock("2026-11-03T12:00:00.000Z"), ids: createIdFactory() };
  const { project, actor } = await initProject(
    deps,
    { slug: "demo", name: "Demo" },
    { name: "agent@test", kind: "agent" },
  );
  return { ctx: { ...deps, projectId: project.id, actorId: actor.id, branch: "main" }, dir };
}

describe("exportSnapshot secret refusal", () => {
  // PLAN Security: refuse with a clear message before writing to .brain/, so no commit carries it.
  it("refuses the whole export, writes no file, and does not print the secret", async () => {
    const { ctx, dir } = await clone();
    const out = join(dir, ".brain");
    await createTask(ctx, { title: "Clean task" });
    const note = await createNote(ctx, { title: "Setup", body: `Use ${fake.sk} for staging` });

    const err = await exportSnapshot(ctx, out).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining(`note ${note.id}, field body: API key (sk-)`),
    });
    expect(String((err as Error).message) + JSON.stringify(err)).not.toContain(fake.sk);
    expect(existsSync(out)).toBe(false);
  });
});
