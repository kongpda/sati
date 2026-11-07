import { describe, expect, it } from "vitest";
import type { Actor } from "../src/api.js";
import { COLORS, colorOf, initialsOf, personName } from "../src/people.js";

const actor = (fields: Partial<Actor>): Actor => ({
  id: "actr_1",
  name: "kong@main",
  kind: "human",
  tool: null,
  worktree: "/repo",
  ...fields,
});

describe("people", () => {
  it("never shows a person's user@worktree, and keeps an agent's session name", () => {
    expect(personName(actor({}))).toBe("kong");
    expect(personName(actor({ displayName: "Kong Da" }))).toBe("Kong Da");
    expect(personName(actor({ kind: "agent", name: "claude-code@feature-a#12" }))).toBe(
      "claude-code@feature-a#12",
    );
  });

  it("takes initials from the first two words, as whole graphemes", () => {
    expect(initialsOf(actor({ displayName: "kong da pheng" }))).toBe("KD");
    expect(initialsOf(actor({ name: "sok.vanna@main" }))).toBe("SV");
    expect(initialsOf(actor({ kind: "agent", name: "claude-code@feature-a#12" }))).toBe("CC");
    // ស + ុ is one grapheme; slicing code units would drop the vowel sign.
    expect(initialsOf(actor({ displayName: "សុខ វណ្ណា" }))).toBe("សុវ");
    expect(initialsOf(actor({ initials: "K" }))).toBe("K");
  });

  it("picks the same colour for one person in any worktree, unless one is chosen", () => {
    const main = colorOf(actor({ id: "actr_1", name: "kong@main" }));
    expect(colorOf(actor({ id: "actr_2", name: "kong@feature-a" }))).toBe(main);
    expect(COLORS).toContain(main);
    expect(colorOf(actor({ color: "plum" }))).toBe("plum");
  });
});
