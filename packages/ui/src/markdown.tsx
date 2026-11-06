import { lazy, type ReactNode, Suspense } from "react";

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
export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose">
      {chunks(source).map((chunk, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: chunks have no id and keep their order
        <Chunk key={i} chunk={chunk} />
      ))}
    </div>
  );
}

function Chunk({ chunk }: { chunk: ReturnType<typeof chunks>[number] }) {
  const code = (
    <pre>
      <code>{chunk.text}</code>
    </pre>
  );
  if (chunk.kind === "text") return <Block text={chunk.text} />;
  if (chunk.lang !== "mermaid") return code;
  return (
    <Suspense fallback={code}>
      <Mermaid source={chunk.text} />
    </Suspense>
  );
}

function Block({ text }: { text: string }) {
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
