import { lazy, memo, type ReactNode, Suspense, useMemo } from "react";

// pele and the diagram code load only when a note has a Mermaid block.
const Mermaid = lazy(() => import("./mermaid.js").then((m) => ({ default: m.Mermaid })));

type Chunk = { kind: "text"; text: string } | { kind: "code"; lang: string; text: string };

/** Splits on blank lines, but keeps a fenced block whole even when it holds blank lines. */
export function chunks(source: string): Chunk[] {
  const out: Chunk[] = [];
  let para: string[] = [];
  let fence: { lang: string; lines: string[] } | undefined;
  const flush = () => {
    if (para.length > 0) out.push({ kind: "text", text: para.join("\n") });
    para = [];
  };
  for (const line of source.replaceAll("\r\n", "\n").split("\n")) {
    if (fence) {
      if (line.trimEnd() === "```") {
        out.push({ kind: "code", lang: fence.lang, text: fence.lines.join("\n") });
        fence = undefined;
      } else fence.lines.push(line);
    } else if (line.startsWith("```")) {
      flush();
      fence = { lang: line.slice(3).trim().toLowerCase(), lines: [] };
    } else if (line.trim() === "") flush();
    else para.push(line);
  }
  // An unclosed fence still shows its text.
  if (fence) out.push({ kind: "code", lang: fence.lang, text: fence.lines.join("\n") });
  flush();
  return out;
}

/** Renders a small markdown subset as React nodes, so raw HTML is never parsed. */
export const Markdown = memo(function Markdown({ source }: { source: string }) {
  const parts = useMemo(() => chunks(source), [source]);
  // The body's top heading level renders as h3, under the h2 of the row or panel it sits in,
  // so a body that starts at `##` does not skip a level.
  const deep = useMemo(
    () => !parts.some((c) => c.kind === "text" && /^# /mu.test(c.text)),
    [parts],
  );
  return (
    <div className="prose">
      {parts.map((chunk, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: chunks have no id and keep their order
        <Chunk key={i} chunk={chunk} deep={deep} />
      ))}
    </div>
  );
});

function Chunk({ chunk, deep }: { chunk: ReturnType<typeof chunks>[number]; deep: boolean }) {
  const code = (
    <pre>
      <code>{chunk.text}</code>
    </pre>
  );
  if (chunk.kind === "text") return <Block text={chunk.text} deep={deep} />;
  if (chunk.lang !== "mermaid") return code;
  return (
    <Suspense fallback={code}>
      <Mermaid source={chunk.text} />
    </Suspense>
  );
}

function Block({ text, deep }: { text: string; deep: boolean }) {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const heading = first.startsWith("## ") ? (deep ? 3 : 4) : first.startsWith("# ") ? 3 : 0;
  if (heading > 0 && lines.length > 1) {
    // The heading line ends at its newline; the lines after it are their own block.
    return (
      <>
        <Block text={first} deep={deep} />
        <Block text={lines.slice(1).join("\n")} deep={deep} />
      </>
    );
  }
  // A paragraph line followed by a list (or a quote or table) with no blank line between is
  // still two blocks, as people type it: "Use the logo:\n- front\n- back".
  const runs = runsOf(lines);
  if (runs.length > 1) {
    return (
      <>
        {runs.map((run, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs have no id and keep their order
          <Block key={i} text={run.join("\n")} deep={deep} />
        ))}
      </>
    );
  }
  if (heading > 0) {
    const text = inline(first.slice(first.indexOf(" ") + 1));
    return heading === 3 ? <h3>{text}</h3> : <h4>{text}</h4>;
  }
  if (lines.every((line) => BULLET.test(line))) return <List items={listTree(lines)} />;
  if (lines.every((line) => line.startsWith(">"))) {
    return (
      <blockquote>
        <Block text={lines.map((line) => line.replace(/^> ?/u, "")).join("\n")} deep={deep} />
      </blockquote>
    );
  }
  if (isTable(lines)) {
    const [head = [], , ...body] = lines.map(cells);
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {head.map((cell, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells repeat and keep their order
                <th key={i}>{inline(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id and keep their order
              <tr key={r}>
                {head.map((_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: one cell per column
                  <td key={i}>{inline(row[i] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (lines.every((line) => /^\d+\. /u.test(line))) {
    return (
      <ol>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines repeat and keep their order
          <li key={`${i}:${line}`}>{inline(line.replace(/^\d+\. /u, ""))}</li>
        ))}
      </ol>
    );
  }
  return <p>{inline(text)}</p>;
}

/** A bullet: `- ` or `* `, indented to nest under the item above. */
const BULLET = /^\s*[-*] /u;

type Item = { text: string; children: Item[] };

/** Bullet lines as a tree: a line indented past the one above nests under it. */
function listTree(lines: string[]): Item[] {
  const indent = (line: string) => line.length - line.trimStart().length;
  const root = { indent: indent(lines[0] ?? ""), items: [] as Item[] };
  const stack = [root];
  for (const line of lines) {
    const depth = indent(line);
    const item = { text: line.trimStart().slice(2), children: [] };
    while (stack.length > 1 && depth < (stack.at(-1)?.indent ?? 0)) stack.pop();
    const top = stack.at(-1) ?? root;
    const parent = top.items.at(-1);
    if (depth > top.indent && parent) {
      stack.push({ indent: depth, items: parent.children });
      parent.children.push(item);
    } else top.items.push(item);
  }
  return root.items;
}

function List({ items }: { items: Item[] }) {
  return (
    <ul>
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items repeat and keep their order
        <li key={`${i}:${item.text}`}>
          {inline(item.text)}
          {item.children.length > 0 ? <List items={item.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

const lineKind = (line: string) =>
  /^#{1,2} /u.test(line)
    ? "heading"
    : BULLET.test(line)
      ? "ul"
      : /^\d+\. /u.test(line)
        ? "ol"
        : line.startsWith(">")
          ? "quote"
          : line.trimStart().startsWith("|")
            ? "table"
            : "text";

/** Consecutive lines of the same kind, so a list after a paragraph line gets its own block. */
function runsOf(lines: string[]): string[][] {
  const runs: string[][] = [];
  let kind = "";
  for (const line of lines) {
    const k = lineKind(line);
    if (k === kind) runs[runs.length - 1]?.push(line);
    else runs.push([line]);
    kind = k;
  }
  return runs;
}

/** A pipe table: every line starts with `|`, and the second line is the `|---|` divider. */
function isTable(lines: string[]): boolean {
  const divider = lines[1] ?? "";
  return (
    lines.length >= 2 &&
    lines.every((line) => line.trimStart().startsWith("|")) &&
    /^\s*\|(\s*:?-+:?\s*\|)+\s*$/u.test(divider)
  );
}

/** The cells of one table row, without the outer pipes. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((c) => c.trim());
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/gu;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    if (match[1] && match[2]) {
      out.push(
        <a key={index} href={match[2]} rel="noopener noreferrer" target="_blank">
          {match[1]}
        </a>,
      );
    } else if (match[3]) {
      out.push(<code key={index}>{match[3]}</code>);
    } else if (match[4]) {
      out.push(<strong key={index}>{match[4]}</strong>);
    } else if (match[5]) {
      out.push(<em key={index}>{match[5]}</em>);
    }
    last = index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
