import { describe, expect, it } from "vitest";
import { detectSecret, refuseSecrets, scanRecord } from "../src/index.js";

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
  url: `see postgres://admin:${"hunter"}22x@db.internal:5432/app`,
  npm: `np${"m_"}${"a1".repeat(18)}`,
  gitlab: `gl${"pat-"}${"Z9".repeat(10)}`,
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
    "MAX_TOKENS=100000000\nPRIMARY_KEY=user_id_column\nSORT_KEY=created_at_desc",
    "Connect with postgres://user:password@localhost/app or https://$USER:$PASS@host",
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

describe("refuseSecrets", () => {
  it("names the field and never the secret, and lets clean text through", () => {
    expect(() =>
      refuseSecrets("note", { title: "ok", body: "Rotate keys on Friday" }),
    ).not.toThrow();
    let err: unknown;
    try {
      refuseSecrets("note", { title: "ok", body: `see ${fake.stripe}` });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "VALIDATION", message: expect.stringContaining("in body") });
    expect(JSON.stringify(err) + String(err)).not.toContain(fake.stripe);
  });
});
