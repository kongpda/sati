import { type MutableRefObject, useDeferredValue, useEffect, useMemo } from "react";
import type { Snapshot, Task } from "../api.js";
import { boardOrder } from "../board.js";
import { inboxCount } from "../my-work.js";
import { COMMENT_TAG, threadOf } from "../thread.js";

const PAGES = [
  ["/", "Board"],
  ["/my-work", "My work"],
  ["/agents", "Agents"],
  ["/roadmap", "Roadmap"],
  ["/features", "Features"],
  ["/notes", "Notes"],
  ["/memory", "Memory"],
  ["/decisions", "Decisions"],
  ["/changes", "Changes"],
  ["/activity", "Activity"],
  ["/settings", "Settings"],
] as const;

/** One empty list, so a general project's data keeps the same identity between renders. */
const NONE: never[] = [];

/** Pages a general project does without: it has no features, file reservations or guard. */
export const CODE_ONLY = new Set<string>(["/agents", "/features"]);

/**
 * What the pages show: the snapshot as this project kind sees it, the pages offered, the tasks
 * that pass the filters (and in what order the board draws them), pinned notes, who works now.
 */
export function useView(
  snapshot: Snapshot | undefined,
  path: string,
  filter: string,
  feature: string,
  setFeature: (id: string) => void,
  column: string,
  visible: MutableRefObject<Task[]>,
) {
  const general = snapshot?.project?.kind === "general";
  // A general project shows no features or file reservations anywhere, even ones left over
  // from when it was a code project; they stay in the store and come back if it switches back.
  // Memoised: a new object each render would re-render the memoised board on every keystroke.
  const data = useMemo(
    () => (snapshot && general ? { ...snapshot, features: NONE, locks: NONE } : snapshot),
    [snapshot, general],
  );
  const pages = PAGES.filter(([href]) => !(general && CODE_ONLY.has(href)));
  // The feature filter is hidden in a general project, so it must not keep narrowing the board.
  useEffect(() => {
    if (general) setFeature("");
  }, [general, setFeature]);
  const pageLabel = pages.find(([href]) => href === path)?.[1];
  const projectName = data?.project?.name;
  // What waits for this person: shown next to "My work" on every page, and in the tab's title.
  const inbox = useMemo(() => (data ? inboxCount(data) : 0), [data]);
  // Each page names itself in the tab, and on a phone the nav bar scrolls to the current page.
  useEffect(() => {
    const title = [pageLabel, projectName ?? __PRODUCT_NAME__].filter(Boolean).join(" · ");
    document.title = inbox ? `(${inbox}) ${title}` : title;
    document
      .querySelector('.nav a[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pageLabel, projectName, inbox]);
  // Filtering reads every title and body: deferred, so typing stays quick on a big board.
  const lookFor = useDeferredValue(filter).toLowerCase();
  const tasks = useMemo(
    () =>
      (data?.tasks ?? []).filter((t) => {
        if (feature && t.featureId !== feature) return false;
        if (lookFor && !`${t.title} ${t.body}`.toLowerCase().includes(lookFor)) return false;
        return true;
      }),
    [data?.tasks, feature, lookFor],
  );
  visible.current = useMemo(
    () => (data ? boardOrder(tasks, data.features, column) : []),
    [data, tasks, column],
  );
  // The brand kit or event brief one click from the board; the brief gives agents the same 3.
  const pinned = (data?.notes ?? [])
    .filter((n) => n.pinned && !threadOf(n) && !n.tags.includes(COMMENT_TAG))
    .slice(0, 3);
  const now = new Date().toISOString();
  const working = (data?.tasks ?? []).filter((t) => t.claim && t.claim.leaseUntil > now);

  return { general, data, pages, inbox, tasks, pinned, working };
}
