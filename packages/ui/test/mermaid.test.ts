import { describe, expect, it } from "vitest";
import { type Scrubbable, scrub } from "../src/mermaid.js";

interface Fake extends Scrubbable {
  removed: boolean;
  attributes: { name: string; value: string }[];
  querySelectorAll(): Fake[];
}

function fake(localName: string, attrs: Record<string, string>, children: Fake[] = []): Fake {
  const attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }));
  const node: Fake = {
    localName,
    attributes,
    removed: false,
    remove() {
      node.removed = true;
    },
    removeAttribute(name: string) {
      const i = attributes.findIndex((a) => a.name === name);
      if (i >= 0) attributes.splice(i, 1);
    },
    querySelectorAll() {
      return children.flatMap((c) => [c, ...c.querySelectorAll()]);
    },
  };
  return node;
}

// PLAN Security: diagram source is untrusted, so even a hostile SVG from the renderer must not
// reach the page with script, event handlers or outbound links.
describe("scrub", () => {
  it("removes script and foreignObject, on* attributes and external links", () => {
    const script = fake("script", {});
    const fo = fake("foreignObject", {});
    const a = fake("a", {
      href: "javascript:alert(1)",
      "xlink:href": "https://evil.test",
      id: "k",
    });
    const local = fake("use", { href: "#node" });
    const rect = fake("rect", { onclick: "alert(1)", onLoad: "x()", fill: "red" });
    const root = fake("svg", { onload: "alert(1)" }, [script, fo, a, local, rect]);
    scrub(root);
    expect(script.removed).toBe(true);
    expect(fo.removed).toBe(true);
    expect(root.attributes).toEqual([]);
    expect(a.attributes).toEqual([{ name: "id", value: "k" }]);
    expect(local.attributes).toEqual([{ name: "href", value: "#node" }]);
    expect(rect.attributes).toEqual([{ name: "fill", value: "red" }]);
  });
});
