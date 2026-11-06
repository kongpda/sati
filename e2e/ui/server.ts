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
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../../packages/cli/dist/index.mjs", import.meta.url));

export interface Ui {
  /** http://127.0.0.1:<port> */
  origin: string;
  /** The one-time sign-in URL `sati ui` prints. */
  signIn: string;
  repo: string;
  /** Runs the CLI in the repo and returns parsed `--json` output. */
  sati: <T>(...args: string[]) => T;
  /** Calls the REST API with the session cookie, as the page would. */
  api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  stop: () => Promise<void>;
}

/** A fresh git repo with `sati init`, and `sati ui --no-open` serving it on a free port. */
export async function startUi(): Promise<Ui> {
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
  const env = {
    ...process.env,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    SATI_ACTOR: "playwright",
    CLAUDECODE: "",
    AI_AGENT: "",
  };
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, {
      cwd: repo,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  run("git", ["init", "-q"]);
  run(process.execPath, [bin, "init", "--yes", "--tools", ""]);
  const sati = <T>(...args: string[]): T =>
    JSON.parse(run(process.execPath, [bin, ...args, "--json"])) as T;

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
    if (opened) throw new Error("`sati ui --no-open` launched a browser.");
  };
  return { origin, signIn, repo, sati, api, stop };
}
