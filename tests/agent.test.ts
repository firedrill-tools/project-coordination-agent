import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { buildCoordinator, completedResponse, modelObservation } from "../src/agent.js";
import { makeTools } from "../src/tools.js";
import { Workspace, loadState } from "../src/workspace.js";

function seeded(t: TestContext, fixture = "starter-workspace.json") {
  const dir = mkdtempSync(join(tmpdir(), "coordination-sdk-"));
  const path = join(dir, "workspace.json");
  copyFileSync(resolve(import.meta.dirname, "../../fixtures", fixture), path);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

function scriptedModel() {
  let step = 0;
  return new MastraLanguageModelV2Mock({
    modelId: "scripted-coordinator",
    doGenerate: async () => {
      const index = step++;
      const toolName = index === 0 ? "createIssue" : "postMessage";
      const input = JSON.stringify(index === 0
        ? { repository: "northstar/web-app", title: "Sync recovery", body: "Sync fails after reconnect" }
        : { channel: "engineering", text: "The web-app sync issue is recorded." });
      return { content: index < 2
        ? [{ type: "text" as const, text: "Processing the synthetic request." }, { type: "tool-call" as const, toolCallId: `call-${index}`, toolName, input }]
        : [{ type: "text" as const, text: "Recorded the synthetic issue and engineering update." }],
        finishReason: index < 2 ? "tool-calls" : "stop", warnings: [],
        usage: { inputTokens: (index + 1) * 10, outputTokens: index + 2, totalTokens: (index + 1) * 10 + index + 2 } };
    },
  });
}

test("actual Mastra loop binds caller IDs, replays effects and reports all-step usage", async t => {
  const statePath = seeded(t);
  const options = { statePath, task: "Record a web sync issue and notify engineering", requestId: "caller-42", model: "anthropic/scripted", allowWrites: true };
  const first = await buildCoordinator(options, scriptedModel()).generate(options.task, { maxSteps: 8 });
  const evidence = modelObservation(first);
  assert.equal(completedResponse(first), true);
  assert.equal(evidence.stepCount, 3);
  assert.equal(evidence.usageComplete, true);
  assert.equal(evidence.usage?.inputTokens, 60);
  assert.equal(evidence.usage?.outputTokens, 9);
  assert.equal(evidence.usage?.totalTokens, 69);
  assert.equal(evidence.lastStepUsage?.totalTokens, 34);
  assert.equal(evidence.costUsd, null);
  assert.equal(loadState(statePath).issues.at(-1)?.requestId, "caller-42");
  assert.equal(loadState(statePath).posts[0]?.requestId, "caller-42:post");
  await buildCoordinator(options, scriptedModel()).generate(options.task, { maxSteps: 8 });
  assert.equal(loadState(statePath).issues.length, 3);
  assert.equal(loadState(statePath).posts.length, 1);
});

test("read-only Mastra tools cannot change state or register a write request", async t => {
  const path = seeded(t); const before = readFileSync(path, "utf8");
  const tools = makeTools(new Workspace(path), false, "read-only");
  assert.deepEqual(await tools.readChannel.execute!({ channel: "product" }, {} as never), { ok: true, data: [] });
  const expected = { ok: false, error: "writes are not authorized for this run" };
  assert.deepEqual(await tools.createIssue.execute!({ repository: "northstar/web-app", title: "Read only", body: "No change" }, {} as never), expected);
  assert.deepEqual(await tools.updateIssue.execute!({ issueId: "N-101", status: "done", expectedRevision: 1 }, {} as never), expected);
  assert.deepEqual(await tools.postMessage.execute!({ channel: "product", text: "No change" }, {} as never), expected);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("model-supplied retry IDs cannot replace the caller's binding", async t => {
  const path = seeded(t); const tools = makeTools(new Workspace(path), true, "caller-owned");
  const input = { repository: "northstar/web-app", title: "Bound ID", body: "Synthetic issue", requestId: "model-invented" };
  await tools.createIssue.execute!(input, {} as never);
  const post = { channel: "product", text: "Bound update", requestId: "model-invented-post" };
  await tools.postMessage.execute!(post, {} as never);
  assert.equal(loadState(path).issues.at(-1)?.requestId, "caller-owned");
  assert.equal(loadState(path).posts[0]?.requestId, "caller-owned:post");
});

test("an old status replay returns current state without undoing later work", t => {
  const path = seeded(t); const store = new Workspace(path);
  assert.equal(store.updateIssue("N-101", "done", 1, "first").ok, true);
  assert.equal(store.updateIssue("N-101", "open", 2, "later").ok, true);
  const replay = store.updateIssue("N-101", "done", 3, "first");
  assert.equal(replay.ok, true);
  if (replay.ok) { assert.equal(replay.replayed, true); assert.equal(replay.data.status, "open"); }
  assert.equal(loadState(path).issues[0].revision, 3);
  assert.equal(store.updateIssue("N-101", "in_progress", 3, "first").ok, false);
});

test("a caller request cannot be reused for a changed task", t => {
  const statePath = seeded(t);
  const options = { statePath, task: "Record a sync issue", requestId: "same", model: "anthropic/scripted", allowWrites: true };
  buildCoordinator(options, scriptedModel());
  const before = readFileSync(statePath, "utf8");
  assert.throws(() => buildCoordinator({ ...options, task: "Close the invite issue" }, scriptedModel()), /different task/);
  assert.equal(readFileSync(statePath, "utf8"), before);
});

test("a partial issue/post workflow resumes from persisted state", async t => {
  const path = seeded(t); let store = new Workspace(path);
  let tools = makeTools(store, true, "partial");
  const issue = { repository: "northstar/web-app", title: "Recovery case", body: "Synthetic issue" };
  await tools.createIssue.execute!(issue, {} as never);
  const rejected = await tools.postMessage.execute!({ channel: "unknown", text: "Update" }, {} as never);
  assert.deepEqual(rejected, { ok: false, error: "channel not found" });
  store = new Workspace(path); tools = makeTools(store, true, "partial");
  await tools.createIssue.execute!(issue, {} as never);
  await tools.postMessage.execute!({ channel: "engineering", text: "Update" }, {} as never);
  assert.equal(loadState(path).issues.length, 3);
  assert.equal(loadState(path).posts.length, 1);
});

test("title normalization rejects blank and whitespace-disguised duplicates", t => {
  const path = seeded(t); const store = new Workspace(path);
  assert.equal(store.createIssue("northstar/web-app", " ADMIN  invite button returns a permission error ", "Duplicate", "new").ok, false);
  assert.equal(store.createIssue("northstar/web-app", "   ", "Blank", "blank").ok, false);
  assert.equal(loadState(path).issues.length, 2);
});

test("unreported SDK token usage stays unknown instead of becoming zero cost", async t => {
  const statePath = seeded(t);
  const model = new MastraLanguageModelV2Mock({ doGenerate: async () => ({
    content: [{ type: "text", text: "Read-only answer" }], finishReason: "stop", warnings: [],
    usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
  }) });
  const response = await buildCoordinator({ statePath, task: "Inspect issues", requestId: "unknown-usage", model: "anthropic/scripted", allowWrites: false }, model).generate("Inspect issues");
  const evidence = modelObservation(response);
  assert.equal(evidence.usage, null);
  assert.equal(evidence.usageComplete, false);
  assert.equal(evidence.costUsd, null);
});

test("busy workspace tools use the exact repository and owner channel without changing other issues", async t => {
  const path = seeded(t, "busy-workspace.json"); const before = loadState(path);
  const tools = makeTools(new Workspace(path), true, "busy-1");
  const directory = await tools.listRepositories.execute!({}, {} as never) as { repositories: { slug: string; channel?: string }[]; channels: string[] };
  const channel = directory.repositories.find(repo => repo.slug === "northstar/web-app")?.channel;
  assert.equal(channel, "product"); assert.ok(directory.channels.includes(channel!));
  const previous = await tools.readChannel.execute!({ channel: "mobile" }, {} as never) as ReturnType<Workspace["channelPosts"]>;
  assert.equal(previous.ok, true);
  if (previous.ok) assert.equal(previous.data[0]?.requestId, "seed-106:post");
  const found = await tools.findIssues.execute!({ query: "sync recovery", repository: "northstar/web-app" }, {} as never) as { issues: { id: string; revision: number }[] };
  assert.equal(found.issues[0]?.id, "N-103");
  await tools.updateIssue.execute!({ issueId: "N-103", status: "done", expectedRevision: found.issues[0].revision }, {} as never);
  await tools.postMessage.execute!({ channel: channel!, text: "N-103 is done in the web application." }, {} as never);
  const after = loadState(path);
  assert.equal(after.dataset?.profile, "busy");
  assert.deepEqual(after.issues.filter(issue => issue.id !== "N-103"), before.issues.filter(issue => issue.id !== "N-103"));
  assert.deepEqual(after.posts.slice(0, 2), before.posts);
  assert.equal(after.posts.at(-1)?.channel, "product");
});

test("ambiguous titles across repositories remain distinct", t => {
  const path = seeded(t, "ambiguous-workspace.json"); const store = new Workspace(path);
  assert.equal(store.findIssues("admin invite").length, 2);
  assert.deepEqual(store.findIssues("admin invite", "northstar/web-app").map(issue => issue.id), ["N-101"]);
  assert.deepEqual(store.findIssues("admin invite", "northstar/mobile-app").map(issue => issue.id), ["N-107"]);
});

test("an empty channel directory cannot fall back to an invented destination", async t => {
  const path = seeded(t, "no-channels-workspace.json"); const before = readFileSync(path, "utf8");
  const tools = makeTools(new Workspace(path), true, "no-channel");
  assert.deepEqual(await tools.postMessage.execute!({ channel: "product", text: "No destination" }, {} as never), { ok: false, error: "channel not found" });
  assert.equal(readFileSync(path, "utf8"), before);
});

test("a missing CLI request ID value cannot silently become a new retry identity", t => {
  const path = seeded(t); const before = readFileSync(path, "utf8");
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../src/cli.js"), "run", "--state", path, "--task", "Inspect issues", "--request-id"],
    { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
  assert.equal(result.status, 1); assert.match(result.stderr, /--request-id is required/);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("a bounded loop with progress text cannot claim a completed execution", async t => {
  const statePath = seeded(t);
  const agent = buildCoordinator({ statePath, task: "Record an issue and notify engineering", requestId: "bounded", model: "anthropic/scripted", allowWrites: true }, scriptedModel());
  const response = await agent.generate("Record the synthetic issue and notify engineering", { maxSteps: 1 });
  assert.ok(response.text.trim());
  assert.equal(response.finishReason, "tool-calls");
  assert.equal(completedResponse(response), false);
  assert.equal(loadState(statePath).issues.length, 3);
  assert.equal(loadState(statePath).posts.length, 0);
});
