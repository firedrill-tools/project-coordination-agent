# Coordinate project work with a Mastra agent

This TypeScript application uses a Mastra agent to find existing issues, create or update issues, and post concise project updates. It works against one coherent fictional workspace containing repository metadata, an issue tracker, and Slack-style channels. Tools are direct `createTool()` functions with explicit state and error behavior; no real GitHub, issue-tracker, or Slack account is used.

## Run one task

Requires Node.js 22.13+ and an Anthropic API key for model requests:

```sh
npm ci
npm run build
npm run coordinate -- init --seed fixtures/starter-workspace.json --state run-output/workspace.json
export ANTHROPIC_API_KEY='your-key-from-a-secret-manager'
npm run coordinate -- run --state run-output/workspace.json --task "Find the admin invite issue and summarize its status"
```

The default model is `anthropic/claude-sonnet-4-6`; change it with `COORDINATOR_MODEL` or `--model`. A run makes a real model call and may incur provider cost. It prints JSON after `agent.generate()` returns, including the answer, model, reported usage if available, and state counts. The state file retains exact issue and channel effects plus an audit. There is no hidden production-service fallback.

To let the agent make synthetic changes, pass `--allow-writes`. Supply a stable `--request-id` when retrying; issue and channel operations reject reuse for a different payload. Issue updates require a current revision and reject stale writes. A duplicate title in the same repository is rejected, and channel names must be in the fixture.

## Scenarios and reset

Two fictional fixtures and five case briefs are in [scenarios/README.md](scenarios/README.md). Start each independent case with a new `run-output/` state path. Do not run concurrent writers against one file. This app offers no external service reset or broad vendor compatibility. The seed fixture is unchanged by runs.

## Offline check and CI

```sh
npm ci
npm run check
```

The offline checks compile the Mastra agent and tools, then verify duplicate prevention, repository selection, stale revisions, and channel effects in the application state. They make no model request and cannot establish live agent quality. An authorized live run and measured evidence remain pending.

## Firedrill connection and limits

The future integration seam is the CLI task, a per-case state file, JSON completion output, and the state/audit diff. Add it only against the released new Firedrill interface. No retired commands, simulated report, or CI Firedrill run is claimed here. This repository is private and unlicensed pending portfolio publication decisions.

Implementation reference: [Mastra agent and tool documentation](https://mastra.ai/docs).

Explore related applications in the [Firedrill example catalog](https://github.com/firedrill-tools/firedrill-example-catalog). Product and setup references: [Firedrill](https://firedrill.run/) and the [official developer documentation](https://docs.firedrill.run/). Use documentation matching the qualified release; this repository records its current integration limits above.
