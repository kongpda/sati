import { waitingOn as claimWaits } from "../../core/src/domain/inbox.js";

export interface Claim {
  actorId: string;
  leaseUntil: string;
  /** The agent is stuck until a person answers its question or allows what its tool asked. */
  waiting?: { kind: "question" | "permission"; text: string; since: string };
}

export interface Task {
  id: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  featureId: string | null;
  version: number;
  updatedAt: string;
  claim: Claim | null;
  needsReview?: boolean;
  completion: {
    summary: string;
    filesTouched: string[];
    completedBy: string;
    commit?: string;
    branch?: string;
    approvedCommit?: string;
  } | null;
  /** What a blocked task waits on. */
  blockedReason?: string | null;
  dueDate?: string | null;
  /** How much thinking it needs; unset is standard. A light task suits a small-model agent. */
  effort?: "light" | "standard" | "deep" | null;
  /** The plan it belongs to directly; a task can also be in one through its feature. */
  milestoneId?: string | null;
  assigneeIds?: string[];
  checklist?: { text: string; done: boolean }[];
  labels?: string[];
  /** Tasks that must be done first. */
  dependsOn?: string[];
}

export interface Feature {
  id: string;
  title: string;
  description: string;
  status: string;
  protected: boolean;
  paths: string[];
  acceptance: string[];
  matchCount: number | null;
  needsReview?: boolean;
  milestoneId: string | null;
  version: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  links: string[];
  needsReview?: boolean;
  pinned: boolean;
  /** Kept on this machine only: never exported to `.sati/`. */
  private?: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  version: number;
  /** A handoff for one actor; without it, for whoever takes the task next. */
  handoffTo?: string;
  /** The addressee's actor name, for a clone where the id names no one. */
  handoffToName?: string;
  /** The author's actor name, for a clone where `createdBy` names no one. */
  handoffFromName?: string;
  acknowledged?: { by: string; at: string };
}

export interface Decision {
  id: string;
  title: string;
  decision: string;
  context: string;
  consequences: string;
  featureIds: string[];
  supersedes: string | null;
  createdAt: string;
}

export interface Actor {
  id: string;
  name: string;
  kind: string;
  tool: string | null;
  worktree: string | null;
  displayName?: string | undefined;
  initials?: string | undefined;
  color?: string | undefined;
}

export interface Milestone {
  id: string;
  title: string;
  status: string;
  targetDate: string | null;
  goal: string;
  version: number;
}

interface Lock {
  id: string;
  actorId: string;
  paths: string[];
  mode: string;
  leaseUntil: string;
  taskId: string | null;
}

interface Activity {
  id: string;
  actorId: string;
  verb: string;
  entity: string;
  entityId: string;
  at: string;
  branch: string | null;
  diff: Record<string, unknown>;
}

/** `general`: plans, todos and notes, with no features, file reservations or guard. */
export type ProjectKind = "code" | "general";

export interface Snapshot {
  project: {
    id: string;
    name: string;
    slug: string;
    kind: ProjectKind;
    /** Whose finished work waits for a person: agents', everyone's, or no one's. */
    review?: ReviewMode;
  } | null;
  you: string;
  version: number;
  tasks: Task[];
  features: Feature[];
  notes: Note[];
  decisions: Decision[];
  actors: Actor[];
  milestones: Milestone[];
  activity: Activity[];
  locks: Lock[];
  cards: Card[];
  /** Tasks waiting for approval whose branch moved on since they were sent, by task id. */
  drift?: Record<string, Drift>;
  /** Kinds with more records than the board loads (oldest tasks, oldest notes left out). */
  truncated?: string[];
}

/** What an agent or person learned about a file or folder; sati never opens the file. */
export interface Card {
  id: string;
  path: string;
  summary: string;
  keyFiles: string[];
  facts?: string[];
  tags?: string[];
  sourceSeen?: string;
  sourceTokens?: number;
  private?: boolean;
  /** A person signed off the file in this version; the guard blocks a change to it. */
  approved?: { hash: string; by: string; at: string };
  /** The approved file now: `unchecked` when it is too large to read on every refresh. */
  approval?: "kept" | "changed" | "missing" | "unchecked";
  /** In git: the files changed since the card. `null` outside git. */
  stale: boolean | null;
  createdBy: string;
  updatedAt: string;
  version: number;
}

/** Whose finished work waits for a person: agents', everyone's, or no one's. */
export type ReviewMode = "agents" | "all" | "none";

export interface RecallItem {
  kind: "card" | "note" | "decision" | "task";
  id: string;
  title: string;
  text: string;
  facts: string[];
  sourceSeen: string | null;
  stale: boolean | null;
  private: boolean;
  updatedAt: string;
}

interface ChangeBase {
  id: string;
  title: string;
  at: string;
  by: string | null;
  milestoneId: string | null;
  featureId: string | null;
}
/** One entry of `sati changes`: built by core, shared with the CLI and MCP. */
export type ChangeItem =
  | (ChangeBase & {
      kind: "done";
      labels: string[];
      summary: string;
      releaseNote: string | null;
      filesTouched: string[];
    })
  | (ChangeBase & { kind: "feature"; status: string })
  | (ChangeBase & { kind: "decision" })
  | (ChangeBase & { kind: "note"; edited: boolean });

interface Changes {
  since: string;
  basis: string;
  items: ChangeItem[];
  blocked: { id: string; title: string }[];
  overdue: { id: string; title: string; dueDate: string }[];
}

export interface ChangesFilter {
  since: string;
  milestoneId: string;
  actorId: string;
}

/** A plan template, as `sati plan list --json` gives it. */
export interface TemplateSummary {
  name: string;
  title: string;
  goal: string;
  source: string;
  tasks: number;
  stages: { title: string; offsetDays: number | null; tasks: number }[];
}

interface Drift {
  commit: string;
  branch: string;
  head: string | null;
  moved: boolean;
}

/** True while the agent holding the task waits on a person. */
export function waitingOn(task: Task, now = Date.now()): Claim["waiting"] | undefined {
  return claimWaits(task, now);
}

/** Records a person can delete from the board and bring back with Undo. */
export type Deletable = "task" | "note";

export class ApiError extends Error {
  hint: string | null;
  /** The server's error code, such as CONFLICT or VALIDATION. */
  code: string;
  constructor(message: string, hint: string | null, code = "INTERNAL") {
    super(message);
    this.hint = hint;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; hint?: string | null };
    } | null;
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status})`,
      body?.error?.hint ?? null,
      body?.error?.code,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  snapshot: () => request<Snapshot>("/api/snapshot"),
  search: (q: string) =>
    request<{ hits: { entity: string; id: string; title: string }[] }>(
      `/api/search?q=${encodeURIComponent(q)}`,
    ),
  createTask: (input: { title: string } & Record<string, unknown>) =>
    request<Task>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  patchTask: (id: string, body: Record<string, unknown>) =>
    request<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  releaseTask: (id: string, force: boolean) =>
    request<Task>(`/api/tasks/${id}/release`, { method: "POST", body: JSON.stringify({ force }) }),
  takeOver: (id: string) =>
    request<Task>(`/api/tasks/${id}/take-over`, { method: "POST", body: "{}" }),
  answered: (id: string) =>
    request<Task>(`/api/tasks/${id}/answered`, { method: "POST", body: "{}" }),
  releaseExpired: () =>
    request<Task[]>("/api/claims/release-expired", { method: "POST", body: "{}" }),
  createNote: (body: Record<string, unknown>) =>
    request<Note>("/api/notes", { method: "POST", body: JSON.stringify(body) }),
  addComment: (on: string, body: string) =>
    request<Note>("/api/comments", { method: "POST", body: JSON.stringify({ on, body }) }),
  patchNote: (id: string, body: Record<string, unknown>) =>
    request<Note>(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  recordDecision: (body: Record<string, unknown>) =>
    request<Decision>("/api/decisions", { method: "POST", body: JSON.stringify(body) }),
  createMilestone: (body: Record<string, unknown>) =>
    request<Milestone>("/api/milestones", { method: "POST", body: JSON.stringify(body) }),
  patchMilestone: (id: string, body: Record<string, unknown>) =>
    request<Milestone>(`/api/milestones/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  remove: (entity: Deletable, id: string) =>
    request<unknown>(`/api/${entity}s/${id}`, { method: "DELETE" }),
  restore: (entity: Deletable, id: string) =>
    request<unknown>(`/api/${entity}s/${id}/restore`, { method: "POST", body: "{}" }),
  patchProfile: (id: string, body: Record<string, unknown>) =>
    request<Actor>(`/api/actors/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  setKind: (kind: ProjectKind) =>
    request<{ kind: ProjectKind }>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ kind }),
    }),
  setReview: (review: ReviewMode) =>
    request<{ review: ReviewMode }>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ review }),
    }),
  changes: (filter: ChangesFilter) =>
    request<{ changes: Changes; changelog: string; digest: string }>(
      `/api/changes?${new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== ""))}`,
    ),
  featureList: () => request<{ markdown: string }>("/api/feature-list"),
  templates: () => request<TemplateSummary[]>("/api/templates"),
  recall: (q: string) =>
    request<{ markdown: string; items: RecallItem[]; omitted: number }>(
      `/api/recall?q=${encodeURIComponent(q)}`,
    ),
  saveCard: (body: Record<string, unknown>) =>
    request<Card>("/api/cards", { method: "POST", body: JSON.stringify(body) }),
  /** Approves the file as it is now; `clear` takes the approval away. */
  approveCard: (path: string, clear = false) =>
    request<Card>("/api/cards/approve", { method: "POST", body: JSON.stringify({ path, clear }) }),
  applyTemplate: (body: { template: string; title?: string; targetDate?: string }) =>
    request<{ milestone: Milestone; taskIds: string[] }>("/api/templates/apply", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchFeature: (id: string, body: Record<string, unknown>) =>
    request<Feature>(`/api/features/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
};

export function ago(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const delta = Math.max(0, now - then);
  const min = Math.floor(delta / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return `${Math.floor(hr / 24)} d ago`;
}

export const COLUMNS = [
  ["backlog", "Backlog"],
  ["todo", "To do"],
  ["in_progress", "Working on it"],
  ["review", "Waiting for approval"],
  ["done", "Done"],
  ["blocked", "Blocked"],
  ["cancelled", "Cancelled"],
] as const;

/**
 * The column a phone opens on: the first with tasks of Working on it, Waiting for approval, To do
 * and Backlog, so a new plan does not open on an empty column. Working on it when all are empty.
 */
export function phoneColumn(tasks: readonly { status: string }[]): string {
  const order = ["in_progress", "review", "todo", "backlog"];
  return order.find((s) => tasks.some((t) => t.status === s)) ?? "in_progress";
}

/** Today's calendar day in the reader's time zone, as YYYY-MM-DD. */
function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "Fri 4 Dec", for due days and near times; built once, since a formatter is costly to make. */
export const SHORT_DAY = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});
const SHORT_DAY_YEAR = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * A due day in the reader's words, for example "due Fri 4 Dec", and whether it has passed.
 * The date has no zone ("by Friday"), so it is read as a local day, never shifted by UTC.
 */
export function dueLabel(
  day: string,
  status: string,
  now = new Date(),
): { text: string; late: boolean } {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
  // A plan often runs into next year, so the year shows whenever it is not this one.
  const text = `due ${(date.getFullYear() === now.getFullYear() ? SHORT_DAY : SHORT_DAY_YEAR).format(date)}`;
  const open = status !== "done" && status !== "cancelled";
  return { text, late: open && day < today(now) };
}
