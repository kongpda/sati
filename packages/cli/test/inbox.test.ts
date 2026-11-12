import { describe, expect, it } from "vitest";
import { run, sati, satiJson, tempRepo } from "./helpers.js";

interface Row {
  id: string;
  title: string;
  asks?: { text: string; by: string };
  blockedReason?: string;
  summary?: string;
}
interface Inbox {
  for: { name: string };
  count: number;
  needsAnswer: Row[];
  mentions: { on: string; onTitle: string; by: string; body: string }[];
  approval: Row[];
  assigned: Row[];
  due: Row[];
}

/*
 * PLAN Phase 10 (H1): a person with a terminal and no browser sees what the board's My work page
 * shows. Each section here is one a person would otherwise miss: an agent waiting on an answer
 * stays stuck, and finished work waits unapproved.
 */
describe("sati inbox", () => {
  async function project() {
    const dir = await tempRepo({ init: true });
    const make = (...args: string[]) =>
      satiJson<{ id: string; claim?: { token: number } }>(dir, "task", "create", ...args).data.id;
    // Everyone's finished work waits for a person, so a completed task lands in review.
    expect(sati(dir, "settings", "--review", "all").code).toBe(0);
    const asked = make("Pick a database");
    expect(sati(dir, "task", "claim", asked).code).toBe(0);
    expect(sati(dir, "wait", "Postgres or SQLite?", "--task", asked).code).toBe(0);
    const stuck = make("Deploy");
    expect(
      sati(dir, "task", "update", stuck, "--status", "blocked", "--reason", "No key").code,
    ).toBe(0);
    const built = make("Build the export");
    const claim = satiJson<{ claim: { token: number } }>(dir, "task", "claim", built).data;
    expect(
      sati(
        dir,
        "task",
        "complete",
        built,
        "--token",
        String(claim.claim.token),
        "--summary",
        "Export writes CSV.",
        "--files",
        "src/export.ts",
      ).code,
    ).toBe(0);
    const mine = make("Write the notes", "--assign", "me");
    const soon = make("Send the invoice", "--due", "2020-01-01");
    make("Far away", "--due", "2999-01-01");
    const said = run(dir, ["comment", "add", soon, "@tester is the amount right?"], {
      SATI_ACTOR: "bob",
    });
    expect(said.code).toBe(0);
    return { dir, asked, stuck, built, mine, soon };
  }

  it("lists each section with --json, with the ids the board would show", async () => {
    const { dir, asked, stuck, built, mine, soon } = await project();
    const { code, data } = satiJson<Inbox>(dir, "inbox");
    expect(code).toBe(0);
    expect(data.for.name).toBe("tester");
    expect(data.needsAnswer.map((t) => t.id)).toEqual([asked, stuck]);
    expect(data.needsAnswer[0]?.asks?.text).toBe("Postgres or SQLite?");
    expect(data.needsAnswer[1]?.blockedReason).toBe("No key");
    expect(data.approval.map((t) => t.id)).toEqual([built]);
    expect(data.approval[0]?.summary).toBe("Export writes CSV.");
    expect(data.assigned.map((t) => t.id)).toEqual([mine]);
    expect(data.due.map((t) => t.id)).toEqual([soon]);
    expect(data.mentions).toMatchObject([{ on: soon, onTitle: "Send the invoice", by: "bob" }]);
    expect(data.count).toBe(4);
  });

  // A pipe gets one line per item that starts with its section, so `grep ^approve` works.
  it("prints one line per item in a pipe, each starting with its section", async () => {
    const { dir } = await project();
    const out = sati(dir, "inbox");
    expect(out.code).toBe(0);
    const lines = out.stdout.trimEnd().split("\n");
    expect(lines.map((l) => l.split("  ")[0])).toEqual([
      "needs",
      "needs",
      "mention",
      "approve",
      "assigned",
      "due",
    ]);
    expect(lines[0]).toContain("tester asks: Postgres or SQLite?");
    expect(lines[1]).toContain("blocked: No key");
    expect(lines[2]).toContain("Send the invoice");
    expect(lines[2]).toContain("@tester is the amount right?");
    expect(lines[3]).toContain("Export writes CSV. (1 file)");
  });

  it("shows another person's inbox with --for, and says so when the name is nobody", async () => {
    const { dir } = await project();
    const bob = satiJson<Inbox>(dir, "inbox", "--for", "bob");
    expect(bob.data.for.name).toBe("bob");
    // Bob wrote the comment, so it does not call him; nothing is assigned to him.
    expect(bob.data.mentions).toEqual([]);
    expect(bob.data.assigned).toEqual([]);
    const none = sati(dir, "inbox", "--for", "zed");
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain('No actor is named "zed".');
  });

  it("says nothing waits in an empty project", async () => {
    const dir = await tempRepo({ init: true });
    expect(sati(dir, "inbox").stdout.trim()).toBe("Nothing waits for you.");
  });
});
