import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, tempRepo } from "./helpers.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const agent = (name: string) => ({ SATI_ACTOR: name, AI_AGENT: "codex_1_agent" });
const json = <T>(cwd: string, args: string[], env: NodeJS.ProcessEnv) => {
  const r = run(cwd, [...args, "--json"], env);
  return { code: r.code, data: JSON.parse(r.stdout) as T };
};

/** A repo with one commit on main, `origin/main` pointing at it, and two linked worktrees. */
async function twoWorktrees() {
  const main = await tempRepo({ init: true });
  writeFileSync(join(main, "shared.ts"), "export const a = 1;\n");
  git(main, "add", "shared.ts");
  git(main, "commit", "-qm", "base");
  git(main, "update-ref", "refs/remotes/origin/main", "HEAD");
  const a = `${main}-a`;
  const b = `${main}-b`;
  git(main, "worktree", "add", "-q", "-b", "feat-a", a);
  git(main, "worktree", "add", "-q", "-b", "feat-b", b);
  return { main, a, b };
}

// PLAN Phase 5c: real git worktrees, not a fake RepoIndex.
describe("worktree coordination through git", () => {
  it("warns an agent about a file another worktree changed, and about a base conflict", async () => {
    const { main, a, b } = await twoWorktrees();
    const ta = json<{ id: string }>(main, ["task", "create", "A work"], {}).data.id;
    const tb = json<{ id: string }>(main, ["task", "create", "B work"], {}).data.id;
    expect(run(a, ["task", "claim", ta], agent("codex-a")).code).toBe(0);
    expect(run(b, ["task", "claim", tb], agent("codex-b")).code).toBe(0);
    writeFileSync(join(a, "shared.ts"), "export const a = 2;\n");
    writeFileSync(join(b, "shared.ts"), "export const a = 3;\n");

    const brief = run(a, ["brief"], agent("codex-a")).stdout;
    expect(brief).toContain("## Watch out (before you commit)");
    expect(brief).toContain("shared.ts is also changed by codex-b");

    // A lock makes one of them wait already, so the warning goes away.
    expect(run(b, ["lock", "acquire", "shared.ts"], agent("codex-b")).code).toBe(0);
    expect(run(a, ["brief"], agent("codex-a")).stdout).not.toContain("is also changed by");

    // main moves on with a different edit: A's committed change now conflicts with it.
    writeFileSync(join(main, "shared.ts"), "export const a = 9;\n");
    git(main, "commit", "-qam", "main moves");
    git(main, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(a, "commit", "-qam", "a edits");
    expect(run(a, ["brief"], agent("codex-a")).stdout).toContain(
      "Your branch conflicts with origin/main in shared.ts",
    );
    // The answer is kept per pair of commits; resolving the conflict moves HEAD, so it is redone.
    writeFileSync(join(a, "shared.ts"), "export const a = 9;\n");
    git(a, "commit", "-qam", "take main's value");
    expect(run(a, ["brief"], agent("codex-a")).stdout).not.toContain("Your branch conflicts");
  });

  it("pins a review to the branch commit and lists finished worktrees in doctor", async () => {
    const { main, a } = await twoWorktrees();
    const id = json<{ id: string }>(main, ["task", "create", "Ship A"], {}).data.id;
    run(a, ["task", "claim", id], agent("codex-a"));
    writeFileSync(join(a, "a.ts"), "1\n");
    git(a, "add", "a.ts");
    git(a, "commit", "-qm", "a");
    const sent = json<{ completion: { commit: string; branch: string } }>(
      a,
      ["task", "complete", id, "--summary", "done", "--files", "a.ts"],
      agent("codex-a"),
    );
    expect(sent.data.completion).toMatchObject({
      commit: git(a, "rev-parse", "HEAD"),
      branch: "feat-a",
    });
    const seen = sent.data.completion.commit;
    writeFileSync(join(a, "a.ts"), "2\n");
    git(a, "commit", "-qam", "after review");

    const person = { SATI_ACTOR: "dara" };
    const refused = run(
      main,
      ["task", "update", id, "--status", "done", "--approved-commit", seen, "--json"],
      person,
    );
    expect(refused.code).toBe(4);
    const head = git(a, "rev-parse", "HEAD");
    const done = json<{ completion: { approvedCommit: string } }>(
      main,
      ["task", "update", id, "--status", "done", "--approved-commit", head],
      person,
    );
    expect(done.data.completion.approvedCommit).toBe(head);

    // The empty worktree B is clean, merged and unused; A has unmerged commits.
    const doctor = run(main, ["doctor"], {}).stdout;
    expect(doctor).toMatch(/git worktree remove '.*-b'/);
    expect(doctor).not.toMatch(/git worktree remove '.*-a'/);
  });

  it("marks held tasks waiting from the Notification hook and clears them on the next prompt", async () => {
    const dir = await tempRepo({ init: true });
    const id = json<{ id: string }>(dir, ["task", "create", "Deploy"], {}).data.id;
    run(dir, ["task", "claim", id], agent("codex-a"));
    const hook = (payload: object) =>
      run(dir, ["wait", "--hook"], agent("codex-a"), JSON.stringify(payload));
    const notice = {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash",
    };
    expect(hook(notice)).toMatchObject({ code: 0, stdout: "" });
    const shown = json<{ claim: { waiting?: { kind: string } } }>(dir, ["task", "show", id], {});
    expect(shown.data.claim.waiting?.kind).toBe("permission");
    expect(run(dir, ["brief"], { SATI_ACTOR: "dara" }).stdout).toContain("needs a permission");
    expect(hook({ hook_event_name: "UserPromptSubmit", prompt: "go ahead" }).code).toBe(0);
    const after = json<{ claim: { waiting?: unknown } }>(dir, ["task", "show", id], {});
    expect(after.data.claim.waiting).toBeUndefined();
  });
});
