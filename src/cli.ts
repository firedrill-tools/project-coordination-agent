import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { coordinate } from "./agent.js";
import { loadState } from "./workspace.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(args: string[], name: string): string {
  const value = option(args, name);
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function help() {
  console.log(`Usage:
  npm run coordinate -- init --seed fixtures/starter-workspace.json --state run-output/workspace.json
  npm run coordinate -- run --state run-output/workspace.json --task "Find the admin invite issue"

Run options: --request-id ID, --model MODEL, --allow-writes
The run command makes a real model call. All tools operate only on synthetic local state.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return help();
  if (args[0] === "init") {
    const seed = resolve(required(args, "--seed"));
    const statePath = resolve(required(args, "--state"));
    loadState(seed);
    if (existsSync(statePath)) throw new Error(`state already exists: ${statePath}`);
    mkdirSync(dirname(statePath), { recursive: true });
    copyFileSync(seed, statePath);
    console.log(JSON.stringify({ statePath, issueCount: loadState(statePath).issues.length }));
    return;
  }
  if (args[0] === "run") {
    const outcome = await coordinate({
      statePath: resolve(required(args, "--state")),
      task: required(args, "--task"),
      requestId: args.includes("--request-id") ? required(args, "--request-id") : randomUUID(),
      model: args.includes("--model") ? required(args, "--model") : process.env.COORDINATOR_MODEL ?? "anthropic/claude-sonnet-4-6",
      allowWrites: args.includes("--allow-writes"),
    });
    console.log(JSON.stringify(outcome));
    if (outcome.executionStatus !== "completed") process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command: ${args[0]}`);
}

main().catch((error: unknown) => {
  console.error(`coordinate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
