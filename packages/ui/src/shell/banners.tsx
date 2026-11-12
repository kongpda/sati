import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError, type Snapshot } from "../api.js";
import { personOnly } from "../moves.js";

/** What the page says above its content: an expired link, a lost connection, a failed load. */
export function Banners({
  query,
  data,
  expired,
  offline,
}: {
  query: UseQueryResult<Snapshot>;
  /** The snapshot as the pages see it. */
  data: Snapshot | undefined;
  expired: boolean;
  offline: boolean;
}) {
  return (
    <>
      {expired ? (
        <p className="banner" role="alert">
          This board link has expired, so changes are no longer shown or saved. Start the board
          again from your terminal and open the new link.
        </p>
      ) : offline ? (
        <p className="banner" role="status">
          Live updates disconnected. Reconnecting…
        </p>
      ) : null}
      {data && personOnly(data) ? (
        <p className="banner" role="status">
          {personOnly(data)?.replace(" to do this.", "")} to approve work, take over a task or
          change how people are shown.
        </p>
      ) : null}
      {data?.truncated && data.truncated.length > 0 ? (
        <p className="banner" role="status">
          This project has more {data.truncated.join(", ")} than the board shows; the oldest are
          left out. Search finds them.
        </p>
      ) : null}
      {query.isLoading ? (
        <p className="empty page" role="status">
          Loading…
        </p>
      ) : null}
      {query.isError && !data ? (
        <div className="empty page" role="alert">
          <p>
            Could not load. {query.error instanceof ApiError ? query.error.message : "Try again."}
          </p>
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </div>
      ) : null}
      {query.isError && data ? (
        <p className="banner" role="alert">
          The latest refresh failed, so this may be out of date.{" "}
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
    </>
  );
}
