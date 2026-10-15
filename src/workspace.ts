import { readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
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
  dataset?: { id: string; version: number; profile: string };
  repositories: { slug: string; description: string; ownerTeam?: string; channel?: string }[];
  issues: Issue[];
  channels: string[];
  posts: { id: string; channel: string; text: string; requestId: string }[];
  audit: { operation: string; target: string; outcome: "success" | "duplicate" | "rejected" }[];
  requests?: { id: string; task: string }[];
  updates?: { requestId: string; issueId: string; status: Issue["status"] }[];
}

export type OperationResult<T> = { ok: true; data: T; replayed?: boolean } | { ok: false; error: string };

export function loadState(path: string): WorkspaceState {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || !("synthetic" in value) || value.synthetic !== true) {
    throw new Error("Only a synthetic workspace state file is supported");
  }
  const state = value as WorkspaceState;
  if (state.version !== 1 || !Array.isArray(state.repositories) || !Array.isArray(state.issues) || !Array.isArray(state.posts)
      || !Array.isArray(state.channels) || !Array.isArray(state.audit)
      || (state.requests !== undefined && !Array.isArray(state.requests))
      || (state.updates !== undefined && !Array.isArray(state.updates))) {
    throw new Error("Unsupported workspace state format");
  }
  return state;
}

function saveState(path: string, state: WorkspaceState): void {
  const temp = join(dirname(path), `.workspace-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export class Workspace {
  constructor(private readonly path: string) { loadState(path); }

  repositories() { return loadState(this.path).repositories; }
  channels() { return loadState(this.path).channels; }

  channelPosts(channel: string): OperationResult<WorkspaceState["posts"]> {
    const state = loadState(this.path);
    return state.channels.includes(channel) ? { ok: true, data: state.posts.filter(post => post.channel === channel).slice(-20) }
      : { ok: false, error: "channel not found" };
  }

  beginRequest(id: string, task: string): OperationResult<{ id: string; task: string }> {
    if (!id.trim() || id.length > 100 || !task.trim()) return { ok: false, error: "a nonempty request ID (up to 100 characters) and task are required" };
    const state = loadState(this.path);
    const existing = state.requests?.find(request => request.id === id);
    if (existing) return existing.task === task ? { ok: true, data: existing } : { ok: false, error: "request ID used for a different task" };
    const request = { id, task };
    (state.requests ??= []).push(request);
    saveState(this.path, state);
    return { ok: true, data: request };
  }

  findIssues(query: string, repository?: string): Issue[] {
    const term = query.toLowerCase().trim();
    return loadState(this.path).issues.filter((issue) =>
      (!repository || issue.repository === repository) &&
      `${issue.title} ${issue.body}`.toLowerCase().includes(term),
    );
  }

  createIssue(repository: string, title: string, body: string, requestId: string): OperationResult<Issue> {
    title = title.trim().replace(/\s+/g, " ");
    if (!title || !body.trim()) return { ok: false, error: "title and body must not be blank" };
    const state = loadState(this.path);
    const existing = state.issues.find((issue) => issue.requestId === requestId);
    if (existing) {
      if (existing.repository !== repository || existing.title !== title || existing.body !== body) return { ok: false, error: "request ID used for a different issue" };
      state.audit.push({ operation: "create_issue", target: existing.id, outcome: "duplicate" });
      saveState(this.path, state);
      return { ok: true, data: existing };
    }
    if (!state.repositories.some((repo) => repo.slug === repository)) return { ok: false, error: "repository not found" };
    if (state.issues.some((issue) => issue.repository === repository && issue.title.trim().replace(/\s+/g, " ").toLowerCase() === title.toLowerCase())) {
      return { ok: false, error: "an issue with this title already exists in the repository" };
    }
    const next = Math.max(100, ...state.issues.map((issue) => Number(issue.id.slice(2)) || 0)) + 1;
    const issue: Issue = { id: `N-${next}`, repository, title, body, status: "open", revision: 1, requestId };
    state.issues.push(issue);
    state.audit.push({ operation: "create_issue", target: issue.id, outcome: "success" });
    saveState(this.path, state);
    return { ok: true, data: issue };
  }

  updateIssue(issueId: string, status: Issue["status"], expectedRevision: number, requestId: string): OperationResult<Issue> {
    const state = loadState(this.path);
    const issue = state.issues.find((item) => item.id === issueId);
    if (!issue) return { ok: false, error: "issue not found" };
    const prior = state.updates?.find(update => update.requestId === requestId && update.issueId === issueId);
    if (prior) {
      if (prior.status !== status) return { ok: false, error: "request ID used for a different status on this issue" };
      state.audit.push({ operation: "update_issue", target: issueId, outcome: "duplicate" });
      saveState(this.path, state);
      return { ok: true, data: issue, replayed: true };
    }
    if (issue.revision !== expectedRevision) return { ok: false, error: `stale issue revision; current revision is ${issue.revision}` };
    if (issue.status !== status) { issue.status = status; issue.revision += 1; }
    (state.updates ??= []).push({ requestId, issueId, status });
    state.audit.push({ operation: "update_issue", target: issueId, outcome: "success" });
    saveState(this.path, state);
    return { ok: true, data: issue, replayed: false };
  }

  postMessage(channel: string, text: string, requestId: string): OperationResult<{ id: string; channel: string; text: string; requestId: string }> {
    if (!text.trim()) return { ok: false, error: "message must not be blank" };
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
