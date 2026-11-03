import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Note, Project, Task } from "@sati/core";

export const NOW = "2026-11-03T12:00:00.000Z";
export const ACTOR = "actr_01JC0000000000000000000000";
export const PROJECT_ID = "prj_01JC0000000000000000000000";

export const tmpDb = () => join(mkdtempSync(join(tmpdir(), "sati-store-")), "sati.db");

let seq = 0;
const nextId = (prefix: string) => `${prefix}_01JC${String(++seq).padStart(22, "0")}`;

export const project = (): Project => ({
  id: PROJECT_ID,
  slug: "demo",
  name: "Demo",
  repoUrl: null,
  mode: "git",
  settings: { leaseMinutes: 30 },
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: ACTOR,
  version: 1,
  deletedAt: null,
});

export const task = (over: Partial<Task> = {}): Task => ({
  id: nextId("tsk"),
  projectId: PROJECT_ID,
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: ACTOR,
  version: 1,
  deletedAt: null,
  title: "Task",
  body: "",
  status: "todo",
  priority: "medium",
  featureId: null,
  parentId: null,
  dependsOn: [],
  labels: [],
  branch: null,
  worktree: null,
  claim: null,
  completion: null,
  ...over,
});

export const note = (over: Partial<Note> = {}): Note => ({
  id: nextId("note"),
  projectId: PROJECT_ID,
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: ACTOR,
  version: 1,
  deletedAt: null,
  title: "Note",
  body: "",
  tags: [],
  links: [],
  pinned: false,
  ...over,
});
