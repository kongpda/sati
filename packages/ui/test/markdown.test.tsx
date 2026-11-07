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

  it("renders pipe tables and quotes, escaping their text", () => {
    const out = html("| Do | Don't |\n|---|:-:|\n| Sign up | <b>Register</b> |\n| Log in |");
    expect(out).toContain("<thead><tr><th>Do</th><th>Don&#x27;t</th></tr></thead>");
    // A short row still gets a cell per column; HTML in a cell stays text.
    expect(out).toContain(
      "<tr><td>Sign up</td><td>&lt;b&gt;Register&lt;/b&gt;</td></tr><tr><td>Log in</td><td></td></tr>",
    );
    expect(html("> Never deploy on **Fridays**.\n> Ask first.")).toContain(
      "<blockquote><p>Never deploy on <strong>Fridays</strong>.\nAsk first.</p></blockquote>",
    );
    // A list right after a paragraph line, with no blank line, is still a list.
    expect(html("Use the logo:\n- front\n- back")).toBe(
      '<div class="prose"><p>Use the logo:</p><ul><li>front</li><li>back</li></ul></div>',
    );
    // Pipes without a divider line are a paragraph.
    expect(html("| a | b |\n| c | d |")).toContain("<p>| a | b |");
  });

  it("keeps a fenced block whole across blank lines", () => {
    expect(chunks("a\n\n```ts\nx\n\ny\n```\n\nb")).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", lang: "ts", text: "x\n\ny" },
      { kind: "text", text: "b" },
    ]);
  });

  it("keeps a heading to its line, numbers lists, and marks bold and italic", () => {
    expect(html("# Launch\nThe body")).toBe(
      '<div class="prose"><h2>Launch</h2><p>The body</p></div>',
    );
    expect(html("1. Book the hall\n2. Print flyers")).toContain(
      "<ol><li>Book the hall</li><li>Print flyers</li></ol>",
    );
    expect(html("- a\n- a")).toContain("<ul><li>a</li><li>a</li></ul>");
    expect(html("**Due** Friday, *not* Monday")).toContain(
      "<strong>Due</strong> Friday, <em>not</em> Monday",
    );
  });
});
