import { useEffect, useRef, useState } from "react";

const MOVED = "data-pele-style";

/**
 * Turns pele's SVG string into nodes. The page CSP has no `'unsafe-inline'` for styles, and even
 * parsing a `style` attribute is a violation, so each one is renamed inside its tag first and then
 * set through CSSOM, which the CSP allows. pele has already escaped text and filtered links and
 * styles; `<` never appears in its text, so `<...>` spans are tags.
 */
export function svgNode(svg: string): Element | null {
  const renamed = svg.replace(/<[^<>]+>/gu, (tag) => tag.replace(/\sstyle="/gu, ` ${MOVED}="`));
  const doc = new DOMParser().parseFromString(renamed, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg") return null;
  const node = document.importNode(root, true);
  for (const el of [node, ...node.querySelectorAll(`[${MOVED}]`)]) {
    const style = el.getAttribute(MOVED);
    if (style === null) continue;
    el.removeAttribute(MOVED);
    if (el instanceof SVGElement) el.style.cssText = style;
  }
  scrub(node);
  return node;
}

const BANNED = new Set(["script", "foreignobject"]);

/** The parts of an Element that `scrub` uses, so it can be tested without a DOM. */
export interface Scrubbable {
  localName: string;
  attributes: ArrayLike<{ name: string; value: string }>;
  remove(): void;
  removeAttribute(name: string): void;
  querySelectorAll(selectors: string): ArrayLike<Scrubbable>;
}

/** Defence in depth: pele's output is trusted, but a regression must not become script. */
export function scrub(root: Scrubbable): void {
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    if (el !== root && BANNED.has(el.localName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const link = name === "href" || name === "xlink:href";
      if (name.startsWith("on") || (link && !attr.value.trim().startsWith("#"))) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A Mermaid block. pele loads on first use, so it stays out of the first-load bundle. */
export function Mermaid({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    setError(null);
    setReady(false);
    const fontFamily = getComputedStyle(document.body).fontFamily;
    import("pele/lazy")
      .then(({ renderAsync }) => renderAsync(source, { fontFamily }))
      .then(({ svg }) => {
        const node = svgNode(svg);
        if (!live) return;
        if (!node) throw new Error("The diagram could not be drawn.");
        ref.current?.replaceChildren(node);
        setReady(true);
      })
      .catch((e: unknown) => {
        if (live) setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [source]);

  if (error !== null) {
    return (
      <figure className="mermaid-error">
        <figcaption role="alert">Diagram error: {error}</figcaption>
        <pre>
          <code>{source}</code>
        </pre>
      </figure>
    );
  }
  return (
    <div
      ref={ref}
      className="mermaid"
      role="img"
      aria-label={`${source.trim().split(/\s/u)[0] ?? "Mermaid"} diagram`}
      aria-busy={!ready}
      data-ready={ready}
    />
  );
}
