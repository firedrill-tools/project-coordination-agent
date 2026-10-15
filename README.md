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

The default model is `anthropic/claude-sonnet-4-6`; change it with `COORDINATOR_MODEL` or `--model`. A run makes a real model call and may incur provider cost. The JSON receipt includes `executionStatus`, SDK `finishReason`, the terminal `answer`, earlier `progressText`, requested/response model identifiers, state counts and usage observations. A stopped loop with a terminal answer is `completed`; step/token limits, unfinished tool loops and empty final answers are `incomplete` and exit nonzero, even if the model emitted earlier progress text. Inspect actual state before retrying partial work. A completed execution is not a correctness score.

`usage` covers all steps only when each step has reported measurements. `lastStepUsage` is separate, `stepUsage` preserves the available SDK observations, and missing totals/cost remain null. Do not infer price or treat unreported usage as zero. The state file retains exact issue and channel effects plus an audit. There is no production-service fallback.

To let the agent make synthetic changes, pass `--allow-writes`. Supply a stable `--request-id` when retrying. The application binds it to the original task and injects operation IDs into the tools; model arguments cannot replace them. A changed task requires a new ID. One caller request can create one issue, choose one status per issue, and post one channel message. Additional intent uses a new request ID.

Issue creation and posts reject a different payload under the same ID. Status updates require a current revision for the first commit. Replays preserve the revision, return `replayed: true` and current issue state, and cannot undo a later request's changes. Titles are normalized for case/whitespace duplicate checks within the exact repository. The directory exposes owner teams and supported channels; the model can inspect recent channel posts when checking an earlier notification.

| Tool | Local supported operation |
|---|---|
| `listRepositories` | Exact slugs, descriptions, owner teams, repository channels and available channels |
| `findIssues` | Title/body search, optionally scoped to an exact repository |
| `readChannel` | Last 20 posts for an exact supported channel; no pagination |
| `createIssue` | One caller-bound issue creation with normalized-title duplicate checks |
| `updateIssue` | Revision-checked status update with replay/current-state evidence |
| `postMessage` | One caller-bound post in an available channel |

Without `--allow-writes`, write tools reject changes and no write-request journal entry is created. With authorization, task bindings survive model failure so a retry can retain its identity. Tools reload state per operation; this is a sequential local store, with no cross-process transaction lock. Saves flush a temporary file before replacement and clean up the staged file.

## Scenarios and reset

Five fictional fixtures embed dataset `synthetic-project-workspace`, version `1`: starter, stale revision, busy ordinary, ambiguous cross-repository titles and no available channels. The busy profile has three repositories, six issues and earlier owner-team posts. See [scenarios/README.md](scenarios/README.md) for case inputs and their profile. Start each independent case with a new `run-output/` state path; `init` refuses to overwrite it. Stop the owning CLI process before deleting/replacing its copy. No external service is reset, and the committed seed is unchanged by runs.

## Offline check and CI

```sh
npm ci
npm run check
```

The original scripted checks include an actual Mastra `generate()` loop with the SDK's scripted model, actual tool execution and persisted state effects. They verify caller-owned IDs, read-only behavior, status replay after later work, partial recovery, busy/ambiguous data, all-step versus last-step usage, missing measurements, incomplete loops and empty terminal answers. Scripted token values exercise serialization; they are not live provider usage or a benchmark. An authorized live Claude run and measured evidence remain pending. Direct dependencies are Mastra `1.77.0` and Zod `4.6.7`, resolved in `package-lock.json`.

The scoped argparse override removes the inherited `sprintf-js` dependency while preserving Mastra's YAML front-matter and CLI contracts. A guarded install-time repair retains the legacy CLI version option. See [scripts/README.md](scripts/README.md) for the exact compatibility change and removal criteria. The dependency follow-up qualified fresh `npm ci`, 22 checks and `npm audit` (zero findings at the 2026-10-15 snapshot).

## Native completion follow-up

The current 31-check suite adds nine cases through the actual Mastra model router and bundled Anthropic HTTP adapter, with controlled fetch responses and synthetic keys. A native `max_tokens` response containing `createIssue` previously created an issue even though the overall loop was incomplete. The first attempted output-processor guard also allowed the issue to be created: this pinned pipeline can execute tool chunks before that processor aborts.

`src/completion.ts` now holds each native model response until its finish is validated, before any chunks reach tool execution. It preserves accepted native chunks/metadata and rejects truncated, inconsistent, parallel and empty responses. The pinned router exposes v2 while its bundled adapter emits v3 unified/raw finish metadata; both the normalized reason and original pair are retained. Native stream evidence is bounded to 1 MiB/8,192 chunks. The six native cases verify a completed tool plus final answer, max-tokens tool/final output, inconsistent end-turn tool calls, parallel calls and blank output. They use the normal model-router path and actual local tools, without a fake agent or model class. No provider request leaves the process.

`modelStepObservations` keeps SDK text/tool/finish/usage observations, including rejected output. Callable errors retain `observations`, including available SDK error status/body/request IDs; earlier authorized effects remain committed if a later answer is rejected. Incomplete receipts have an empty terminal answer and keep available progress separately. These SDK observations are distinct from byte-level provider evidence; missing/normalized usage and cost require the remaining transport qualification. The native budget follow-up configures 8 steps, 4,096 output tokens, 30 seconds per model call and 240 seconds per run, with caller cancellation and CLI signal handling. A failure probe exposed three attempts after a 503 despite zero model retries: Mastra's separate default stability processors also resubmit calls. `errorProcessorDefaults:false` plus zero model/processor retry budgets disables those paths through public configuration. Native checks verify exactly one failed attempt after a committed issue, retention of original SDK error/body/request ID, caller cancellation and a step deadline aborting the actual fetch signal. The SDK error object is preserved without a vendor patch or custom exception workaround.

Durable failed-run reports, full raw-usage provenance, hash-bound initialization and a locked package outside checkout remain unqualified. Those tasks remain next, followed by a selected live model/Firedrill proof. No live judgment or benchmark is inferred from controlled choices.

## Firedrill connection and limits

The future integration seam is the CLI task, a per-case state file, JSON completion output, and the state/audit diff. Add it only against the released new Firedrill interface. No retired commands, simulated report, or CI Firedrill run is claimed here. This repository is private and unlicensed pending portfolio publication decisions.

Implementation reference: [Mastra agent and tool documentation](https://mastra.ai/docs).

Explore related applications in the [Firedrill example catalog](https://github.com/firedrill-tools/firedrill-example-catalog). Product and setup references: [Firedrill](https://firedrill.run/) and the [official developer documentation](https://docs.firedrill.run/). Use documentation matching the qualified release; this repository records its current integration limits above.
