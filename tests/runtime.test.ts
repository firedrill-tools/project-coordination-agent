import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { coordinate, type RunOptions, type RunReceipt } from "../src/agent.js";
import { aggregateUsage, reportedUsage, sha256 } from "../src/evidence.js";
import { initializeCase } from "../src/datasets.js";
import { loadState } from "../src/workspace.js";

type Handler = (index: number, body: Record<string, unknown>, signal: AbortSignal | null | undefined) => unknown | Promise<unknown>;
function api(index: number, { tool = false, usage = { input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop = tool ? "tool_use" : "end_turn" }: { tool?: boolean; usage?: unknown; stop?: string } = {}) {
  return { id: `msg_synthetic_${index}`, type: "message", role: "assistant", model: "claude-sonnet-4-6", synthetic_marker: "original-provider-value",
    content: tool ? [{ type: "tool_use", id: `tool_synthetic_${index}`, name: "createIssue", input: { repository: "northstar/web-app", title: "Receipt proof", body: "Fictional native SDK proof" } }] : [{ type: "text", text: "Controlled terminal answer" }],
    stop_reason: stop, stop_sequence: null, usage };
}
function setup(t: TestContext, handler: Handler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "firedrill-coordinator-runtime-")), statePath = path.join(directory, "workspace.json");
  fs.copyFileSync(path.resolve(import.meta.dirname, "../../fixtures/starter-workspace.json"), statePath);
  const savedFetch = globalThis.fetch, savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = `synthetic-${randomUUID()}`;
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(init?.body)); const index = requests.length; requests.push(body);
    const response = await handler(index, body, init?.signal);
    return response instanceof Response ? response : new Response(JSON.stringify(response), { headers: { "content-type": "application/json", "request-id": `req_synthetic_${index}` } });
  };
  t.after(() => { globalThis.fetch = savedFetch; if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; fs.rmSync(directory, { recursive: true, force: true }); });
  const options: RunOptions = { statePath, outputRoot: path.join(directory, "runs"), task: "Create the fictional Receipt proof issue", requestId: "receipt-proof", model: "anthropic/claude-sonnet-4-6", allowWrites: true };
  return { directory, statePath, options, requests };
}
function receipt(file: string): RunReceipt { return JSON.parse(fs.readFileSync(file, "utf8")); }
async function failed(options: RunOptions) {
  try { await coordinate(options); assert.fail("expected failed execution"); }
  catch (error) { assert.ok(error instanceof Error); const e = error as Error & { evidence: RunReceipt; receiptPath: string }; assert.equal(e.evidence.status, "failed"); assert.equal(e.evidence.receiptPath, e.receiptPath); return e; }
}

test("normal callable writes private durable native provider evidence and correlated tool effects", async t => {
  const f = setup(t, index => api(index, { tool: index === 0 })), before = fs.readFileSync(f.statePath);
  const result = await coordinate(f.options), saved = receipt(result.receiptPath);
  assert.equal(result.executionStatus, "completed"); assert.equal(f.requests.length, 2); assert.equal(saved.status, "completed");
  assert.equal(fs.statSync(result.receiptPath).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(result.receiptPath)).mode & 0o777, 0o700);
  assert.equal(saved.initialState.fileSha256, sha256(before)); assert.equal(saved.finalState?.fileSha256, sha256(fs.readFileSync(f.statePath)));
  assert.equal(saved.initialState.counts?.issues, 2); assert.equal(saved.finalState?.counts?.issues, 3);
  assert.equal(saved.actions.length, 1); assert.equal(saved.actions[0].toolCallId, "tool_synthetic_0"); assert.equal(saved.actions[0].modelStepNumber, 0);
  assert.equal(saved.observations[0].providerResponse?.requestId, "req_synthetic_0");
  assert.equal((saved.observations[0].providerResponse?.body as { synthetic_marker?: string }).synthetic_marker, "original-provider-value");
  assert.deepEqual(result.reportedUsage.totals, { inputTokens: 24, outputTokens: 10, totalTokens: 34 }); assert.equal(result.reportedUsage.cost.amount, null);
  assert.ok(saved.observations.every(step => step.status === "accepted" && step.startedAt && step.finishedAt && /^[a-f0-9]{64}$/.test(step.promptSha256 ?? "")));
});

test("provider zero and missing cache measurements survive SDK normalization separately", async t => {
  let full = false;
  const f = setup(t, index => api(index, { usage: full ? { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } : { input_tokens: 0, output_tokens: 0 } }));
  const first = await coordinate({ ...f.options, allowWrites: false });
  assert.equal(first.reportedUsage.status, "partial"); assert.equal(first.reportedUsage.totals, null);
  assert.equal(first.modelStepObservations[0].reportedUsage?.fields.cache_read_input_tokens, null);
  assert.equal((first.modelStepObservations[0].providerResponse?.body as { usage: object }).usage && Object.hasOwn((first.modelStepObservations[0].providerResponse?.body as { usage: object }).usage, "cache_read_input_tokens"), false);
  full = true;
  const second = await coordinate({ ...f.options, allowWrites: false });
  assert.deepEqual(second.reportedUsage.totals, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }); assert.equal(second.reportedUsage.status, "reported");
  assert.notEqual(first.runId, second.runId); assert.equal(first.issueCount, 2);
});

test("failed provider call after an issue retains committed state and measured failed-attempt usage", async t => {
  const f = setup(t, index => index === 0 ? api(index, { tool: true }) : new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "synthetic retained failure" }, usage: { input_tokens: 2, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }), { status: 503, headers: { "content-type": "application/json", "request-id": "failed-native-request" } }));
  const error = await failed(f.options), saved = receipt(error.receiptPath);
  assert.equal(f.requests.length, 2); assert.equal(loadState(f.statePath).issues.length, 3); assert.equal(saved.actions.length, 1);
  assert.equal(saved.observations[1].sdkError?.statusCode, 503); assert.equal(saved.observations[1].providerResponse?.requestId, "failed-native-request");
  assert.equal(saved.observations[1].status, "rejected"); assert.match(saved.observations[1].sdkError?.responseBody ?? "", /synthetic retained failure/);
  assert.deepEqual(saved.reportedUsage.totals, { inputTokens: 14, outputTokens: 5, totalTokens: 19 }); assert.equal(saved.result, null);
  assert.equal(saved.finalState?.fileSha256, sha256(fs.readFileSync(f.statePath)));
});

test("rejected max-tokens response retains original provider body and cannot dispatch its issue", async t => {
  const f = setup(t, index => api(index, { tool: true, stop: "max_tokens" }));
  const error = await failed(f.options), saved = receipt(error.receiptPath);
  assert.equal(f.requests.length, 1); assert.equal(loadState(f.statePath).issues.length, 2); assert.equal(saved.actions.length, 0);
  assert.equal((saved.observations[0].providerResponse?.body as { stop_reason: string }).stop_reason, "max_tokens");
  assert.equal(saved.observations[0].finishReason, "length"); assert.equal(saved.observations[0].reportedUsage?.status, "reported");
});

test("malformed native JSON retains SDK error body text without invented usage", async t => {
  const f = setup(t, () => new Response('{"broken":', { headers: { "content-type": "application/json" } }));
  const error = await failed(f.options), saved = receipt(error.receiptPath);
  assert.equal(f.requests.length, 1); assert.equal(saved.actions.length, 0); assert.equal(saved.reportedUsage.totals, null);
  assert.equal(saved.observations[0].providerResponse?.body, '{"broken":');
});

test("one canonical workspace owner rejects concurrent aliases and releases after cancellation", async t => {
  let ready!: () => void, finish = false;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const f = setup(t, (index, _body, signal) => {
    if (finish) return api(index);
    return new Promise((_resolve, reject) => {
      assert.ok(signal); const handle = setInterval(() => {}, 1000);
      signal.addEventListener("abort", () => { clearInterval(handle); reject(signal.reason); }, { once: true }); ready();
    });
  });
  const controller = new AbortController(), pending = coordinate({ ...f.options, signal: controller.signal });
  await started;
  const alias = path.join(f.directory, "alias.json"); fs.symlinkSync(f.statePath, alias);
  await assert.rejects(coordinate({ ...f.options, statePath: alias }), /active coordinator/);
  controller.abort("synthetic cancellation");
  const error = await pending.catch(e => e as Error & { receiptPath: string }); assert.ok(error instanceof Error);
  assert.equal(receipt(error.receiptPath).status, "failed");
  finish = true; const result = await coordinate({ ...f.options, allowWrites: false });
  assert.equal(result.executionStatus, "completed"); assert.equal(result.issueCount, 2);
});

test("receipt publication failure after commit aborts further calls and records the partial effect", async t => {
  const f = setup(t, index => api(index, { tool: index === 0 }));
  const original = fs.renameSync; let injected = false;
  fs.renameSync = ((from, to) => {
    if (!injected && String(to).endsWith("receipt.json") && JSON.parse(fs.readFileSync(from, "utf8")).actions.length === 1) { injected = true; throw new Error("synthetic receipt publication failure"); }
    return original(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  let error;
  try { error = await failed(f.options); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.equal(f.requests.length, 1); assert.equal(loadState(f.statePath).issues.length, 3);
  const saved = receipt(error.receiptPath); assert.equal(saved.status, "failed"); assert.equal(saved.actions.length, 1); assert.match(saved.error?.message ?? "", /publication failure/);
  assert.ok(fs.readdirSync(path.dirname(error.receiptPath)).every(name => !name.endsWith(".tmp")));
});

test("provider aggregates require every known field and reject boolean/fractional/overflow counts", () => {
  assert.equal(reportedUsage({}).available, false); assert.equal(reportedUsage({ usage: null }).available, true);
  for (const bad of [true, 1.5, -1, "2"]) assert.equal(reportedUsage({ usage: { input_tokens: bad, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }).totals, null);
  const measured = reportedUsage({ usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  assert.equal(aggregateUsage([{ reportedUsage: measured }, { reportedUsage: measured }]).totals, null);
  assert.equal(aggregateUsage([{ reportedUsage: measured }, {}]).totals, null);
});

test("missing provider usage remains unknown even if the SDK rejects that response schema", async t => {
  const f = setup(t, index => { const body = api(index); delete (body as { usage?: unknown }).usage; return body; });
  let saved: RunReceipt;
  try { const result = await coordinate({ ...f.options, allowWrites: false }); saved = receipt(result.receiptPath); }
  catch (error) { saved = receipt((error as { receiptPath: string }).receiptPath); }
  assert.equal(f.requests.length, 1); assert.equal(saved.actions.length, 0); assert.equal(saved.reportedUsage.totals, null);
  assert.equal(saved.observations[0].reportedUsage?.available, false);
  assert.equal(Object.hasOwn(saved.observations[0].providerResponse?.body as object, "usage"), false);
});

test("oversized decoded provider body cannot dispatch tools and retains available usage", async t => {
  const f = setup(t, index => ({ ...api(index, { tool: true }), synthetic_large_field: "x".repeat(1_048_577) }));
  const error = await failed(f.options), saved = receipt(error.receiptPath);
  assert.equal(f.requests.length, 1); assert.equal(saved.actions.length, 0); assert.equal(loadState(f.statePath).issues.length, 2);
  assert.equal(saved.observations[0].providerResponse?.truncated, true); assert.equal(saved.observations[0].reportedUsage?.status, "reported");
  assert.match(saved.error?.message ?? "", /evidence limit/);
});

test("persistent receipt failure exposes an in-memory failure without rolling back the issue", async t => {
  const f = setup(t, index => api(index, { tool: index === 0 }));
  const error = await failed({ ...f.options, onAction: () => {
    const directory = path.join(f.options.outputRoot!, fs.readdirSync(f.options.outputRoot!)[0]);
    const file = path.join(directory, "receipt.json"); fs.unlinkSync(file); fs.mkdirSync(file);
  } });
  assert.equal(f.requests.length, 1); assert.equal(loadState(f.statePath).issues.length, 3);
  assert.ok(error.evidence.evidenceError); assert.equal(error.evidence.status, "failed"); assert.equal(error.evidence.finalState?.counts?.issues, 3);
  assert.ok(fs.statSync(error.receiptPath).isDirectory());
});


test("invalid initial state records its original hash and rejects before any provider call", async t => {
  const f = setup(t, index => api(index)); const state = loadState(f.statePath); state.issues[1].id = state.issues[0].id;
  fs.writeFileSync(f.statePath, JSON.stringify(state)); const before = fs.readFileSync(f.statePath);
  const error = await failed(f.options), saved = receipt(error.receiptPath);
  assert.equal(f.requests.length, 0); assert.match(saved.initialState.error ?? "", /Duplicate issue/);
  assert.equal(saved.initialState.fileSha256, sha256(before)); assert.equal(saved.finalState?.fileSha256, sha256(before));
});

test("tool publication exception is retained with actual state even when the SDK produces final text", async t => {
  const f = setup(t, index => api(index, { tool: index === 0 })), original = fs.renameSync, canonicalStatePath = fs.realpathSync(f.statePath); let injected = false;
  fs.renameSync = ((from, to) => {
    if (!injected && String(to) === canonicalStatePath && JSON.parse(fs.readFileSync(from, "utf8")).issues.length === 3) { injected = true; throw new Error("synthetic tool state failure"); }
    return original(from, to);
  }) as typeof fs.renameSync; syncBuiltinESMExports();
  let result;
  try { result = await coordinate(f.options); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.equal(injected, true); const saved = receipt(result.receiptPath);
  assert.equal(result.executionStatus, "completed"); // provider completion is separate from task correctness
  assert.equal(result.issueCount, 2); assert.equal(result.auditCount, 0);
  assert.equal(saved.actions.length, 1); assert.deepEqual(saved.actions[0].result, { ok: false, exception: true, error: "synthetic tool state failure" });
});


function toolResultText(request: Record<string, unknown>) {
  return JSON.stringify((request.messages as { content: unknown }[]).flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "tool_result") : []));
}
test("native busy workflow reads live revisions and changes only the requested issue/owner channel", async t => {
  const steps = [
    ["listRepositories", {}],
    ["findIssues", { query: "N-103", repository: "northstar/web-app" }],
    ["readChannel", { channel: "product" }],
    ["updateIssue", { issueId: "N-103", status: "done", expectedRevision: 2 }],
    ["postMessage", { channel: "product", text: "N-103 is done in northstar/web-app; Web Experience has the update." }],
  ] as const;
  const f = setup(t, index => {
    const step = steps[index], body = api(index, { tool: Boolean(step) });
    if (step) body.content = [{ type: "tool_use", id: `tool_synthetic_${index}`, name: step[0], input: step[1] }] as typeof body.content;
    return body;
  });
  fs.unlinkSync(f.statePath); const selected = initializeCase("busy", f.statePath), before = loadState(f.statePath);
  const result = await coordinate({ ...f.options, task: selected.task, requestId: selected.requestId, allowWrites: selected.allowWrites });
  const after = loadState(f.statePath), saved = receipt(result.receiptPath);
  assert.equal(f.requests.length, 6); assert.equal(saved.initialState.fileSha256, selected.sha256);
  assert.equal(saved.initialState.dataset?.version, 2); assert.equal(saved.initialState.dataset?.caseId, "busy");
  assert.deepEqual(after.issues.filter(issue => issue.id !== "N-103"), before.issues.filter(issue => issue.id !== "N-103"));
  assert.equal(after.issues.find(issue => issue.id === "N-103")?.revision, 3); assert.equal(after.posts.at(-1)?.id, "post-18");
  assert.equal(after.posts.at(-1)?.channel, "product"); assert.deepEqual(after.posts.slice(0, before.posts.length), before.posts);
  assert.match(toolResultText(f.requests[2]), /N-103/); assert.match(toolResultText(f.requests[4]), /done/);
  assert.deepEqual(saved.actions.map(action => action.name), steps.map(step => step[0]));
});

test("native recovery uses the original task binding and replays cannot duplicate issue/posts", async t => {
  const steps = [
    ["findIssues", { query: "Sync recovery", repository: "northstar/web-app" }],
    ["createIssue", { repository: "northstar/web-app", title: "Sync recovery after reconnect", body: "Sync fails after reconnect" }],
    ["postMessage", { channel: "product", text: "Sync recovery issue N-103 exists in northstar/web-app." }],
  ] as const;
  const f = setup(t, index => {
    const step = steps[index % 4], body = api(index, { tool: Boolean(step) });
    if (step) body.content = [{ type: "tool_use", id: `tool_synthetic_${index}`, name: step[0], input: step[1] }] as typeof body.content;
    return body;
  });
  fs.unlinkSync(f.statePath); const selected = initializeCase("partial-recovery", f.statePath);
  const options = { ...f.options, task: selected.task, requestId: selected.requestId, allowWrites: true };
  const first = await coordinate(options), firstReceipt = receipt(first.receiptPath), second = await coordinate(options);
  assert.equal(f.requests.length, 8); assert.equal(first.issueCount, 3); assert.equal(first.postCount, 1); assert.equal(second.issueCount, 3); assert.equal(second.postCount, 1);
  assert.equal(receipt(second.receiptPath).initialState.fileSha256, firstReceipt.finalState?.fileSha256);
  const state = loadState(f.statePath); assert.equal(state.posts[0].requestId, "recover-sync:post");
  await assert.rejects(coordinate({ ...options, task: "A different write intent" }), /different task/);
  assert.equal(f.requests.length, 8);
});

test("provider cache counts are combined with uncached input without substituting SDK defaults", async t => {
  const usage = { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 };
  const f = setup(t, index => api(index, { usage }));
  const result = await coordinate({ ...f.options, allowWrites: false }), saved = receipt(result.receiptPath);
  assert.deepEqual(result.reportedUsage.totals, { inputTokens: 17, outputTokens: 2, totalTokens: 19 });
  assert.deepEqual(saved.observations[0].reportedUsage?.raw, usage);
  assert.equal(saved.initialState.fileSha256, saved.finalState?.fileSha256);
});
