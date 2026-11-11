import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The built CLI. */
export const bin = fileURLToPath(new URL("../../packages/cli/dist/index.mjs", import.meta.url));

export interface Ui {
  /** http://127.0.0.1:<port> */
  origin: string;
  /** The one-time sign-in URL `sati ui` prints. */
  signIn: string;
  repo: string;
  /** The environment `sati ui` and `sati` run with: git config kept out, a person as the actor. */
  env: Record<string, string>;
  /** Runs the CLI in the repo and returns parsed `--json` output. */
  sati: <T>(...args: string[]) => T;
  /** The same, as another actor: an agent's session, or a second person. */
  as: (actor: string, kind: "agent" | "person") => <T>(...args: string[]) => T;
  /** Calls the REST API with the session cookie, as the page would. */
  api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  stop: () => Promise<void>;
}

/**
 * A fresh git repo with `sati init`, and `sati ui --no-open` serving it on a free port. The board
 * runs as a person unless `runAs` names an agent's session, as when an agent starts it.
 */
export async function startUi(runAs?: { agent: string }): Promise<Ui> {
  if (!existsSync(bin)) throw new Error(`Build the CLI first (pnpm build): ${bin} is missing.`);
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "sati-ui-")));
  // `open` and `xdg-open` stand-ins record any launch: `sati ui --no-open` must never open a tab.
  const fakeBin = join(repo, ".fake-bin");
  const launched = join(repo, ".browser-launched");
  mkdirSync(fakeBin);
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(fakeBin, name), `#!/bin/sh\necho "$@" >> '${launched}'\n`);
    chmodSync(join(fakeBin, name), 0o755);
  }
  const registry = mkdtempSync(join(tmpdir(), "sati-registry-"));
  const env = {
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    // `sati init` chains into `core.hooksPath`; keep the developer's global git config out of it.
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    SATI_ACTOR: runAs?.agent ?? "playwright",
    // Keep these temp repos out of the developer's ~/.sati/projects.json (review 5.7).
    SATI_REGISTRY: join(registry, "projects.json"),
    CLAUDECODE: runAs ? "1" : "",
    AI_AGENT: "",
  };
  const run = (cmd: string, args: string[], more: Record<string, string> = {}) =>
    execFileSync(cmd, args, {
      cwd: repo,
      env: { ...env, ...more },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  run("git", ["init", "-q"]);
  run(process.execPath, [bin, "init", "--yes", "--tools", ""]);
  const sati = <T>(...args: string[]): T =>
    JSON.parse(run(process.execPath, [bin, ...args, "--json"])) as T;
  const as =
    (actor: string, kind: "agent" | "person") =>
    <T>(...args: string[]): T =>
      JSON.parse(
        run(process.execPath, [bin, ...args, "--json"], {
          SATI_ACTOR: actor,
          CLAUDECODE: kind === "agent" ? "1" : "",
        }),
      ) as T;

  const child: ChildProcess = spawn(process.execPath, [bin, "ui", "--no-open"], {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const signIn = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`sati ui did not start: ${out}`)), 15_000);
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      const url = /(http:\/\/127\.0\.0\.1:\d+\/session\?token=[\w-]+)/u.exec(out)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => reject(new Error(`sati ui exited with ${code}: ${out}`)));
  });
  const origin = new URL(signIn).origin;

  const signedIn = await fetch(signIn, { redirect: "manual" });
  const cookie = signedIn.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("The sign-in URL set no session cookie.");
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(origin + path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  const stop = async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    const opened = existsSync(launched);
    rmSync(repo, { recursive: true, force: true });
    rmSync(registry, { recursive: true, force: true });
    if (opened) throw new Error("`sati ui --no-open` launched a browser.");
  };
  const set = Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined);
  return { origin, signIn, repo, env: Object.fromEntries(set), sati, as, api, stop };
}
