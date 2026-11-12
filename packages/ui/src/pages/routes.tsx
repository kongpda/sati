import type { ComponentProps } from "react";
import type { Snapshot } from "../api.js";
import { Changes } from "../changes.js";
import { CODE_ONLY } from "../hooks/use-view.js";
import { Memory } from "../memory.js";
import { Settings } from "../settings.js";
import { BoardPage } from "./board-page.js";
import { AgentsPage, FeaturesPage, MyWorkPage, NotesPage, type PageContext } from "./connected.js";
import { Decisions } from "./knowledge.js";
import { Activity } from "./log.js";
import { Roadmap } from "./plan.js";

/** The page the address names. */
export function Routes({
  ctx,
  data,
  general,
  board,
  show,
  copyFailed,
}: {
  ctx: PageContext;
  data: Snapshot | undefined;
  general: boolean;
  board: ComponentProps<typeof BoardPage>;
  show: (next: string, id: string) => void;
  copyFailed: () => void;
}) {
  const { path, go, saved, fail, setToast, remove, thread } = ctx;
  return (
    <>
      {path === "/" ? <BoardPage {...board} /> : null}
      {data && path === "/my-work" ? <MyWorkPage data={data} {...ctx} /> : null}
      {data && general && CODE_ONLY.has(path) ? (
        <p className="empty page">
          A general project has no features or file reservations. Switch the project kind in
          Settings to see this page.
        </p>
      ) : null}
      {data && !general && path === "/agents" ? <AgentsPage data={data} {...ctx} /> : null}
      {data && !general && path === "/features" ? <FeaturesPage data={data} {...ctx} /> : null}
      {data && path === "/roadmap" ? <Roadmap data={data} onSaved={saved} /> : null}
      {data && path === "/notes" ? <NotesPage data={data} {...ctx} /> : null}
      {data && path === "/memory" ? (
        <Memory
          data={data}
          onSaved={saved}
          onCopied={(message) => setToast(message)}
          onCopyFailed={copyFailed}
          onFailed={fail}
          onOpenTask={(id) => go("/", id)}
          onGo={show}
        />
      ) : null}
      {data && path === "/decisions" ? (
        <Decisions
          data={data}
          onSaved={saved}
          onDelete={(id, title) => remove("decision", id, title)}
          thread={thread}
        />
      ) : null}
      {data && path === "/changes" ? (
        <Changes
          data={data}
          onOpenTask={(id) => go(path, id)}
          onGo={show}
          onCopied={(message) => setToast(message)}
          onCopyFailed={copyFailed}
        />
      ) : null}
      {data && path === "/activity" ? <Activity data={data} /> : null}
      {data && path === "/settings" ? (
        <Settings data={data} onSaved={saved} onError={fail} />
      ) : null}
    </>
  );
}
