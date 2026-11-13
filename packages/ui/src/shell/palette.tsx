import { useEffect, useRef, useState } from "react";
import { api, type RecallItem, type Snapshot } from "../api.js";
import { threadOf } from "../thread.js";
import { kindLabel } from "../words.js";

/** Where a search hit of each kind opens, and the tag it shows. */
const HIT_PAGES: Record<string, string> = {
  note: "/knowledge",
  decision: "/knowledge?kind=decisions",
  feature: "/plan?tab=features",
  context: "/knowledge?kind=cards",
};

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
  const searchRef = useRef<HTMLInputElement>(null);
  const searchRun = useRef(0);
  useEffect(() => {
    const previous = document.activeElement;
    searchRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
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
          const text = queryText.trim();
          if (!text) return;
          setSearching(true);
          setSearched(false);
          // Only the latest search may show: an earlier, slower answer is dropped.
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
          }}
          placeholder="Search tasks, notes, decisions, features and file cards"
          aria-label="Search"
        />
        <div role="status" className="meta">
          {searching
            ? "Searching…"
            : !searched
              ? "Press Enter to search."
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
        {hits.map((hit) => {
          const titleOf = (id: string) =>
            (id.startsWith("tsk_")
              ? data?.tasks
              : id.startsWith("dec_")
                ? data?.decisions
                : data?.notes
            )?.find((r) => r.id === id)?.title;
          const note = data?.notes.find((n) => n.id === hit.id);
          const on = note ? threadOf(note) : undefined;
          const about = on ? titleOf(on) : undefined;
          return (
            <button
              type="button"
              key={`${hit.entity}-${hit.id}`}
              onClick={() => {
                onClose();
                // A comment opens what it is on; one whose record was deleted says so.
                if (on && about === undefined) onToast("That comment is on something deleted.");
                else if (hit.entity === "task") onGo("/", hit.id);
                else if (on?.startsWith("tsk_")) onGo("/", on);
                else
                  onShow(
                    HIT_PAGES[on ? (on.startsWith("dec_") ? "decision" : "note") : hit.entity] ??
                      "/",
                    on ?? hit.id,
                  );
              }}
            >
              <span className="badge">{on ? "Comment" : kindLabel(hit.entity)}</span>{" "}
              {about ? `on ${about}` : hit.title}
            </button>
          );
        })}
      </form>
    </div>
  );
}
