import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AcquireLockInput,
  acquireLock,
  BriefInput,
  buildBrief,
  CLI_NAME,
  ClaimTaskInput,
  CompleteTaskInput,
  CreateTaskInput,
  checkChanges,
  claimNext,
  claimTask,
  completeTask,
  createFeature,
  createMilestone,
  createTask,
  type Feature,
  findSimilarTasks,
  GetContextInput,
  getContext,
  getProject,
  getRecord,
  isSatiError,
  ListTasksInput,
  listRecords,
  listTasks,
  PutContextInput,
  putContext,
  RecordDecisionInput,
  ReleaseLockInput,
  recordDecision,
  releaseLock,
  resolveId,
  SatiError,
  SearchInput,
  type ServiceContext,
  search,
  shortHandle,
  UpdateFeatureInput,
  UpdateMilestoneInput,
  UpdateTaskInput,
  updateFeature,
  updateMilestone,
  updateTask,
  WORKFLOW,
} from "@sati/core";
import { z } from "zod";

/** Bumped with the published package; reported to clients on connect. */
const VERSION = "0.0.0";

const Ref = z.string().trim().min(1).max(60).describe("Full id or short handle, e.g. tsk_8f3k2a");

/** Results go back as compact JSON: agents parse it fine and it costs fewer tokens. */
function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Domain errors become tool errors with a code and hint the agent can act on. */
function fail(err: unknown): CallToolResult {
  const e = isSatiError(err)
    ? err
    : new SatiError("INTERNAL", err instanceof Error ? err.message : String(err));
  const error = { code: e.code, message: e.message, hint: e.hint ?? null, details: e.details };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

/**
 * Builds the MCP server for one project and caller. Tools are thin wrappers over core services,
 * which validate input again and run each write in one transaction with an activity row.
 */
export function createServer(ctx: ServiceContext): McpServer {
  const server = new McpServer(
    { name: CLI_NAME, version: VERSION },
    {
      instructions: `Shared project memory for agents. Start with ${CLI_NAME}_brief, claim a task before coding, finish with task_complete. Full rules: ${CLI_NAME}://workflow.`,
    },
  );
  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}

function registerTools(server: McpServer, ctx: ServiceContext): void {
  const task = (ref: string) => resolveId(ctx, "task", ref);

  server.registerTool(
    `${CLI_NAME}_brief`,
    {
      description:
        "Call first in every session. Markdown: your claimed tasks with acceptance criteria, ready tasks, others' locks, recent decisions, stale context, protected features.",
      inputSchema: BriefInput,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        // Markdown, not JSON: the agent reads it as is.
        const brief = await buildBrief(ctx, input);
        return { content: [{ type: "text", text: brief.markdown }] };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "task_list",
    {
      description:
        "List tasks. Filter by status, feature or label; `ready: true` returns unclaimed todo tasks whose dependencies are done.",
      inputSchema: ListTasksInput,
      annotations: { readOnlyHint: true },
    },
    (input) => run(() => listTasks(ctx, input)),
  );

  server.registerTool(
    "task_create",
    {
      description:
        "Create a task. New tasks start in todo (or backlog). The result lists `similar` existing tasks; if one is the same work, cancel the new task and use that one.",
      inputSchema: CreateTaskInput,
    },
    (input) =>
      run(async () => {
        // Search before creating, so the new task does not match itself.
        const similar = await findSimilarTasks(ctx, { title: input.title });
        const task = await createTask(ctx, input);
        return { ...task, similar: similar.map((t) => ({ ...t, id: shortHandle(t.id) })) };
      }),
  );

  server.registerTool(
    "task_claim",
    {
      description:
        "Claim a task before working on it: moves it to in_progress with a lease and returns claim.token. Pass that token to task_update and task_complete. Fails with the holder's name if another agent has it.",
      inputSchema: ClaimTaskInput.extend({ id: Ref.optional() }),
    },
    ({ id, ...input }) =>
      run(async () => (id ? claimTask(ctx, await task(id), input) : claimNext(ctx, input))),
  );

  server.registerTool(
    "task_update",
    {
      description:
        "Update a task's fields or status. While the task is claimed, pass the token from task_claim; a stale token means your claim was lost, so stop. Renews your lease. Moving it back to todo releases it.",
      inputSchema: UpdateTaskInput.extend({ id: Ref }),
    },
    ({ id, ...input }) => run(async () => updateTask(ctx, await task(id), input)),
  );

  server.registerTool(
    "task_complete",
    {
      description:
        "Mark a task done. Requires a summary, every file touched, and the token from task_claim. Releases the claim and your locks tied to the task.",
      inputSchema: CompleteTaskInput.extend({ id: Ref }),
    },
    ({ id, ...input }) => run(async () => completeTask(ctx, await task(id), input)),
  );

  server.registerTool(
    "feature_check",
    {
      description:
        "Before deleting, moving or rewriting code: returns the shipped features and other agents' locks the paths affect, with a verdict ok, warn or blocked. If blocked, stop and ask.",
      inputSchema: z.strictObject({
        paths: z.array(z.string().min(1)).min(1).max(500),
        change: z
          .enum(["modify", "delete"])
          .default("modify")
          .describe("delete when the paths will be removed"),
      }),
    },
    ({ paths, change }) =>
      run(async () =>
        checkChanges(ctx, {
          changes: paths.map((path) => ({
            path,
            kind: change === "delete" ? "deleted" : "modified",
          })),
        }),
      ),
  );

  server.registerTool(
    "lock_acquire",
    {
      description:
        "Lock repo-relative paths or globs before editing a shared area. exclusive (default) blocks other agents; shared only warns. Fails with the holder's name on overlap. Pass taskId so task_complete releases it.",
      inputSchema: AcquireLockInput.extend({ taskId: Ref.optional() }),
    },
    ({ taskId, ...input }) =>
      run(async () =>
        acquireLock(ctx, {
          ...input,
          taskId: taskId === undefined ? undefined : await task(taskId),
        }),
      ),
  );

  server.registerTool(
    "lock_release",
    {
      description:
        "Release a lock when done editing. force releases another agent's lock and is logged.",
      inputSchema: ReleaseLockInput.extend({ id: Ref }),
    },
    ({ id, ...input }) =>
      run(async () => releaseLock(ctx, await resolveId(ctx, "lock", id), input)),
  );

  server.registerTool(
    "feature_upsert",
    {
      description:
        "Create a feature (no id) or update one (with id): title, description, status, protected, paths, tests, acceptance criteria.",
      inputSchema: UpdateFeatureInput.extend({ id: Ref.optional() }),
    },
    ({ id, ...input }) =>
      run(async () =>
        id === undefined
          ? createFeature(ctx, input)
          : updateFeature(ctx, await resolveId(ctx, "feature", id), input),
      ),
  );

  server.registerTool(
    "decision_record",
    {
      description:
        "Record why something changed or was rejected. Required before removing a shipped feature.",
      inputSchema: RecordDecisionInput,
    },
    (input) => run(() => recordDecision(ctx, input)),
  );

  server.registerTool(
    "context_get",
    {
      description:
        "Cached module summaries. stale: true means files under the path changed since the summary; re-read them, then context_put. Use before crawling the repo.",
      inputSchema: GetContextInput,
      annotations: { readOnlyHint: true },
    },
    (input) => run(() => getContext(ctx, input)),
  );

  server.registerTool(
    "context_put",
    {
      description:
        "Save what you learned about a module: a path or glob, a short summary and key files. Never paste code. Replaces the entry for the same path.",
      inputSchema: PutContextInput,
    },
    (input) => run(() => putContext(ctx, input)),
  );

  server.registerTool(
    "search",
    {
      description: "Full-text search across tasks, features, notes and decisions.",
      inputSchema: SearchInput,
      annotations: { readOnlyHint: true },
    },
    (input) => run(() => search(ctx, input)),
  );

  server.registerTool(
    "roadmap_upsert",
    {
      description:
        "Create a milestone (no id) or update one (with id): title, goal, targetDate, status, order.",
      inputSchema: UpdateMilestoneInput.extend({
        id: Ref.optional(),
        title: UpdateMilestoneInput.shape.title,
      }),
    },
    ({ id, ...input }) =>
      run(async () =>
        id === undefined
          ? createMilestone(ctx, input)
          : updateMilestone(ctx, await resolveId(ctx, "milestone", id), input),
      ),
  );
}

function registerResources(server: McpServer, ctx: ServiceContext): void {
  const scheme = `${CLI_NAME}://`;
  const text = (uri: URL, body: string, mimeType = "text/markdown") => ({
    contents: [{ uri: uri.href, mimeType, text: body }],
  });

  server.registerResource(
    "workflow",
    `${scheme}workflow`,
    { title: "Agent workflow", description: "The rules agents follow in this repo." },
    (uri) => text(uri, WORKFLOW),
  );

  server.registerResource(
    "roadmap",
    `${scheme}project/roadmap`,
    { title: "Roadmap", description: "Milestones and their features." },
    async (uri) => text(uri, await roadmap(ctx)),
  );

  server.registerResource(
    "feature",
    new ResourceTemplate(`${scheme}feature/{id}`, { list: undefined }),
    { title: "Feature", description: "A feature with its paths, acceptance criteria and tasks." },
    async (uri, { id }) => {
      const ref = Array.isArray(id) ? id[0] : id;
      const featureId = await resolveId(ctx, "feature", ref ?? "");
      const feature = await getRecord(ctx, "feature", featureId);
      const tasks = await listRecords(ctx, "task", { featureId, limit: 100 });
      const summary = tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
      return text(uri, JSON.stringify({ feature, tasks: summary }), "application/json");
    },
  );
}

/** Milestones in order, each with its features; features without a milestone come last. */
async function roadmap(ctx: ServiceContext): Promise<string> {
  const project = await getProject(ctx.store);
  const milestones = await listRecords(ctx, "milestone", { limit: 500 });
  const features = await listRecords(ctx, "feature", { limit: 500 });
  const line = (f: Feature) =>
    `- ${shortHandle(f.id)} ${f.title} (${f.status}${f.protected ? ", protected" : ""})`;
  const out = [`# ${project.name} roadmap`];
  for (const m of milestones) {
    out.push("", `## ${shortHandle(m.id)} ${m.title} (${m.status})`);
    if (m.goal) out.push(m.goal);
    out.push(...features.filter((f) => f.milestoneId === m.id).map(line));
  }
  const loose = features.filter((f) => f.milestoneId === null);
  if (loose.length > 0) out.push("", "## No milestone", ...loose.map(line));
  if (milestones.length === 0 && features.length === 0) out.push("", "Nothing planned yet.");
  return `${out.join("\n")}\n`;
}

function registerPrompts(server: McpServer): void {
  const user = (body: string) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: body } }],
  });

  server.registerPrompt(
    "start-task",
    {
      title: "Start a task",
      description: "Read the brief, claim a task and plan the work.",
      argsSchema: { taskId: z.string().optional() },
    },
    ({ taskId }) =>
      user(
        [
          `Call ${CLI_NAME}_brief.`,
          taskId
            ? `Then call task_claim with id ${taskId}.`
            : "Then pick the top ready task and call task_claim on it.",
          "If the claim fails because another agent holds the task, pick a different ready task.",
          "Read the linked feature's acceptance criteria before you change code, then plan the work.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "finish-task",
    {
      title: "Finish a task",
      description: "Record decisions and complete the task with a summary and files touched.",
      argsSchema: { taskId: z.string().optional() },
    },
    ({ taskId }) =>
      user(
        [
          `Finish ${taskId ? `task ${taskId}` : "your claimed task"}.`,
          "1. If you removed, reverted or rejected anything, call decision_record with the reason.",
          "2. If a feature's paths or acceptance criteria changed, call feature_upsert.",
          "3. Call task_complete with a short summary and every file you touched.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "plan-feature",
    {
      title: "Plan a feature",
      description: "Create a feature and break it into tasks with dependencies.",
      argsSchema: { title: z.string() },
    },
    ({ title }) =>
      user(
        [
          `Plan the feature "${title}".`,
          "1. Call search to check it does not exist already.",
          "2. Call feature_upsert with the title, description, paths and acceptance criteria.",
          "3. Call task_create once with subtasks[]. dependsOn is an index into that array.",
        ].join("\n"),
      ),
  );
}
