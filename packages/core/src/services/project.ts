import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import type { IdFactory } from "../domain/ids.js";
import {
  ACTOR_KINDS,
  type Actor,
  Mode,
  type Project,
  ProjectKind,
  type ProjectSettings,
  type ReviewMode,
} from "../domain/schemas.js";
import { CLI_NAME } from "../name.js";
import type { Clock } from "../ports/clock.js";
import type { StorageAdapter, StorageWriter } from "../ports/storage.js";
import {
  checkRecord,
  logActivity,
  nowIso,
  parseInput,
  type ServiceContext,
  updateWithLog,
} from "./context.js";

export const DEFAULT_LEASE_MINUTES = 30;

export const ActorIdentityInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  kind: z.enum(ACTOR_KINDS),
  tool: z.string().max(100).nullable().default(null),
  worktree: z.string().max(1000).nullable().default(null),
});
export type ActorIdentity = z.input<typeof ActorIdentityInput>;

export const InitProjectInput = z.strictObject({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use lowercase letters, digits and dashes"),
  name: z.string().trim().min(1).max(300),
  repoUrl: z.string().max(1000).nullable().default(null),
  mode: Mode.default("git"),
  kind: ProjectKind.default("code"),
  leaseMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(DEFAULT_LEASE_MINUTES),
});
export type InitProjectInput = z.input<typeof InitProjectInput>;

/** Settings as stored, including rows written before review, autoContinue and kind existed. */
export function readSettings(
  raw: Partial<ProjectSettings> | undefined,
): ProjectSettings & { kind: ProjectKind } {
  const review: ReviewMode =
    raw?.review === "all" || raw?.review === "none" || raw?.review === "agents"
      ? raw.review
      : "agents";
  return {
    leaseMinutes: raw?.leaseMinutes ?? DEFAULT_LEASE_MINUTES,
    review,
    autoContinue: raw?.autoContinue === true,
    kind: raw?.kind === "general" ? "general" : "code",
  };
}

/** The stored form: `kind` only when it is not the default. */
function storedSettings(s: ProjectSettings & { kind: ProjectKind }): ProjectSettings {
  const { kind, ...rest } = s;
  return kind === "general" ? { ...rest, kind } : rest;
}

export const UpdateSettingsInput = z.strictObject({
  leaseMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
  review: z.enum(["agents", "all", "none"]).optional(),
  autoContinue: z.boolean().optional(),
  kind: ProjectKind.optional(),
});
export type UpdateSettingsInput = z.input<typeof UpdateSettingsInput>;

/** Changes project settings. Missing fields keep their current value. */
export async function updateSettings(ctx: ServiceContext, input: unknown): Promise<Project> {
  const data = parseInput(UpdateSettingsInput, input);
  return ctx.store.write(async (w) => {
    const project = await w.getProject();
    if (!project || project.id !== ctx.projectId) {
      throw new SatiError("NOT_INITIALIZED", "This repository has no project.", {
        hint: `Run \`${CLI_NAME} init\`.`,
      });
    }
    const current = readSettings(project.settings);
    return updateWithLog(w, ctx, "project", project, {
      settings: storedSettings({
        leaseMinutes: data.leaseMinutes ?? current.leaseMinutes,
        review: data.review ?? current.review,
        autoContinue: data.autoContinue ?? current.autoContinue,
        kind: data.kind ?? current.kind,
      }),
    });
  });
}

interface Deps {
  store: StorageAdapter;
  clock: Clock;
  ids: IdFactory;
  branch?: string | null;
}

/** Creates the one project in this DB, its first actor, and an `init` activity row. */
export async function initProject(
  deps: Deps,
  input: InitProjectInput,
  identity: ActorIdentity,
): Promise<{ project: Project; actor: Actor }> {
  const data = parseInput(InitProjectInput, input);
  const who = parseInput(ActorIdentityInput, identity);
  return deps.store.write(async (w) => {
    const existing = await w.getProject();
    if (existing) {
      throw new SatiError("CONFLICT", `This repository already has project "${existing.slug}".`, {
        hint: `Run \`${CLI_NAME} doctor\` to inspect it; init runs once per repository.`,
      });
    }
    const at = nowIso(deps);
    const projectId = deps.ids("project");
    const actorId = deps.ids("actor");
    const project = checkRecord("project", {
      id: projectId,
      slug: data.slug,
      name: data.name,
      repoUrl: data.repoUrl,
      mode: data.mode,
      settings: storedSettings({
        leaseMinutes: data.leaseMinutes,
        review: "agents",
        autoContinue: false,
        kind: data.kind,
      }),
      createdAt: at,
      updatedAt: at,
      createdBy: actorId,
      version: 1,
      deletedAt: null,
    });
    await w.insert("project", project);
    const actor = await insertActor(w, { ...deps, projectId }, who, actorId);
    const ctx: ServiceContext = { ...deps, projectId, actorId, branch: deps.branch ?? null };
    await logActivity(w, ctx, "init", "project", projectId, {
      slug: project.slug,
      mode: project.mode,
    });
    return { project, actor };
  });
}

export async function getProject(store: StorageAdapter): Promise<Project> {
  const project = await store.read((r) => r.getProject());
  if (!project) {
    throw new SatiError("NOT_INITIALIZED", "No project in this database.", {
      hint: `Run \`${CLI_NAME} init\`.`,
    });
  }
  return project;
}

/**
 * Returns the actor with this identity, creating it (and its activity row) on first use.
 * Identity names are unique per project, so a returning agent keeps its ID.
 */
export async function ensureActor(
  deps: Deps & { projectId: string },
  identity: ActorIdentity,
): Promise<Actor> {
  const who = parseInput(ActorIdentityInput, identity);
  const found = await deps.store.read((r) => r.getByKey("actor", deps.projectId, who.name));
  if (found) return found;
  return deps.store.write(async (w) => {
    const again = await w.getByKey("actor", deps.projectId, who.name);
    if (again) return again;
    return insertActor(w, deps, who);
  });
}

async function insertActor(
  w: StorageWriter,
  deps: Deps & { projectId: string },
  who: z.output<typeof ActorIdentityInput>,
  id: string = deps.ids("actor"),
): Promise<Actor> {
  const at = nowIso(deps);
  const actor = checkRecord("actor", {
    id,
    projectId: deps.projectId,
    ...who,
    createdAt: at,
    updatedAt: at,
    version: 1,
    deletedAt: null,
  });
  await w.insert("actor", actor);
  const ctx: ServiceContext = { ...deps, actorId: id, branch: deps.branch ?? null };
  await logActivity(w, ctx, "create", "actor", id, { name: actor.name });
  return actor;
}
