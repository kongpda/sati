/**
 * Old page addresses and where they went. The server answers every unknown path with the same
 * page, so a bookmark to a merged page is sent on by the client (review WP2). Each target may
 * carry a query part: `/activity` is the Log tab of Changes.
 */
const REDIRECTS: Readonly<Record<string, string>> = {
  "/activity": "/changes?tab=log",
};

/** The page and query an address stands for, after old addresses are sent on. Other query parts (a task) are kept. */
export function resolveUrl(
  pathname: string,
  search: string,
): { path: string; params: URLSearchParams; moved: boolean } {
  const target = REDIRECTS[pathname];
  const params = new URLSearchParams(search);
  if (!target) return { path: pathname, params, moved: false };
  const [path = pathname, own = ""] = target.split("?");
  for (const [k, v] of new URLSearchParams(own)) if (!params.has(k)) params.set(k, v);
  return { path, params, moved: true };
}
