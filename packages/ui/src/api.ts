export interface Claim {
  actorId: string;
  leaseUntil: string;
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
  completion: { summary: string; filesTouched: string[]; completedBy: string } | null;
  dueDate?: string | null;
  /** The plan it belongs to directly; a task can also be in one through its feature. */
  milestoneId?: string | null;
  assigneeIds?: string[];
  checklist?: { text: string; done: boolean }[];
  labels?: string[];
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
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  version: number;
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
  displayName?: string;
  initials?: string;
  color?: string;
}

export interface Milestone {
  id: string;
  title: string;
  status: string;
  targetDate: string | null;
  goal: string;
  version: number;
}

export interface Lock {
  id: string;
  actorId: string;
  paths: string[];
  mode: string;
  leaseUntil: string;
  taskId: string | null;
}

export interface Activity {
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
  project: { id: string; name: string; slug: string; kind: ProjectKind } | null;
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

export interface Changes {
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

/** Records a person can delete from the board and bring back with Undo. */
export type Deletable = "task" | "note" | "decision";

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
  changes: (filter: ChangesFilter) =>
    request<{ changes: Changes; changelog: string; digest: string }>(
      `/api/changes?${new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== ""))}`,
    ),
  featureList: () => request<{ markdown: string }>("/api/feature-list"),
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

/** Today's calendar day in the reader's time zone, as YYYY-MM-DD. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

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
  const text = `due ${date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`;
  const open = status !== "done" && status !== "cancelled";
  return { text, late: open && day < today(now) };
}
