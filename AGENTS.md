# Agent guide

The application entry point is `src/cli.ts`, which calls `src/agent.ts`. The Mastra agent is built with `@mastra/core/agent` and `createTool()` definitions in `src/tools.ts`. `src/workspace.ts` is the only state boundary.

- Requires Node.js 22.13+; install with `npm ci`, build with `npm run build`.
- Offline check: `npm run check`. This compiles the Mastra integration and tests cross-service state behavior without a model key.
- Normal read task: `npm run coordinate -- init --seed fixtures/starter-workspace.json --state run-output/workspace.json`; then set `ANTHROPIC_API_KEY` and run `npm run coordinate -- run --state run-output/workspace.json --task "Find the admin invite issue"`.
- Writes: add `--allow-writes` for an authorized synthetic issue update/create or channel post. `--request-id` makes retries idempotent. No production account can be used as fallback.
- Model: `COORDINATOR_MODEL` or `--model`, in Mastra's `anthropic/<model>` format.
- State/reset: fictional JSON fixtures; each case copies one to a fresh state path. State is shared across the app's issue, repository and channel tools. A path is sequential only, not safe for concurrent writers.
- Completion: `agent.generate()` returns, then the CLI rereads state and prints final JSON. A model or tool error exits nonzero if it prevents completion.
- Evidence: final answer, actual state/audit entries, issue and post counts, and reported usage if available. There is no live run evidence yet.
- Scope: narrow local operation subset, not vendor API compatibility. Keep credentials and private reports out of Git. Firedrill integration must wait for the new released contract.
