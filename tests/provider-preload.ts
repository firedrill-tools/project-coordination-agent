// Test-only transport preload for the actual CLI/SDK. Normal commands never
// import this module and expose no simulated provider switch.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
process.env.ANTHROPIC_API_KEY = `synthetic-cli-${randomUUID()}`;
let calls = 0;
globalThis.fetch = async (_url, init) => {
  const index = calls++;
  if (process.env.FIREDRILL_TEST_PROVIDER === "wait") {
    fs.writeFileSync(process.env.FIREDRILL_TEST_READY!, "ready");
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal || signal.aborted) { reject(signal?.reason ?? new Error("missing abort signal")); return; }
      const handle = setInterval(() => {}, 1000);
      signal.addEventListener("abort", () => { clearInterval(handle); reject(signal.reason); }, { once: true });
    });
  }
  const first = index === 0;
  const body = first ? { id: "msg_cli_synthetic", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "tool_use", id: "cli-tool-1", name: "createIssue", input: { repository: "northstar/web-app", title: "CLI evidence", body: "Fictional CLI case" } }],
    stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
    : { type: "error", error: { type: "overloaded_error", message: "synthetic CLI outage" } };
  return new Response(JSON.stringify(body), { status: first ? 200 : 503, headers: { "content-type": "application/json", "request-id": `cli-request-${index}` } });
};
