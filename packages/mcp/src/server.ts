import {
  BrainError,
  BriefInput,
  buildBrief,
  CLI_NAME,
  ClaimTaskInput,
  CompleteTaskInput,
  CreateTaskInput,
  claimTask,
  completeTask,
  createFeature,
  createTask,
  type Feature,
  getProject,
  getRecord,
  isBrainError,
  ListTasksInput,
  listRecords,
  listTasks,
  RecordDecisionInput,
  recordDecision,
  resolveId,
  SearchInput,
  type ServiceContext,
  search,
  shortHandle,
  UpdateFeatureInput,
  UpdateTaskInput,
  updateFeature,
  updateTask,
} from "@brain/core";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WORKFLOW } from "./workflow.js";

/** Bumped with the published package; reported to clients on connect. */
const VERSION = "0.0.0";

const Ref = z.string().trim().min(1).max(60).describe("Full id or short handle, e.g. tsk_8f3k2a");

/** Results go back as compact JSON: agents parse it fine and it costs fewer tokens. */
function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Domain errors become tool errors with a code and hint the agent can act on. */
function fail(err: unknown): CallToolResult {
  const e = isBrainError(err)
    ? err
    : new BrainError("INTERNAL", err instanceof Error ? err.message : String(err));
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
        "Call first in every session. Markdown: your claimed tasks with acceptance criteria, ready tasks, recent decisions, protected features.",
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
      description: "Create a task. New tasks start in todo (or backlog).",
      inputSchema: CreateTaskInput,
    },
    (input) => run(() => createTask(ctx, input)),
  );

  server.registerTool(
    "task_claim",
    {
      description:
        "Claim a task before working on it: moves it to in_progress with a lease. Fails with the holder's name if another agent has it.",
      inputSchema: ClaimTaskInput.extend({ id: Ref }),
    },
    ({ id, ...input }) => run(async () => claimTask(ctx, await task(id), input)),
  );

  server.registerTool(
    "task_update",
    {
      description:
        "Update a task's fields or status. Renews your lease. Moving it back to todo releases it.",
      inputSchema: UpdateTaskInput.extend({ id: Ref }),
    },
    ({ id, ...input }) => run(async () => updateTask(ctx, await task(id), input)),
  );

  server.registerTool(
    "task_complete",
    {
      description:
        "Mark a task done. Requires a summary and every file touched. Releases the claim.",
      inputSchema: CompleteTaskInput.extend({ id: Ref }),
    },
    ({ id, ...input }) => run(async () => completeTask(ctx, await task(id), input)),
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
    "search",
    {
      description: "Full-text search across tasks, features, notes and decisions.",
      inputSchema: SearchInput,
      annotations: { readOnlyHint: true },
    },
    (input) => run(() => search(ctx, input)),
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
          "3. Split the work into small tasks. Call task_create for each with featureId set and",
          "   dependsOn listing the tasks that must finish first.",
        ].join("\n"),
      ),
  );
}
