import { createIdFactory, fixedClock, initProject, type ServiceContext } from "../../src/index.js";
import { MemoryStore } from "./memory-store.js";

export const START = "2026-11-03T12:00:00.000Z";

/** A fresh project with one agent actor, ready for service calls. */
export async function setup() {
  const store = new MemoryStore();
  const clock = fixedClock(START);
  const ids = createIdFactory(() => clock.now().getTime());
  const { project, actor } = await initProject(
    { store, clock, ids },
    { slug: "demo", name: "Demo" },
    { name: "claude-code@main#1", kind: "agent", tool: "claude-code" },
  );
  const ctx: ServiceContext = {
    store,
    clock,
    ids,
    projectId: project.id,
    actorId: actor.id,
    branch: "main",
  };
  return { store, clock, ctx, project, actor };
}
