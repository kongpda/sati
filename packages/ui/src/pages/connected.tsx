import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api, type Deletable, type Snapshot } from "../api.js";
import { approvedCommit } from "../hooks/use-moves.js";
import { MyWork } from "../my-work.js";
import { holderName } from "../people.js";
import { People } from "../people-section.js";
import { statusWord } from "../words.js";
import { Notes } from "./knowledge.js";
import { Features } from "./plan.js";
import { TaskSheet } from "./task-sheet.js";
import { Agents } from "./team.js";

/** What the pages need from the app to save, report and navigate. */
export interface PageContext {
  client: QueryClient;
  saved: (message: string) => Promise<void>;
  fail: (err: unknown) => void;
  setToast: (message: string | null, undo?: () => void) => void;
  remove: (entity: Deletable, id: string, title: string) => void;
  go: (next: string, taskId?: string | null) => boolean;
  path: string;
  /** The page's own query part: its tab or filter. */
  params: URLSearchParams;
  thread: {
    onAdd: (on: string, body: string) => Promise<void>;
    onDelete: (id: string, title: string) => void;
    onDraft: (typed: boolean, on: string) => void;
  };
}

export function MyWorkPage({ data, go, path, saved, fail }: PageContext & { data: Snapshot }) {
  return (
    <MyWork
      data={data}
      onOpen={(id) => go(path, id)}
      onGo={go}
      onApprove={(t) =>
        api
          .patchTask(t.id, {
            status: "done",
            expectedVersion: t.version,
            // The commit shown: refused if the branch moves again before the click lands.
            ...approvedCommit(data, t.id),
          })
          .then(() => saved(`Approved ${t.title}.`))
          .catch(fail)
      }
      onAnswered={(t) =>
        api
          .answered(t.id)
          .then(() => saved(`${t.title} no longer waits on you.`))
          .catch(fail)
      }
      onSendBack={(t, reason) =>
        api
          .patchTask(t.id, { status: "todo", reason, expectedVersion: t.version })
          .then(() => saved(`Sent ${t.title} back to ${statusWord("todo")}.`))
          .catch((err: unknown) => {
            fail(err);
            throw err;
          })
      }
    />
  );
}

/** People always; agents only in a code project, where agents claim tasks and reserve files. */
export function TeamPage({
  data,
  saved,
  fail,
  client,
  general,
}: PageContext & { data: Snapshot; general: boolean }) {
  return (
    <div className="page">
      <h1>Team</h1>
      <People data={data} onSaved={saved} />
      {general ? null : <AgentsSection data={data} saved={saved} fail={fail} client={client} />}
    </div>
  );
}

function AgentsSection({
  data,
  saved,
  fail,
  client,
}: Pick<PageContext, "saved" | "fail" | "client"> & { data: Snapshot }) {
  return (
    <Agents
      data={data}
      onRelease={() =>
        void api
          .releaseExpired()
          .then((freed) =>
            saved(
              freed.length === 0
                ? "No tasks had run out of time."
                : `Freed ${freed.length} task${freed.length === 1 ? "" : "s"}.`,
            ),
          )
          .catch(fail)
      }
      onReleaseTask={(id) => {
        const t = data.tasks.find((x) => x.id === id);
        const name = holderName(data, t?.claim?.actorId);
        const ok =
          t?.claim?.actorId === data.you ||
          window.confirm(
            `Stop ${name} working on ${t?.title ?? id}? Their next save will be refused.`,
          );
        if (!ok) return;
        void api
          .releaseTask(id, t?.claim?.actorId !== data.you)
          .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
          .catch(fail);
      }}
    />
  );
}

export function FeaturesPage({
  data,
  tabs,
  general,
  client,
  setToast,
  fail,
}: PageContext & { data: Snapshot; tabs: ReactNode; general: boolean }) {
  return (
    <Features
      data={data}
      tabs={tabs}
      general={general}
      onSavePaths={(id, paths, version) =>
        api
          .patchFeature(id, {
            paths: paths
              .split(/\r?\n/u)
              .map((p) => p.trim())
              .filter(Boolean),
            expectedVersion: version,
          })
          .then((saved) => {
            setToast("Saved");
            void client.invalidateQueries({ queryKey: ["snapshot"] });
            return saved;
          })
          .catch((err: unknown) => {
            fail(err);
            throw err;
          })
      }
      onReviewed={(id, version) =>
        void api
          .patchFeature(id, { reviewed: true, expectedVersion: version })
          .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
          .catch(fail)
      }
    />
  );
}

export function NotesPage({
  data,
  tabs,
  client,
  saved,
  fail,
  remove,
  thread,
}: PageContext & { data: Snapshot; tabs: ReactNode }) {
  return (
    <Notes
      data={data}
      tabs={tabs}
      onCreate={(title, body, hidden) =>
        api
          .createNote({ title, body, ...(hidden ? { private: true } : {}) })
          .then(() => saved(`Saved the note ${title}.`))
          .catch((err: unknown) => {
            fail(err);
            throw err;
          })
      }
      onPatch={(id, patch) =>
        void api
          .patchNote(id, patch)
          .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
          .catch(fail)
      }
      onSaved={saved}
      onDelete={(id, title) => remove("note", id, title)}
      thread={thread}
    />
  );
}

export function TaskSheetPanel({
  data,
  task,
  wide,
  dialog,
  setSheetDirty,
  client,
  fail,
  setToast,
  remove,
  go,
  path,
  thread,
}: PageContext & {
  data: Snapshot;
  task: string;
  wide: boolean;
  dialog: boolean;
  setSheetDirty: (dirty: boolean) => void;
}) {
  return (
    <TaskSheet
      key={task}
      data={data}
      id={task}
      modal={!wide}
      inert={dialog}
      onDirty={setSheetDirty}
      onToast={setToast}
      onClose={() => go(path)}
      onSave={(id, patch) =>
        api
          // Approving from the panel names the commit on screen, as a drag to Done does.
          .patchTask(id, {
            ...patch,
            ...(patch.status === "done" && data ? approvedCommit(data, id) : {}),
          })
          // Resolve before the refetch: the panel takes the saved task as its new baseline
          // first, or the refetched task looks like someone else's change while it is
          // still dirty.
          .then((saved) => {
            void client.invalidateQueries({ queryKey: ["snapshot"] });
            return saved;
          })
          .catch((err: unknown) => {
            fail(err);
            throw err;
          })
      }
      onRelease={(id, force) =>
        void api
          .releaseTask(id, force)
          .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
          .catch(fail)
      }
      onTakeOver={(id) =>
        void api
          .takeOver(id)
          .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
          .catch(fail)
      }
      onDelete={(id, title) => {
        // Keeping unsaved edits means keeping the task.
        if (go(path)) remove("task", id, title);
      }}
      thread={thread}
    />
  );
}
