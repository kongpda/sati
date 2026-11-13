import { useEffect, useRef, useState } from "react";
import { api, parentKind, type RecallItem, type Snapshot } from "../api.js";
import { GO_KEYS } from "../hooks/use-keys.js";
import { threadOf } from "../thread.js";
import { kindLabel } from "../words.js";

/** Where a search hit of each kind opens, and the tag it shows. */
const HIT_PAGES: Record<string, string> = {
  note: "/knowledge",
  decision: "/knowledge?kind=decisions",
  feature: "/plan?tab=features",
  context: "/knowledge?kind=cards",
};

/** The order of the result groups, and what each is called. */
const GROUPS: [entity: string, heading: string][] = [
  ["task", "Tasks"],
  ["note", "Notes"],
  ["decision", "Decisions"],
  ["feature", "Features"],
  ["context", "File cards"],
];

/** The board's search returns at most this many hits (the `/api/search` limit). */
const SEARCH_LIMIT = 20;

/**
 * Search. Its text and results live here, so typing does not re-render the board behind it.
 * Closing unmounts it, which clears them and puts focus back where it was.
 */
export function Palette({
  data,
  onClose,
  onGo,
  onShow,
  onToast,
  onError,
}: {
  data: Snapshot | undefined;
  onClose: () => void;
  onGo: (path: string, taskId?: string | null) => void;
  /** Opens a list page at one record. */
  onShow: (path: string, id: string) => void;
  onToast: (message: string) => void;
  onError: (err: unknown) => void;
}) {
  const [queryText, setQueryText] = useState("");
  const [hits, setHits] = useState<{ entity: string; id: string; title: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  /** The answer to "Ask: <text>", ranked like what `recall` gives an agent. */
  const [answer, setAnswer] = useState<{ items: RecallItem[]; omitted: number } | null>(null);
  const [asking, setAsking] = useState(false);
  /** The row the arrow keys are on, or -1 when none. */
  const [active, setActive] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchRun = useRef(0);
  // Asking replaces searching for this text: a pause-timer that fires after the click must not
  // start a search that drops the answer.
  const asked = useRef(false);
  useEffect(() => {
    const previous = document.activeElement;
    searchRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  /** Searches for `raw`. Only the latest search may show: an earlier, slower answer is dropped. */
  const search = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setSearching(true);
    setSearched(false);
    const run = ++searchRun.current;
    void api
      .search(text)
      .then((res) => {
        if (run !== searchRun.current) return;
        // A general project has no Features page to open a feature on.
        const general = data?.project?.kind === "general";
        setHits(res.hits.filter((h) => !(general && h.entity === "feature")));
        setSearched(true);
      })
      .catch((err: unknown) => {
        if (run === searchRun.current) onError(err);
      })
      .finally(() => {
        if (run === searchRun.current) setSearching(false);
      });
  };
  // Typing searches too, after a short pause and from two characters. Enter searches at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the text starts a search
  useEffect(() => {
    if (queryText.trim().length < 2) return;
    const id = window.setTimeout(() => {
      if (!asked.current) search(queryText);
    }, 200);
    return () => window.clearTimeout(id);
  }, [queryText]);
  const open = (hit: { entity: string; id: string }) => {
    const note = data?.notes.find((n) => n.id === hit.id);
    const on = note ? threadOf(note) : undefined;
    const about = on ? titleOf(on) : undefined;
    onClose();
    // A comment opens what it is on; one whose record was deleted says so.
    if (on && about === undefined) onToast("That comment is on something deleted.");
    else if (hit.entity === "task") onGo("/", hit.id);
    else if (on && data && parentKind(data, on) === "task") onGo("/", on);
    else onShow(HIT_PAGES[on && data ? parentKind(data, on) : hit.entity] ?? "/", on ?? hit.id);
  };
  const titleOf = (id: string) =>
    (data
      ? { task: data.tasks, decision: data.decisions, note: data.notes }[parentKind(data, id)]
      : undefined
    )?.find((r) => r.id === id)?.title;
  const needle = queryText.trim().toLowerCase();
  const pageRows = Object.values(GO_KEYS)
    .filter(([, name]) => !needle || name.toLowerCase().includes(needle))
    .map(([href, name]) => ({
      key: `go-${href}`,
      group: "Go to",
      label: (
        <>
          <span className="badge">Go to</span> {name}
        </>
      ),
      text: `Go to ${name}`,
      run: () => {
        onClose();
        onGo(href);
      },
    }));
  const hitRows = GROUPS.flatMap(([entity, heading]) =>
    hits
      .filter((h) => h.entity === entity)
      .map((hit) => {
        const note = data?.notes.find((n) => n.id === hit.id);
        const on = note ? threadOf(note) : undefined;
        const about = on ? titleOf(on) : undefined;
        return {
          key: `${hit.entity}-${hit.id}`,
          group: heading,
          label: (
            <>
              <span className="badge">{on ? "Comment" : kindLabel(hit.entity)}</span>{" "}
              {about ? `on ${about}` : hit.title}
            </>
          ),
          text: about ? `on ${about}` : hit.title,
          run: () => open(hit),
        };
      }),
  );
  const rows = [...pageRows, ...hitRows];
  return (
    <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
      <button
        type="button"
        className="palette-dismiss"
        aria-label="Close search"
        tabIndex={-1}
        onClick={onClose}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          search(queryText);
        }}
      >
        <input
          ref={searchRef}
          value={queryText}
          onChange={(e) => {
            setQueryText(e.target.value);
            // Hits for the old text would read as answers to the new one.
            searchRun.current++;
            setHits([]);
            setSearched(false);
            setSearching(false);
            setAnswer(null);
            setAsking(false);
            setActive(-1);
            asked.current = false;
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `palette-row-${active}` : undefined}
          onKeyDown={(e) => {
            const count = rows.length;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              if (!count) return;
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((i) => (i < 0 ? (step > 0 ? 0 : count - 1) : (i + step + count) % count));
            } else if (e.key === "Enter" && active >= 0 && rows[active]) {
              e.preventDefault();
              rows[active]?.run();
            }
          }}
          placeholder="Search tasks, notes, decisions, features and file cards"
          aria-label="Search"
        />
        <div role="status" className="meta">
          {searching
            ? "Searching…"
            : !searched
              ? "Type to search."
              : hits.length === 0
                ? "No results"
                : hits.length >= SEARCH_LIMIT
                  ? `First ${SEARCH_LIMIT} results`
                  : `${hits.length} result${hits.length === 1 ? "" : "s"}`}
        </div>
        {queryText.trim().length >= 3 ? (
          <button
            type="button"
            className="ask-row"
            onClick={() => {
              const question = queryText.trim();
              const run = ++searchRun.current;
              asked.current = true;
              setAsking(true);
              setAnswer(null);
              void api
                .recall(question)
                .then((res) => {
                  if (run === searchRun.current)
                    setAnswer({ items: res.items, omitted: res.omitted });
                })
                .catch((err: unknown) => {
                  if (run === searchRun.current) onError(err);
                })
                .finally(() => {
                  if (run === searchRun.current) setAsking(false);
                });
            }}
          >
            <span className="badge">Ask</span> Ask: {queryText.trim()}
          </button>
        ) : null}
        {asking ? <p className="meta">Asking…</p> : null}
        {answer ? (
          <section className="answer" aria-label="Answer" aria-live="polite">
            {answer.items.length === 0 ? (
              <p className="meta">
                Nothing in memory matches yet. Ask an agent to read the files and save cards.
              </p>
            ) : null}
            {answer.items.map((item) => (
              <article key={item.id} className="row">
                <span className={`badge kind-${item.kind}`}>{kindLabel(item.kind)}</span>{" "}
                <button
                  type="button"
                  className="row-link"
                  onClick={() => {
                    onClose();
                    onShow(HIT_PAGES[item.kind] ?? "/knowledge", item.id);
                  }}
                >
                  {item.title}
                </button>
                <p className="summary">
                  {item.text.length > 300 ? `${item.text.slice(0, 299)}…` : item.text}
                </p>
                {item.facts.length ? (
                  <ul className="facts">
                    {item.facts.slice(0, 5).map((f, i) => (
                      // Two lines may read the same; the position tells them apart.
                      // biome-ignore lint/suspicious/noArrayIndexKey: plain text lines have no ids
                      <li key={`${i}:${f}`}>{f}</li>
                    ))}
                  </ul>
                ) : null}
                {item.stale ? (
                  <p className="meta late">The file changed since; read it again.</p>
                ) : null}
              </article>
            ))}
            {answer.omitted > 0 ? (
              <p className="meta">{answer.omitted} more matched. Ask a narrower question.</p>
            ) : null}
          </section>
        ) : null}
        <div role="listbox" id="palette-results" aria-label="Results">
          {[...new Set(rows.map((r) => r.group))].map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: a fieldset inside a listbox is not valid
            <div role="group" aria-label={group} key={group}>
              <p className="meta group-heading" aria-hidden="true">
                {group}
              </p>
              {rows.map((row, i) =>
                row.group === group ? (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the input owns the keys (aria-activedescendant)
                  <div
                    role="option"
                    tabIndex={-1}
                    id={`palette-row-${i}`}
                    key={row.key}
                    aria-selected={i === active}
                    className={`palette-row${i === active ? " active" : ""}`}
                    onClick={row.run}
                    onMouseMove={() => setActive(i)}
                  >
                    {row.label}
                  </div>
                ) : null,
              )}
            </div>
          ))}
        </div>
      </form>
    </div>
  );
}
