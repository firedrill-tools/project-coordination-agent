import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface Issue {
  id: string;
  repository: string;
  title: string;
  body: string;
  status: "open" | "in_progress" | "done";
  revision: number;
  requestId: string;
}

export interface WorkspaceState {
  synthetic: true;
  version: 1;
  repositories: { slug: string; description: string }[];
  issues: Issue[];
  channels: string[];
  posts: { id: string; channel: string; text: string; requestId: string }[];
  audit: { operation: string; target: string; outcome: "success" | "duplicate" | "rejected" }[];
}

export type OperationResult<T> = { ok: true; data: T } | { ok: false; error: string };

export function loadState(path: string): WorkspaceState {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || !("synthetic" in value) || value.synthetic !== true) {
    throw new Error("Only a synthetic workspace state file is supported");
  }
  const state = value as WorkspaceState;
  if (state.version !== 1 || !Array.isArray(state.repositories) || !Array.isArray(state.issues) || !Array.isArray(state.posts)) {
    throw new Error("Unsupported workspace state format");
  }
  return state;
}

function saveState(path: string, state: WorkspaceState): void {
  const temp = join(dirname(path), `.workspace-${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
}

export class Workspace {
  constructor(private readonly path: string) { loadState(path); }

  repositories() { return loadState(this.path).repositories; }

  findIssues(query: string, repository?: string): Issue[] {
    const term = query.toLowerCase().trim();
    return loadState(this.path).issues.filter((issue) =>
      (!repository || issue.repository === repository) &&
      `${issue.title} ${issue.body}`.toLowerCase().includes(term),
    );
  }

  createIssue(repository: string, title: string, body: string, requestId: string): OperationResult<Issue> {
    const state = loadState(this.path);
    const existing = state.issues.find((issue) => issue.requestId === requestId);
    if (existing) {
      if (existing.repository !== repository || existing.title !== title || existing.body !== body) return { ok: false, error: "request ID used for a different issue" };
      state.audit.push({ operation: "create_issue", target: existing.id, outcome: "duplicate" });
      saveState(this.path, state);
      return { ok: true, data: existing };
    }
    if (!state.repositories.some((repo) => repo.slug === repository)) return { ok: false, error: "repository not found" };
    if (state.issues.some((issue) => issue.repository === repository && issue.title.toLowerCase() === title.toLowerCase())) {
      return { ok: false, error: "an issue with this title already exists in the repository" };
    }
    const next = Math.max(100, ...state.issues.map((issue) => Number(issue.id.slice(2)) || 0)) + 1;
    const issue: Issue = { id: `N-${next}`, repository, title, body, status: "open", revision: 1, requestId };
    state.issues.push(issue);
    state.audit.push({ operation: "create_issue", target: issue.id, outcome: "success" });
    saveState(this.path, state);
    return { ok: true, data: issue };
  }

  updateIssue(issueId: string, status: Issue["status"], expectedRevision: number): OperationResult<Issue> {
    const state = loadState(this.path);
    const issue = state.issues.find((item) => item.id === issueId);
    if (!issue) return { ok: false, error: "issue not found" };
    if (issue.revision !== expectedRevision) return { ok: false, error: `stale issue revision; current revision is ${issue.revision}` };
    issue.status = status;
    issue.revision += 1;
    state.audit.push({ operation: "update_issue", target: issueId, outcome: "success" });
    saveState(this.path, state);
    return { ok: true, data: issue };
  }

  postMessage(channel: string, text: string, requestId: string): OperationResult<{ id: string; channel: string; text: string; requestId: string }> {
    const state = loadState(this.path);
    const existing = state.posts.find((post) => post.requestId === requestId);
    if (existing) {
      if (existing.channel !== channel || existing.text !== text) return { ok: false, error: "request ID used for a different post" };
      state.audit.push({ operation: "post_message", target: existing.id, outcome: "duplicate" });
      saveState(this.path, state);
      return { ok: true, data: existing };
    }
    if (!state.channels.includes(channel)) return { ok: false, error: "channel not found" };
    const post = { id: `post-${state.posts.length + 1}`, channel, text, requestId };
    state.posts.push(post);
    state.audit.push({ operation: "post_message", target: post.id, outcome: "success" });
    saveState(this.path, state);
    return { ok: true, data: post };
  }
}
