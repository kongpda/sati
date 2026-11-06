import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chunks, Markdown } from "../src/markdown.js";

const html = (source: string) => renderToStaticMarkup(<Markdown source={source} />);

// PLAN Security: sanitise Markdown rendering. Notes come from agents and from git, so raw HTML
// must never be parsed and only http(s) links may become anchors.
describe("Markdown", () => {
  it("shows raw HTML as text instead of parsing it", () => {
    const out = html('<img src=x onerror="alert(1)"> <script>alert(2)</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  it("links only http and https URLs, with noopener noreferrer", () => {
    const out = html(
      "[ok](https://example.com) [bad](javascript:alert(1)) [data](data:text/html,x)",
    );
    expect(out).toContain(
      '<a href="https://example.com" rel="noopener noreferrer" target="_blank">ok</a>',
    );
    expect(out).not.toMatch(/href="(?:javascript|data):/u);
  });

  it("keeps a fenced block whole across blank lines", () => {
    expect(chunks("a\n\n```ts\nx\n\ny\n```\n\nb")).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", lang: "ts", text: "x\n\ny" },
      { kind: "text", text: "b" },
    ]);
  });
});
