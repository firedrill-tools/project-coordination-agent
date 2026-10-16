import { readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

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
  dataset?: { id: string; version: number; profile: string; caseId?: string; provenance?: string };
  repositories: { slug: string; description: string; ownerTeam?: string; channel?: string }[];
  issues: Issue[];
  channels: string[];
  posts: { id: string; channel: string; text: string; requestId: string }[];
  audit: { operation: string; target: string; outcome: "success" | "duplicate" | "rejected" }[];
  requests?: { id: string; task: string }[];
  updates?: { requestId: string; issueId: string; status: Issue["status"] }[];
}

export type OperationResult<T> = { ok: true; data: T; replayed?: boolean } | { ok: false; error: string };

const text = (max: number) => z.string().min(1).max(max).refine(value => !!value.trim(), "must not be blank");
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const status = z.enum(["open", "in_progress", "done"]);
function numericId(prefix: string) {
  return z.string().refine(value => new RegExp(`^${prefix}[1-9][0-9]*$`).test(value) && Number.isSafeInteger(Number(value.slice(prefix.length))), "invalid numeric ID");
}
const schema = z.object({
  synthetic: z.literal(true), version: z.literal(1),
  dataset: z.object({ id: text(100), version: revision, profile: text(80), caseId: text(80).optional(), provenance: text(1000).optional() }).passthrough().optional(),
  repositories: z.array(z.object({ slug: text(160).refine(value => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value), "invalid repository slug"), description: text(2000), ownerTeam: text(120).optional(), channel: text(80).optional() }).passthrough()),
  issues: z.array(z.object({ id: numericId("N-"), repository: text(160), title: text(200), body: text(10000), status, revision, requestId: text(100) }).passthrough()),
  channels: z.array(text(80)),
  posts: z.array(z.object({ id: numericId("post-"), channel: text(80), text: text(10000), requestId: text(105) }).passthrough()),
  audit: z.array(z.object({ operation: z.enum(["create_issue", "update_issue", "post_message"]), target: text(160), outcome: z.enum(["success", "duplicate", "rejected"]) }).passthrough()),
  requests: z.array(z.object({ id: text(100), task: text(8000) }).passthrough()).optional(),
  updates: z.array(z.object({ requestId: text(100), issueId: numericId("N-"), status }).passthrough()).optional(),
}).passthrough();
export function validateState(value: unknown): WorkspaceState {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Unsupported synthetic workspace at ${issue.path.join(".") || "root"}: ${issue.message}`);
  }
  const state = parsed.data as WorkspaceState;
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} in workspace`); };
  unique(state.repositories.map(repo => repo.slug), "repository"); unique(state.channels, "channel");
  unique(state.issues.map(issue => issue.id), "issue ID"); unique(state.issues.map(issue => issue.requestId), "issue request ID");
  unique(state.posts.map(post => post.id), "post ID"); unique(state.posts.map(post => post.requestId), "post request ID");
  unique((state.requests ?? []).map(request => request.id), "request ID");
  unique((state.updates ?? []).map(update => JSON.stringify([update.requestId, update.issueId])), "status request/issue binding");
  const repos = new Set(state.repositories.map(repo => repo.slug)), issues = new Set(state.issues.map(issue => issue.id)), posts = new Set(state.posts.map(post => post.id));
  if (state.issues.some(issue => !repos.has(issue.repository)) || state.updates?.some(update => !issues.has(update.issueId))) throw new Error("Orphan issue/revision history in workspace");
  if (state.audit.some(event => event.outcome !== "rejected" && !(event.operation === "post_message" ? posts : issues).has(event.target))) throw new Error("Orphan audit target in workspace");
  // Channel availability can change: prior posts/preferred repository channels
  // remain historical data even when that destination is unavailable now.
  return state;
}
export function loadState(path: string): WorkspaceState { return validateState(JSON.parse(readFileSync(path, "utf8"))); }

function saveState(path: string, state: WorkspaceState): void {
  validateState(state);
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
    if (typeof id !== "string" || !id.trim() || id.length > 100 || typeof task !== "string" || !task.trim() || task.length > 8000) return { ok: false, error: "a nonempty request ID (up to 100 characters) and task are required" };
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
      `${issue.id} ${issue.title} ${issue.body}`.toLowerCase().includes(term),
    );
  }

  createIssue(repository: string, title: string, body: string, requestId: string): OperationResult<Issue> {
    if (typeof title !== "string" || typeof body !== "string" || !body.trim() || body.length > 10000 || typeof requestId !== "string" || !requestId.trim() || requestId.length > 100) return { ok: false, error: "invalid issue input/request ID" };
    title = title.trim().replace(/\s+/g, " ");
    if (!title || title.length > 200 || !body.trim()) return { ok: false, error: "title and body must not be blank" };
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
    let next = 100;
    for (const issue of state.issues) next = Math.max(next, Number(issue.id.slice(2)));
    if (next === Number.MAX_SAFE_INTEGER) return { ok: false, error: "issue ID space exhausted" };
    next += 1;
    const issue: Issue = { id: `N-${next}`, repository, title, body, status: "open", revision: 1, requestId };
    state.issues.push(issue);
    state.audit.push({ operation: "create_issue", target: issue.id, outcome: "success" });
    saveState(this.path, state);
    return { ok: true, data: issue };
  }

  updateIssue(issueId: string, status: Issue["status"], expectedRevision: number, requestId: string): OperationResult<Issue> {
    if (!["open", "in_progress", "done"].includes(status) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || typeof requestId !== "string" || !requestId.trim() || requestId.length > 100) return { ok: false, error: "invalid status, revision or request ID" };
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
    if (issue.status !== status) {
      if (issue.revision === Number.MAX_SAFE_INTEGER) return { ok: false, error: "issue revision space exhausted" };
      issue.status = status; issue.revision += 1;
    }
    (state.updates ??= []).push({ requestId, issueId, status });
    state.audit.push({ operation: "update_issue", target: issueId, outcome: "success" });
    saveState(this.path, state);
    return { ok: true, data: issue, replayed: false };
  }

  postMessage(channel: string, text: string, requestId: string): OperationResult<{ id: string; channel: string; text: string; requestId: string }> {
    if (typeof text !== "string" || !text.trim() || text.length > 10000 || typeof requestId !== "string" || !requestId.trim() || requestId.length > 105) return { ok: false, error: "message must not be blank" };
    const state = loadState(this.path);
    const existing = state.posts.find((post) => post.requestId === requestId);
    if (existing) {
      if (existing.channel !== channel || existing.text !== text) return { ok: false, error: "request ID used for a different post" };
      state.audit.push({ operation: "post_message", target: existing.id, outcome: "duplicate" });
      saveState(this.path, state);
      return { ok: true, data: existing };
    }
    if (!state.channels.includes(channel)) return { ok: false, error: "channel not found" };
    let next = 0;
    for (const post of state.posts) next = Math.max(next, Number(post.id.slice(5)));
    if (next === Number.MAX_SAFE_INTEGER) return { ok: false, error: "post ID space exhausted" };
    const post = { id: `post-${next + 1}`, channel, text, requestId };
    state.posts.push(post);
    state.audit.push({ operation: "post_message", target: post.id, outcome: "success" });
    saveState(this.path, state);
    return { ok: true, data: post };
  }
}
