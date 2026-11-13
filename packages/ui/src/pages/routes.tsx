import type { ComponentProps } from "react";
import type { Snapshot } from "../api.js";
import { Changes } from "../changes.js";
import { Memory } from "../memory.js";
import { Settings } from "../settings.js";
import { Tabs } from "../shell/tabs.js";
import { BoardPage } from "./board-page.js";
import { FeaturesPage, MyWorkPage, NotesPage, type PageContext, TeamPage } from "./connected.js";
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
  const { path, params, go, saved, fail, setToast, thread } = ctx;
  const changeTabs = (
    <Tabs
      label="Changes"
      tabs={[
        ["changes", "Changes"],
        ["log", "Log"],
      ]}
      current={params.get("tab") === "log" ? "log" : "changes"}
      onSelect={(id) => go(id === "log" ? `${path}?tab=log` : path)}
    />
  );
  const kind = params.get("kind");
  const knowledgeKind = kind === "decisions" || kind === "cards" ? kind : "notes";
  const knowledgeTabs = (
    <Tabs
      label="Knowledge"
      tabs={[
        ["notes", "Notes"],
        ["decisions", "Decisions"],
        ["cards", "File cards"],
      ]}
      current={knowledgeKind}
      onSelect={(id) => go(id === "notes" ? path : `${path}?kind=${id}`)}
    />
  );
  const onFeatures = params.get("tab") === "features";
  const planTabs = (
    <Tabs
      label="Plan"
      tabs={[
        ["milestones", "Milestones"],
        ["features", "Features"],
      ]}
      current={onFeatures ? "features" : "milestones"}
      onSelect={(id) => go(id === "features" ? `${path}?tab=features` : path)}
    />
  );
  return (
    <>
      {path === "/" ? <BoardPage {...board} /> : null}
      {data && path === "/my-work" ? <MyWorkPage data={data} {...ctx} /> : null}
      {data && path === "/team" ? <TeamPage data={data} general={general} {...ctx} /> : null}
      {data && path === "/plan" && !onFeatures ? (
        <Roadmap data={data} tabs={planTabs} onSaved={saved} />
      ) : null}
      {data && path === "/plan" && onFeatures ? (
        <FeaturesPage data={data} tabs={planTabs} general={general} {...ctx} />
      ) : null}
      {data && path === "/knowledge" && knowledgeKind === "notes" ? (
        <NotesPage data={data} tabs={knowledgeTabs} {...ctx} />
      ) : null}
      {data && path === "/knowledge" && knowledgeKind === "cards" ? (
        <Memory data={data} tabs={knowledgeTabs} onSaved={saved} onFailed={fail} />
      ) : null}
      {data && path === "/knowledge" && knowledgeKind === "decisions" ? (
        <Decisions data={data} tabs={knowledgeTabs} onSaved={saved} thread={thread} />
      ) : null}
      {data && path === "/changes" && params.get("tab") !== "log" ? (
        <Changes
          data={data}
          tabs={changeTabs}
          onOpenTask={(id) => go(path, id)}
          onGo={show}
          onCopied={(message) => setToast(message)}
          onCopyFailed={copyFailed}
        />
      ) : null}
      {data && path === "/changes" && params.get("tab") === "log" ? (
        <Activity data={data} tabs={changeTabs} />
      ) : null}
      {data && path === "/settings" ? (
        <Settings data={data} onSaved={saved} onError={fail} />
      ) : null}
    </>
  );
}
