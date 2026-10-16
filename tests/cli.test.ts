import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { loadState } from "../src/workspace.js";

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "firedrill-coordinator-cli-")), statePath = path.join(directory, "workspace.json");
  fs.copyFileSync(path.resolve(import.meta.dirname, "../../fixtures/starter-workspace.json"), statePath);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const args = ["--import", path.resolve(import.meta.dirname, "provider-preload.js"), path.resolve(import.meta.dirname, "../src/cli.js"), "run", "--state", statePath, "--task", "Create fictional CLI evidence", "--request-id", "cli-proof", "--allow-writes", "--output-root", path.join(directory, "runs")];
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.NODE_TEST_CONTEXT;
  return { directory, statePath, args, env };
}
function cliError(stderr: string) {
  for (const line of stderr.trim().split("\n").reverse()) { try { const value = JSON.parse(line); if (typeof value.receiptPath === "string") return value; } catch { /* SDK logs are separate from the CLI's final JSON error. */ } }
  assert.fail(`Missing CLI receipt error: ${stderr.slice(-2000)}`);
}

test("actual CLI exits nonzero with durable failure evidence after a committed issue", t => {
  const f = fixture(t), result = spawnSync(process.execPath, f.args, { env: f.env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 1, result.stderr); assert.equal(result.error, undefined);
  const error = cliError(result.stderr), receipt = JSON.parse(fs.readFileSync(error.receiptPath, "utf8"));
  assert.match(error.error, /synthetic CLI outage/); assert.equal(receipt.status, "failed"); assert.equal(receipt.observations.length, 2);
  assert.equal(receipt.actions.length, 1); assert.equal(loadState(f.statePath).issues.length, 3);
  assert.equal(receipt.observations[1].sdkError.statusCode, 503); assert.equal(receipt.observations[1].sdkError.requestId, "cli-request-1");
});

test("actual CLI SIGTERM cancels a pending SDK fetch and publishes a failed receipt", async t => {
  const f = fixture(t), ready = path.join(f.directory, "ready");
  const child = spawn(process.execPath, f.args, { env: { ...f.env, FIREDRILL_TEST_PROVIDER: "wait", FIREDRILL_TEST_READY: ready }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close"); let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const start = Date.now();
  while (!fs.existsSync(ready)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() - start > 10000) assert.fail(`CLI did not reach its pending fetch: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.kill("SIGTERM");
  const [code, signal] = await closed; assert.equal(code, 1, stderr); assert.equal(signal, null);
  const error = cliError(stderr), receipt = JSON.parse(fs.readFileSync(error.receiptPath, "utf8"));
  assert.match(error.error, /interrupted/); assert.equal(receipt.status, "failed"); assert.equal(receipt.observations.length, 1);
  assert.equal(receipt.actions.length, 0); assert.equal(loadState(f.statePath).issues.length, 2);
});
