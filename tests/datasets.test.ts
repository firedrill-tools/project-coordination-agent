import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initializeCase, listCases } from "../src/datasets.js";
import { loadState, Workspace } from "../src/workspace.js";
import { sha256 } from "../src/evidence.js";

function temporary(t: import("node:test").TestContext) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "firedrill-coordinator-datasets-")); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; }
test("eight hash-bound cases/four profiles initialize exact private independent copies", t => {
  const directory = temporary(t), index = listCases();
  assert.equal(index.cases.length, 8); assert.deepEqual(new Set(index.cases.map(item => item.profile)), new Set(["starter", "busy", "ambiguous", "boundary"]));
  for (const item of index.cases) {
    const file = path.join(directory, `${item.id}.json`), selected = initializeCase(item.id, file);
    assert.equal(sha256(fs.readFileSync(file)), item.sha256); assert.equal(selected.sha256, item.sha256); assert.equal(selected.manifestSha256, index.manifestSha256);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(loadState(file).dataset?.caseId, item.id);
    assert.throws(() => initializeCase(item.id, file), /EEXIST/);
  }
  assert.throws(() => initializeCase("../starter", path.join(directory, "bad.json")), /Unknown/);
});

test("busy prior handoffs, ambiguous identities and unavailable channels are coherent", t => {
  const directory = temporary(t), file = path.join(directory, "busy.json"); initializeCase("busy", file);
  const state = loadState(file); assert.equal(state.issues.length, 18); assert.equal(state.posts.length, 12); assert.equal(state.requests?.length, 10);
  for (const update of state.updates ?? []) {
    const issue = state.issues.find(issue => issue.id === update.issueId)!;
    assert.equal(issue.status, update.status); assert.ok(state.requests?.some(request => request.id === update.requestId));
    const post = state.posts.find(post => post.requestId === `${update.requestId}:post`)!;
    assert.equal(post.channel, state.repositories.find(repo => repo.slug === issue.repository)?.channel); assert.match(post.text, new RegExp(issue.id));
  }
  assert.equal(new Workspace(file).postMessage("product", "A later update", "next:post").ok, true); assert.equal(loadState(file).posts.at(-1)?.id, "post-18");
  const ambiguous = path.join(directory, "ambiguous.json"); initializeCase("ambiguous-owner", ambiguous);
  assert.equal(new Workspace(ambiguous).findIssues("admin invite").length, 2);
  const unavailable = path.join(directory, "unavailable.json"); initializeCase("unavailable-channel", unavailable);
  assert.deepEqual(loadState(unavailable).channels, []); assert.equal(new Workspace(unavailable).postMessage("product", "No invented destination", "no:post").ok, false);
});

test("copied bundle drift and identity tampering fail before initialization", t => {
  const directory = temporary(t), project = path.resolve(import.meta.dirname, "../..");
  fs.cpSync(path.join(project, "dist/src"), path.join(directory, "dist/src"), { recursive: true });
  fs.cpSync(path.join(project, "datasets"), path.join(directory, "datasets"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  // Unit fixture uses the already locked dependencies; the separate archive gate
  // performs its own installation outside the checkout.
  fs.symlinkSync(path.join(project, "node_modules"), path.join(directory, "node_modules"), "dir");
  const file = path.join(directory, "datasets/cases/starter.json"), before = fs.readFileSync(file);
  fs.appendFileSync(file, "\n");
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
  const run = () => spawnSync(process.execPath, ["dist/src/cli.js", "init", "--case", "starter", "--state", "state.json"], { cwd: directory, env, encoding: "utf8" });
  let result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /hash mismatch/); assert.equal(fs.existsSync(path.join(directory, "state.json")), false);
  const state = JSON.parse(before.toString("utf8")); state.dataset.caseId = "wrong-case"; const bytes = JSON.stringify(state); fs.writeFileSync(file, bytes);
  const manifestFile = path.join(directory, "datasets/manifest.json"), index = JSON.parse(fs.readFileSync(manifestFile, "utf8")); index.cases[0].sha256 = sha256(bytes); fs.writeFileSync(manifestFile, JSON.stringify(index));
  result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /identity mismatch/); assert.equal(fs.existsSync(path.join(directory, "state.json")), false);
});

test("CLI list/init/legacy init need no key and reject overwrite and ambiguous flags", t => {
  const directory = temporary(t), env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
  const cli = path.resolve(import.meta.dirname, "../src/cli.js");
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: directory, env, encoding: "utf8", timeout: 10000 });
  assert.equal(run(["list"]).status, 0); assert.equal(run(["init", "--case", "starter", "--state", "workspace.json"]).status, 0);
  assert.equal(run(["init", "--case", "starter", "--state", "workspace.json"]).status, 1);
  assert.equal(run(["init", "--case", "starter", "--seed", "unused.json", "--state", "new.json"]).status, 1);
  assert.equal(run(["run", "--state", "workspace.json", "--task", "Inspect", "--request-id", "one", "--request-id", "two"]).status, 1);
  assert.equal(run(["run", "--state", "workspace.json", "--task", "Inspect", "--unknown"]).status, 1);
  const seed = path.resolve(import.meta.dirname, "../../fixtures/starter-workspace.json");
  assert.equal(run(["init", "--seed", seed, "--state", "legacy.json"]).status, 0); assert.equal(fs.statSync(path.join(directory, "legacy.json")).mode & 0o777, 0o600);
});
