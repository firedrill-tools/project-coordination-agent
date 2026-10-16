import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { coordinate } from "./agent.js";
import { validateState } from "./workspace.js";
import { initializeCase, listCases } from "./datasets.js";

function help() {
  console.log(`Usage:
  npm run coordinate -- list
  npm run coordinate -- init --case starter --state run-output/workspace.json
  npm run coordinate -- init --seed fixtures/starter-workspace.json --state run-output/legacy.json
  npm run coordinate -- run --state run-output/workspace.json --task "Find the admin invite issue"

Run options: --request-id ID, --model MODEL, --allow-writes, --output-root DIR
Only run makes a real model call. Init copies a private, exclusive local workspace; stop its owner before resetting.`);
}
function parse(args: string[], allowed: Set<string>) {
  const values = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key) || values.has(key)) throw new Error(`unknown or repeated option: ${key}`);
    if (key === "--allow-writes") { values.set(key, true); continue; }
    const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`${key} is required`);
    values.set(key, value);
  }
  return values;
}
function required(values: Map<string, string | true>, name: string) {
  const value = values.get(name); if (typeof value !== "string") throw new Error(`${name} is required`); return value;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || (["--help", "-h"].includes(command) && args.length === 0)) return help();
  if (command === "list") { if (args.length) throw new Error("list takes no options"); console.log(JSON.stringify(listCases(), null, 2)); return; }
  if (command === "init") {
    const values = parse(args, new Set(["--seed", "--case", "--state"])), statePath = resolve(required(values, "--state"));
    if (values.has("--seed") === values.has("--case")) throw new Error("choose exactly one --case or --seed");
    if (values.has("--case")) console.log(JSON.stringify(initializeCase(required(values, "--case"), statePath)));
    else {
      const bytes = readFileSync(resolve(required(values, "--seed"))); validateState(JSON.parse(bytes.toString("utf8")));
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 }); writeFileSync(statePath, bytes, { flag: "wx", mode: 0o600, flush: true });
      console.log(JSON.stringify({ statePath }));
    }
    return;
  }
  if (command === "run") {
    const values = parse(args, new Set(["--state", "--task", "--request-id", "--model", "--allow-writes", "--output-root"]));
    const controller = new AbortController(), stop = () => controller.abort(new Error("coordinate interrupted"));
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try {
      const outcome = await coordinate({ signal: controller.signal, statePath: resolve(required(values, "--state")), task: required(values, "--task"),
        requestId: values.has("--request-id") ? required(values, "--request-id") : randomUUID(),
        model: values.has("--model") ? required(values, "--model") : process.env.COORDINATOR_MODEL ?? "anthropic/claude-sonnet-4-6",
        allowWrites: values.has("--allow-writes"), outputRoot: values.has("--output-root") ? resolve(required(values, "--output-root")) : undefined });
      console.log(JSON.stringify(outcome)); if (outcome.executionStatus !== "completed") process.exitCode = 1;
    } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    return;
  }
  throw new Error(`unknown command: ${command}`);
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), receiptPath: error instanceof Error ? Reflect.get(error, "receiptPath") ?? null : null }));
  process.exitCode = 1;
});
