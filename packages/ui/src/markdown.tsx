import type { ReactNode } from "react";

/** Renders a small markdown subset as React nodes, so raw HTML is never parsed. Mermaid stays a code block. */
export function Markdown({ source }: { source: string }) {
  const blocks = source.replaceAll("\r\n", "\n").split(/\n{2,}/);
  return (
    <div className="prose">
      {blocks.map((block) => (
        <Block key={block} text={block} />
      ))}
    </div>
  );
}

function Block({ text }: { text: string }) {
  if (text.startsWith("```")) {
    const body = text.replace(/^```[^\n]*\n?/u, "").replace(/```$/u, "");
    return (
      <pre>
        <code>{body}</code>
      </pre>
    );
  }
  if (text.startsWith("# ")) return <h2>{inline(text.slice(2))}</h2>;
  if (text.startsWith("## ")) return <h3>{inline(text.slice(3))}</h3>;
  if (text.split("\n").every((line) => line.startsWith("- "))) {
    return (
      <ul>
        {text.split("\n").map((line) => (
          <li key={line}>{inline(line.slice(2))}</li>
        ))}
      </ul>
    );
  }
  return <p>{inline(text)}</p>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`/gu;
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
    }
    last = index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
