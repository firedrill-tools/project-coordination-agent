import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Workspace, loadState } from "../src/workspace.js";

const root = resolve(import.meta.dirname, "../..");

function stateCopy(seed = "starter-workspace.json") {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-"));
  const path = join(dir, "workspace.json");
  copyFileSync(join(root, "fixtures", seed), path);
  return path;
}

test("existing issue can be found in the correct repository", () => {
  const store = new Workspace(stateCopy());
  assert.equal(store.findIssues("invite", "northstar/web-app")[0]?.id, "N-101");
  assert.equal(store.findIssues("invite", "northstar/infra").length, 0);
});

test("create is idempotent and rejects unknown repositories", () => {
  const path = stateCopy();
  const store = new Workspace(path);
  assert.equal(store.createIssue("northstar/other", "New bug", "Details", "req-1").ok, false);
  const first = store.createIssue("northstar/web-app", "Sync error", "Sync fails on reconnect", "req-1");
  const second = store.createIssue("northstar/web-app", "Sync error", "Sync fails on reconnect", "req-1");
  assert.deepEqual(first, second);
  assert.equal(loadState(path).issues.length, 3);
  assert.equal(store.createIssue("northstar/web-app", "Sync error", "Different", "req-2").ok, false);
});

test("stale status write is rejected without changing state", () => {
  const path = stateCopy("stale-workspace.json");
  const store = new Workspace(path);
  assert.equal(store.updateIssue("N-101", "done", 1).ok, false);
  assert.equal(loadState(path).issues[0].status, "in_progress");
  assert.equal(store.updateIssue("N-101", "done", 3).ok, true);
  assert.equal(loadState(path).issues[0].revision, 4);
});

test("channel post uses an exact channel and one request ID", () => {
  const path = stateCopy();
  const store = new Workspace(path);
  assert.equal(store.postMessage("sales", "Update", "req-2:post").ok, false);
  assert.equal(store.postMessage("product", "Issue N-101 exists", "req-2:post").ok, true);
  assert.equal(store.postMessage("product", "Issue N-101 exists", "req-2:post").ok, true);
  assert.equal(loadState(path).posts.length, 1);
});
