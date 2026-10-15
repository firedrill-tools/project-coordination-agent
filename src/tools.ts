import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Workspace } from "./workspace.js";

export function makeTools(workspace: Workspace, allowWrites: boolean) {
  const listRepositories = createTool({
    id: "list-repositories",
    description: "List the exact repository slugs available in the synthetic project workspace.",
    inputSchema: z.object({}),
    execute: async () => ({ repositories: workspace.repositories() }),
  });

  const findIssues = createTool({
    id: "find-issues",
    description: "Search issue titles and bodies; optionally restrict to an exact repository slug.",
    inputSchema: z.object({ query: z.string().min(1), repository: z.string().optional() }),
    execute: async ({ query, repository }) => ({ issues: workspace.findIssues(query, repository) }),
  });

  const createIssue = createTool({
    id: "create-issue",
    description: "Create an issue in one exact synthetic repository. Search first; use the caller's request ID for retry safety.",
    inputSchema: z.object({ repository: z.string(), title: z.string().min(1), body: z.string().min(1), requestId: z.string().min(1) }),
    execute: async ({ repository, title, body, requestId }) =>
      allowWrites ? workspace.createIssue(repository, title, body, requestId) : { ok: false, error: "writes are not authorized for this run" },
  });

  const updateIssue = createTool({
    id: "update-issue",
    description: "Change an issue status only with its current revision, so stale updates are rejected.",
    inputSchema: z.object({ issueId: z.string(), status: z.enum(["open", "in_progress", "done"]), expectedRevision: z.number().int().positive() }),
    execute: async ({ issueId, status, expectedRevision }) =>
      allowWrites ? workspace.updateIssue(issueId, status, expectedRevision) : { ok: false, error: "writes are not authorized for this run" },
  });

  const postMessage = createTool({
    id: "post-message",
    description: "Post a concise update in an existing synthetic Slack-style channel, using the caller's request ID with a :post suffix.",
    inputSchema: z.object({ channel: z.string(), text: z.string().min(1), requestId: z.string().min(1) }),
    execute: async ({ channel, text, requestId }) =>
      allowWrites ? workspace.postMessage(channel, text, requestId) : { ok: false, error: "writes are not authorized for this run" },
  });

  return { listRepositories, findIssues, createIssue, updateIssue, postMessage };
}
