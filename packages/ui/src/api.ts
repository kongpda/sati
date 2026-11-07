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
  completion: { summary: string; filesTouched: string[] } | null;
}

export interface Feature {
  id: string;
  title: string;
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

export interface Snapshot {
  project: { id: string; name: string; slug: string } | null;
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

export class ApiError extends Error {
  hint: string | null;
  constructor(message: string, hint: string | null) {
    super(message);
    this.hint = hint;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; hint?: string | null };
    } | null;
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status})`,
      body?.error?.hint ?? null,
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
  createTask: (title: string) =>
    request<Task>("/api/tasks", { method: "POST", body: JSON.stringify({ title }) }),
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
  patchNote: (id: string, body: Record<string, unknown>) =>
    request<Note>(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
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
  ["todo", "Todo"],
  ["in_progress", "In progress"],
  ["review", "Review"],
  ["done", "Done"],
  ["blocked", "Blocked"],
  ["cancelled", "Cancelled"],
] as const;

/** A clock time in the reader's own time zone, for example "14:32". */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Time left on a lease, for example "expires in 12m", or "expired". */
export function leaseLeft(iso: string, now = Date.now()): string {
  const until = Date.parse(iso);
  if (Number.isNaN(until)) return "";
  const min = Math.floor((until - now) / 60000);
  if (until <= now) return "expired";
  if (min < 1) return "expires in under 1m";
  if (min < 60) return `expires in ${min}m`;
  const hr = Math.floor(min / 60);
  return hr < 24 ? `expires in ${hr}h` : `expires in ${Math.floor(hr / 24)}d`;
}
