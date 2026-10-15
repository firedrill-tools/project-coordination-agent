import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildCoordinator, completedResponse, type StepObservation } from "../src/agent.js";
import { loadState } from "../src/workspace.js";

async function native(t: TestContext, kind: string) {
  const directory = mkdtempSync(join(tmpdir(), "firedrill-mastra-native-")), statePath = join(directory, "workspace.json");
  copyFileSync(resolve(import.meta.dirname, "../../fixtures/starter-workspace.json"), statePath);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const savedFetch = globalThis.fetch, savedKey = process.env.ANTHROPIC_API_KEY;
  // A unique synthetic key prevents Mastra's provider-instance cache retaining
  // another test's fetch closure. No real credential or provider request is used.
  process.env.ANTHROPIC_API_KEY = `synthetic-${randomUUID()}`;
  const controller = new AbortController(), fetchSignals: AbortSignal[] = [];
  const pendingHandles = new Set<ReturnType<typeof setInterval>>();
  const requests: { url: string; body: Record<string, unknown> }[] = [], observations: StepObservation[] = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(init?.body); const body = JSON.parse(String(init.body)); requests.push({ url: String(url), body }); if (init.signal) fetchSignals.push(init.signal);
    const first = requests.length === 1;
    if (kind === "outage" && !first) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "synthetic outage after issue" } }), { status: 503, headers: { "content-type": "application/json", "request-id": "synthetic-failed-request" } });
    if (["cancel", "deadline"].includes(kind)) return await new Promise<Response>((_resolve, reject) => {
      assert.ok(init.signal); if (init.signal.aborted) { reject(init.signal.reason); return; }
      // SDK deadline timers are unref'd. A real pending fetch owns a socket;
      // the controlled promise needs an equivalent owned handle under Node 22.
      const handle = setInterval(() => {}, 1000); pendingHandles.add(handle);
      init.signal.addEventListener("abort", () => { clearInterval(handle); pendingHandles.delete(handle); reject(init.signal!.reason); }, { once: true });
      if (kind === "cancel") queueMicrotask(() => controller.abort(new Error("synthetic caller cancellation")));
    });
    const call = { type: "tool_use", id: "synthetic-tool-1", name: "createIssue", input: { repository: "northstar/web-app", title: "Native completion proof", body: "Fictional controlled provider response" } };
    const content = first && !["blank", "truncated-final"].includes(kind) ? kind === "parallel" ? [call, { ...call, id: "synthetic-tool-2" }] : [call]
      : kind === "blank" ? [] : [{ type: "text", text: "Controlled final answer" }];
    const stop_reason = first ? ["truncated-tool", "truncated-final"].includes(kind) ? "max_tokens" : kind === "inconsistent-tool" ? "end_turn" : ["blank"].includes(kind) ? "end_turn" : "tool_use" : "end_turn";
    return new Response(JSON.stringify({ id: `msg_synthetic_${requests.length}`, type: "message", role: "assistant", model: "claude-sonnet-4-6", content,
      stop_reason, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }), { headers: { "content-type": "application/json" } });
  };
  try {
    const options = { statePath, task: "Create the fictional Native completion proof issue", requestId: "native-proof", model: "anthropic/claude-sonnet-4-6", allowWrites: true, observations, signal: controller.signal };
    try {
      const response = await buildCoordinator(options).generate(options.task, kind === "deadline" ? { maxSteps: 2, modelSettings: { maxRetries: 0, maxOutputTokens: 4096, timeout: { totalMs: 2000, stepMs: 100 } } } : { maxSteps: 2 });
      return { response, error: null, state: loadState(statePath), requests, observations, fetchSignals };
    } catch (error) { return { response: null, error, state: loadState(statePath), requests, observations, fetchSignals }; }
  } finally {
    for (const handle of pendingHandles) clearInterval(handle);
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  }
}

test("native Mastra Anthropic HTTP adapter executes a completed tool turn and terminal answer", async t => {
  const result = await native(t, "completed");
  assert.equal(result.requests.length, 2); assert.ok(result.requests.every(r => r.body.max_tokens === 4096)); assert.ok(result.requests.every(r => r.url === "https://api.anthropic.com/v1/messages"));
  assert.equal(result.state.issues.length, 3); assert.ok(result.response); assert.equal(completedResponse(result.response), true);
  assert.deepEqual(result.observations.map(step => step.finishReason), ["tool-calls", "stop"]);
  assert.ok(result.observations.every(step => step.rejectedReason === null));
});
for (const kind of ["truncated-tool", "inconsistent-tool", "parallel", "blank", "truncated-final"]) test(`native ${kind} is rejected before issue dispatch`, async t => {
  const result = await native(t, kind);
  assert.equal(result.requests.length, 1); assert.equal(result.state.issues.length, 2); assert.equal(result.state.posts.length, 0);
  assert.ok(result.error); assert.equal(result.response, null); assert.ok(result.observations[0].rejectedReason);
  assert.equal(result.state.requests?.length, 1); // application intent binding, not a model-created issue
});


test("native provider failure after issue is not retried and retains partial effects", async t => {
  const result = await native(t, "outage");
  assert.equal(result.requests.length, 2); assert.ok(result.error); assert.equal(result.state.issues.length, 3);
  assert.equal(result.observations.length, 2); assert.equal(result.observations[0].finishReason, "tool-calls");
  assert.equal((result.error as { statusCode?: number }).statusCode, 503);
  assert.equal(result.observations[1].sdkError?.requestId, "synthetic-failed-request");
  assert.match(result.observations[1].sdkError?.responseBody ?? "", /synthetic outage/);
});

test("native caller cancellation reaches fetch and leaves no issue", async t => {
  const result = await native(t, "cancel");
  assert.equal(result.requests.length, 1); assert.equal(result.response ? completedResponse(result.response) : false, false); assert.equal(result.state.issues.length, 2);
  assert.equal(result.observations.length, 1); assert.ok(result.observations[0].rejectedReason);
});


test("native step deadline aborts the actual fetch signal", async t => {
  const result = await native(t, "deadline");
  assert.equal(result.requests.length, 1); assert.equal(result.fetchSignals[0].aborted, true);
  assert.equal(result.response ? completedResponse(result.response) : false, false); assert.equal(result.state.issues.length, 2);
});
