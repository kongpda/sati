import type { Feature } from "../api.js";

/** The bar above every page: the board's filters (board page only), Search and New task. */
export function TopBar({
  onBoard,
  filter,
  setFilter,
  feature,
  setFeature,
  features,
  setPalette,
  setCreating,
}: {
  onBoard: boolean;
  filter: string;
  setFilter: (text: string) => void;
  feature: string;
  setFeature: (id: string) => void;
  /** Undefined until the snapshot loads. */
  features: readonly Feature[] | undefined;
  setPalette: (open: boolean) => void;
  setCreating: (open: boolean) => void;
}) {
  return (
    <div className="top">
      {/* The filters only narrow the board, so other pages do not show them. */}
      {onBoard ? (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tasks"
            aria-label="Filter tasks"
          />
          {features && features.length === 0 ? null : (
            <select
              value={feature}
              onChange={(e) => setFeature(e.target.value)}
              aria-label="Feature"
            >
              <option value="">All features</option>
              {features?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
            </select>
          )}
        </>
      ) : null}
      <button type="button" onClick={() => setPalette(true)}>
        Search
      </button>
      <button
        type="button"
        className="primary"
        onClick={() => setCreating(true)}
        aria-keyshortcuts="c"
      >
        New task
      </button>
    </div>
  );
}
