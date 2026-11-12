import { type KeyboardEvent, useRef } from "react";

/**
 * The tab to focus once the page has swapped its content: the page under a tab is a different
 * component, so the tab list mounts again and the focused button is gone.
 */
let focusNext: string | null = null;

/**
 * Tabs for one page, kept in the address (`?tab=log`) so a link can be shared and Back works.
 * Left and Right move between tabs, Home and End jump, as a tab list does.
 */
export function Tabs({
  label,
  tabs,
  current,
  onSelect,
}: {
  label: string;
  tabs: readonly (readonly [id: string, name: string])[];
  current: string;
  onSelect: (id: string) => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const move = (e: KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const to =
      e.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : e.key === "ArrowLeft"
          ? (index + last) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    const next = tabs[to];
    if (!next) return;
    e.preventDefault();
    focusNext = next[0];
    onSelect(next[0]);
    refs.current.get(next[0])?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map(([id, name], i) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`tab-${id}`}
          ref={(el) => {
            if (!el) return;
            refs.current.set(id, el);
            if (focusNext === id) {
              focusNext = null;
              el.focus();
            }
          }}
          aria-selected={current === id}
          tabIndex={current === id ? 0 : -1}
          onClick={() => onSelect(id)}
          onKeyDown={(e) => move(e, i)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
