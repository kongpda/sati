import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Deletable, phoneColumn, type Task } from "./api.js";
import { NewTask, SendBack } from "./forms.js";
import { useCards } from "./hooks/use-cards.js";
import { useKeys } from "./hooks/use-keys.js";
import { useLive } from "./hooks/use-live.js";
import { useMoves } from "./hooks/use-moves.js";
import { REVEAL } from "./hooks/use-paged.js";
import { useRoute } from "./hooks/use-route.js";
import { useSelection } from "./hooks/use-selection.js";
import { useToast } from "./hooks/use-toast.js";
import { useView } from "./hooks/use-view.js";
import { needsReason } from "./moves.js";
import { TaskSheetPanel } from "./pages/connected.js";
import { Routes } from "./pages/routes.js";
import { usePrefs } from "./prefs.js";
import { Banners } from "./shell/banners.js";
import { KeyboardHelp } from "./shell/keyboard-help.js";
import { Nav } from "./shell/nav.js";
import { Palette } from "./shell/palette.js";
import { toastBox } from "./shell/toast.js";
import { TopBar } from "./shell/top-bar.js";

/** The phone layout in styles.css: one column at a time. */
const PHONE = "(max-width: 700px)";
/** Matches the stylesheet, which shows the board beside the task panel from this width. */
const WIDE = "(min-width: 1100px)";

export function App() {
  // The chosen colours. `public/theme.js` sets the same attribute before first paint.
  const { theme } = usePrefs();
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const query = useQuery({ queryKey: ["snapshot"], queryFn: api.snapshot });
  const client = useQueryClient();
  const { path, params, task, cursor, go, setSheetDirty, setDraft } = useRoute();
  // After a page change, focus goes to the page's heading, so a screen reader hears the page
  // and the next Tab starts at its top. Not on the first load, which has nothing to announce.
  const shownPath = useRef(path);
  useEffect(() => {
    if (shownPath.current === path) return;
    shownPath.current = path;
    const heading = document.querySelector<HTMLElement>("main h1, .page h1");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [path]);
  const [filter, setFilter] = useState("");
  const [feature, setFeature] = useState("");
  // On a phone, null until the person picks a column: the board picks one that has tasks.
  const [picked, setColumn] = useState<string | null>(() =>
    window.matchMedia(PHONE).matches ? null : "all",
  );
  const column = picked ?? phoneColumn(query.data?.tasks ?? []);
  const { selected, setSelected, toggle, selectColumn, bulkTargets, reviewing, approveRefusal } =
    useSelection(query.data);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const { toast, setToast, setToastState, fail, copyFailed } = useToast();
  const [palette, setPalette] = useState(false);
  const [creating, setCreating] = useState(false);
  const [help, setHelp] = useState(false);
  /** Tasks on their way back from review, held until the person says what still needs doing. */
  const [sendingBack, setSendingBack] = useState<{
    ids: string[];
    status: string;
    bulk: boolean;
  } | null>(null);
  const [offline, setOffline] = useState(false);
  /** The session cookie was refused (the board server restarted): updates will not come back. */
  const [expired, setExpired] = useState(false);
  /** Board moves waiting for the server; live refetches wait too, or a card would jump back. */
  const moving = useRef(0);
  /** The cards as the board shows them, set on each render for the key handler. */
  const visible = useRef<Task[]>([]);
  /** On a wide screen the task panel sits beside the board, which stays usable. */
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const media = window.matchMedia(WIDE);
    const onChange = () => setWide(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // A phone shows one column, a wider screen all of them; turning or resizing past the
  // breakpoint switches, or the board keeps a layout made for the other width.
  useEffect(() => {
    const phone = window.matchMedia(PHONE);
    const onChange = () => setColumn(phone.matches ? null : "all");
    phone.addEventListener("change", onChange);
    return () => phone.removeEventListener("change", onChange);
  }, []);

  const { general, data, pages, inbox, tasks, pinned, morePinned, working } = useView(
    query.data,
    path,
    filter,
    feature,
    setFeature,
    column,
    visible,
  );

  /** Opens a list page scrolled to one record, with focus on it, as a link to it would. */
  const show = useCallback(
    (next: string, id: string) => {
      if (!go(next)) return;
      // After the page has rendered.
      requestAnimationFrame(() => {
        const focus = () => {
          const row = document.getElementById(id);
          row?.scrollIntoView({ block: "center" });
          row?.focus();
          return row !== null;
        };
        if (focus()) return;
        // A long list draws a page at a time: ask it to draw this row, then try again.
        window.dispatchEvent(new CustomEvent(REVEAL, { detail: id }));
        requestAnimationFrame(focus);
      });
    },
    [go],
  );

  const saved = useCallback(
    (message: string) => {
      setToast(message);
      return client.invalidateQueries({ queryKey: ["snapshot"] });
    },
    [client, setToast],
  );

  // Deletes are soft and need no "are you sure": the toast offers Undo, which restores it.
  const remove = useCallback(
    (entity: Deletable, id: string, title: string) =>
      void api
        .remove(entity, id)
        .then(() => {
          setToast(
            `Deleted ${title}.`,
            () =>
              void api
                .restore(entity, id)
                .then(() => saved(`Restored ${title}.`))
                .catch(fail),
          );
          return client.invalidateQueries({ queryKey: ["snapshot"] });
        })
        .catch(fail),
    [client, fail, saved, setToast],
  );
  const thread = {
    onAdd: (on: string, body: string) =>
      api
        .addComment(on, body)
        .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
        .catch((err: unknown) => {
          fail(err);
          throw err;
        }),
    onDelete: (id: string, title: string) => remove("note", id, title),
    onDraft: setDraft,
  };

  const ctx = { client, saved, fail, setToast, remove, go, path, params, thread };
  const closePalette = useCallback(() => setPalette(false), []);

  useLive(client, moving, setOffline, setExpired, setFresh);
  const { moveMany, requestMove } = useMoves(
    client,
    moving,
    setToastState,
    fail,
    setSelected,
    setSendingBack,
  );
  useKeys({
    palette,
    closePalette,
    setPalette,
    setCreating,
    setHelp,
    setSelected,
    go,
    path,
    task,
    visible,
    cursor,
  });

  const { openTask, reviewed, refusal, heldBy, moveCard } = useCards(
    client,
    data,
    requestMove,
    fail,
    go,
  );

  // While New task, Search or (on a narrow screen) the task panel is open, the page behind it
  // takes no focus or clicks, so Tab stays inside the dialog (aria-modal alone does not stop it).
  // A wide screen shows the panel beside the board, which stays usable: click another card to
  // switch tasks.
  // "Working now" is a live lease. A claim whose lease ended is an agent that stopped; the card
  // says so, and this strip must not show it as at work.
  const sheetOpen = task !== null && !!data?.tasks.some((t) => t.id === task);
  const dialog = creating || palette || help || sendingBack !== null;
  const modal = dialog || (sheetOpen && !wide);

  return (
    <div className="app">
      <Nav
        pages={pages}
        path={path}
        projectName={data?.project?.name}
        inbox={inbox}
        modal={modal}
        go={go}
        onHelp={() => setHelp(true)}
      />
      <main className="main" inert={modal} data-modal={modal ? "" : undefined}>
        <TopBar
          onBoard={path === "/"}
          filter={filter}
          setFilter={setFilter}
          feature={feature}
          setFeature={setFeature}
          features={data?.features}
          setPalette={setPalette}
          setCreating={setCreating}
        />
        <Banners query={query} data={data} expired={expired} offline={offline} />
        <Routes
          ctx={ctx}
          data={data}
          general={general}
          show={show}
          copyFailed={copyFailed}
          board={{
            data,
            tasks,
            pinned,
            morePinned,
            filter,
            clearFilters: () => {
              setFilter("");
              setFeature("");
            },
            setCreating,
            setSelected,
            working,
            column,
            setColumn,
            selected,
            reviewing,
            approveRefusal,
            bulkTargets,
            fresh,
            task,
            go,
            show,
            moveMany,
            requestMove,
            setToastState,
            openTask,
            toggle,
            selectColumn,
            reviewed,
            moveCard,
            refusal,
            heldBy,
          }}
        />
      </main>
      {data && task ? (
        <TaskSheetPanel
          data={data}
          task={task}
          wide={wide}
          dialog={dialog}
          setSheetDirty={setSheetDirty}
          client={client}
          saved={saved}
          fail={fail}
          setToast={setToast}
          remove={remove}
          go={go}
          path={path}
          params={params}
          thread={thread}
        />
      ) : null}
      {creating && data ? (
        <NewTask
          data={data}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setToast(`Created ${created.title}.`);
            void client.invalidateQueries({ queryKey: ["snapshot"] });
          }}
        />
      ) : null}
      {sendingBack && data ? (
        <SendBack
          titles={sendingBack.ids.flatMap((id) => {
            const t = data.tasks.find((x) => x.id === id);
            return t && needsReason(t, sendingBack.status) ? [t.title] : [];
          })}
          onClose={() => setSendingBack(null)}
          onSend={async (reason) => {
            const { ids, status, bulk } = sendingBack;
            setSendingBack(null);
            await moveMany(ids, status, bulk, reason);
          }}
        />
      ) : null}
      {help ? <KeyboardHelp onClose={() => setHelp(false)} /> : null}
      {palette ? (
        <Palette
          data={data}
          onClose={() => setPalette(false)}
          onGo={go}
          onShow={show}
          onToast={setToast}
          onError={fail}
        />
      ) : null}
      {/* Always mounted: a live region added together with its message is often not read. Errors
          use an assertive alert region; everything else is a polite status. */}
      <div role="status" aria-live="polite" className="toast-region">
        {toast && !toast.error ? toastBox(toast, setToast) : null}
      </div>
      <div role="alert" className="toast-region">
        {toast?.error ? toastBox(toast, setToast) : null}
      </div>
    </div>
  );
}
