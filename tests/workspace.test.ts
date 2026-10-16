import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Workspace, loadState, validateState } from "../src/workspace.js";

const owned = new Set<string>();
afterEach(() => { for (const directory of owned) rmSync(directory, { recursive: true, force: true }); owned.clear(); });
const root = resolve(import.meta.dirname, "../..");

function stateCopy(seed = "starter-workspace.json") {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-"));
  owned.add(dir);
  const path = join(dir, "workspace.json");
  copyFileSync(join(root, "fixtures", seed), path);
  return path;
}

test("existing issue can be found in the correct repository", () => {
  const store = new Workspace(stateCopy());
  assert.equal(store.findIssues("invite", "northstar/web-app")[0]?.id, "N-101");
  assert.equal(store.findIssues("invite", "northstar/infra").length, 0);
  assert.equal(store.findIssues("n-101", "northstar/web-app")[0]?.id, "N-101");
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
  assert.equal(store.updateIssue("N-101", "done", 1, "update-1").ok, false);
  assert.equal(loadState(path).issues[0].status, "in_progress");
  assert.equal(store.updateIssue("N-101", "done", 3, "update-1").ok, true);
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

test("repeating the same status does not advance the issue revision twice", () => {
  const path = stateCopy(); const store = new Workspace(path);
  assert.equal(store.updateIssue("N-101", "done", 1, "retry-1").ok, true);
  assert.equal(store.updateIssue("N-101", "done", 2, "retry-1").ok, true);
  assert.equal(loadState(path).issues[0].revision, 2);
});


test("post allocation preserves noncontiguous historical IDs without collisions", () => {
  const file = stateCopy("busy-workspace.json"), state = loadState(file);
  state.posts[1].id = "post-3"; state.audit[1].target = "post-3"; writeFileSync(file, JSON.stringify(state));
  const result = new Workspace(file).postMessage("product", "Fictional next post", "gap:post");
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.data.id, "post-4");
  assert.deepEqual(loadState(file).posts.map(post => post.id), ["post-1", "post-3", "post-4"]);
});

test("schema rejects duplicate identities, invalid revisions and orphan histories", () => {
  const file = stateCopy("busy-workspace.json"), original = loadState(file);
  const mutations: ((state: typeof original) => void)[] = [
    state => { state.issues[1].id = state.issues[0].id; },
    state => { state.posts[1].requestId = state.posts[0].requestId; },
    state => { state.repositories.push(state.repositories[0]); },
    state => { state.issues[0].revision = 1.5; },
    state => { state.issues[0].revision = true as never; },
    state => { state.issues[0].status = "archived" as never; },
    state => { state.issues[0].repository = "missing/repository"; },
    state => { state.audit[0].target = "post-999"; },
    state => { state.updates = [{ requestId: "orphan", issueId: "N-999", status: "done" }]; },
  ];
  for (const mutate of mutations) { const state = structuredClone(original); mutate(state); assert.throws(() => validateState(state)); }
  assert.deepEqual(loadState(file), original);
});

test("direct write API rejects coerced revisions/statuses and exhaustion without mutation", () => {
  const file = stateCopy(), store = new Workspace(file), before = readFileSync(file, "utf8");
  for (const revision of [true, 1.5, "1", 0, Number.NaN]) assert.equal(store.updateIssue("N-101", "done", revision as number, "bad").ok, false);
  assert.equal(store.updateIssue("N-101", "archived" as never, 1, "bad").ok, false);
  assert.equal(store.postMessage("product", "test", "").ok, false);
  assert.equal(readFileSync(file, "utf8"), before);
  const state = loadState(file); state.issues[0].revision = Number.MAX_SAFE_INTEGER; writeFileSync(file, JSON.stringify(state));
  assert.equal(store.updateIssue("N-101", "done", Number.MAX_SAFE_INTEGER, "exhausted").ok, false);
  const posts = loadState(file); posts.posts = [{ id: `post-${Number.MAX_SAFE_INTEGER}`, channel: "product", text: "Imported history", requestId: "imported:post" }]; writeFileSync(file, JSON.stringify(posts));
  assert.equal(store.postMessage("product", "new", "new:post").ok, false);
});

test("private atomic state publication cleans staging and preserves old state on rename failure", async () => {
  const fs = await import("node:fs"), { syncBuiltinESMExports } = await import("node:module");
  const file = stateCopy(), before = readFileSync(file, "utf8"), rename = fs.default.renameSync;
  try {
    fs.default.renameSync = () => { throw new Error("synthetic state publication failure"); }; syncBuiltinESMExports();
    assert.throws(() => new Workspace(file).createIssue("northstar/web-app", "New issue", "Fictional body", "atomic"), /publication/);
  } finally { fs.default.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(readFileSync(file, "utf8"), before); assert.deepEqual(readdirSync(resolve(file, "..")), ["workspace.json"]);
});
