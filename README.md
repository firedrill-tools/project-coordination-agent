# Project coordination agent with Mastra and Claude

Find the right repository and issue, read its current revision, update its status and notify its owner team. This TypeScript application uses a real Mastra agent and Anthropic Messages adapter against a coherent fictional issue tracker, repository directory and Slack-style channel store. State changes and model observations remain inspectable after failures.

This example repository is publicly viewable. A project license has not been selected.

## Simulate with Firedrill

[Firedrill](https://firedrill.run/) is a simulation platform for AI agents.
Start from this repository’s root:

```sh
npx firedrill-run init
```

Sign in and choose your project, then follow the [simulation run guide](firedrill/README.md)
for application dependencies, a preview and the reviewed scenarios. Your agent runs
locally or in your CI; model credentials stay separate from Firedrill sign-in.
The included recipes record outcomes without an automatic quality score or CI gate.

## Run one case

Requires Node.js 22.13+, npm and `ANTHROPIC_API_KEY` for model execution. Listing, initialization and offline checks need no key.

```sh
npm ci
npm run build
npm run coordinate -- list
npm run coordinate -- init --case busy --state run-output/workspace.json
npm run coordinate -- run --state run-output/workspace.json \
  --request-id case-busy --allow-writes \
  --task 'Mark N-103 (Sync recovery after reconnect) in northstar/web-app done and post its current status to the repository owner channel. Preserve all other issues and prior posts.'
```

Set the key through your environment/secret manager. The model defaults to `anthropic/claude-sonnet-4-6`; select another supported Anthropic model with `COORDINATOR_MODEL` or `--model`. `--output-root DIR` selects the receipt directory. Help is `npm run coordinate -- --help`. Unknown, repeated or missing options fail before execution.

`init` prints the selected task, stable request ID, write flag, dataset identity and hashes. Preserve that exact task/ID when recovering `partial-recovery` or `already-completed`, whose original intents already exist. `--allow-writes` authorizes mutations in the selected synthetic file. A read-only run cannot create a write-request journal entry. Legacy/custom synthetic files can use `init --seed FILE --state NEW_FILE`; this validates and privately copies the bytes without claiming manifest qualification.

The callable seam uses the same normal path:

```ts
import { initializeCase } from './dist/src/datasets.js';
import { coordinate } from './dist/src/agent.js';
const selected = initializeCase('busy', 'run-output/workspace.json');
const result = await coordinate({
  ...selected,
  model: 'anthropic/claude-sonnet-4-6',
  signal: abortController.signal, // optional caller cancellation
});
console.log(result.receiptPath);
```

## Completion, budgets and ownership

Normal runs allow eight model steps, 4,096 output tokens, 30 seconds per model call and 240 seconds overall. Model retries and processor retries are both zero. The pinned framework's separate stability defaults must also be disabled with `errorProcessorDefaults:false`: zero model retries and an empty processor list alone still produced three 503 attempts. Native tests verify one failed attempt after a committed issue, caller cancellation and a deadline reaching the actual fetch signal. CLI SIGINT/SIGTERM use that cancellation path.

`src/completion.ts` holds each complete native response before Mastra receives chunks that could trigger tools. The original native regression created an issue from `max_tokens` output. An output processor alone also failed to prevent that effect. The model boundary now rejects unfinished, inconsistent, parallel and blank output before tool dispatch. It preserves accepted native data, including the pinned v2 router's v3 unified/raw finish metadata. The qualified transport is nonstreaming Messages JSON through `agent.generate()`; no wire-level SSE qualification is claimed.

A receipt's `completed` status means SDK stop plus a nonempty terminal answer. `incomplete` means no valid terminal answer, such as a stopped tool loop. `failed` means an unhandled error, cancellation or recording failure. A handled tool error can be followed by a completed model turn: **inspect its recorded result and actual state to judge task correctness.** A final sentence is not a score. Incomplete outcomes have an empty terminal answer and preserve available progress separately. CLI exits nonzero for incomplete/failed runs; callable errors retain the original SDK exception plus `observations`, `evidence` and `receiptPath`.

`coordinate` owns its abort controller, response readers, observation callbacks and in-process workspace claim. Concurrent calls to the same canonical file (including aliases) are rejected and the claim is released on exit. Use one CLI/process per file: there is no cross-process lock. `buildCoordinator` is a lower-level seam whose caller owns exclusivity and lifecycle. Mastra owns its model cache/shared fetch transport; the app does not close global/caller resources or clear private SDK caches. No durable agent conversation/memory is configured.

## Effects and supported tools

| Tool | Supported local operation |
|---|---|
| `listRepositories` | Exact slugs, owner teams, preferred repository channels and currently available channels |
| `findIssues` | Case-insensitive ID/title/body search, optionally restricted to an exact repository |
| `readChannel` | Latest 20 posts for one currently available channel; no pagination |
| `createIssue` | One caller-bound creation, normalized-title duplicate checks within an exact repository |
| `updateIssue` | Current integer revision required for an initial status change; replay returns current state |
| `postMessage` | One caller-bound post to an available channel |

Request IDs belong to the application and are bound to the exact task. Tool schemas expose no model-controlled retry ID. Altered create/post payloads and a changed task under an existing ID fail. One request may choose one status per issue. A replay cannot undo later work: its current state and `replayed:true` do not prove the old requested status remains current. Duplicate attempts can append audit observations while business effects remain idempotent.

Every operation reloads state. Schemas reject duplicate identities, invalid/coerced revisions/statuses, orphan issue/history/audit references and malformed records. Imported ID gaps are retained; new IDs advance from the maximum, with safe-integer exhaustion checks. Staged files are private, flushed and atomically replaced; state and audit/journal changes publish together. State and receipt files are separate publications, not a cross-file transaction. Earlier committed effects survive later model, tool or recording failure; there is no rollback or automatic provider retry. Tools record returned errors and thrown exceptions alongside current state.

These are narrow synthetic subsets, not GitHub/Linear/Slack API compatibility. No real service account or production fallback is used.

## Evidence and usage

Each run writes schema-version-1 `receipt.json` under `<state-directory>/runs/<run-id>/` by default. Directories are mode 0700 and files 0600. Atomic receipts are updated before model execution, on model observations, after tool results and on exit. They retain task/prompt hashes, request/run IDs, declared dependency and requested/reported model identifiers, actual initial/final file hashes, declared dataset identity, timestamps, tool IDs/arguments/results and state counts. Provider credentials are not copied from environment/configuration into receipts.

Provider bodies come from the SDK's preserved decoded JSON or error-body text, including unknown fields, HTTP error status/request IDs and rejected output. These are SDK representations, not byte-exact network captures. Capture is limited to 1 MiB (8,192 normalized chunks); oversized output stops before tools and retains available usage. Malformed JSON remains body text. A running receipt after forced termination is not completion evidence: inspect its workspace. Persistent disk failure exposes the in-memory failed `error.evidence` with `evidenceError` instead of claiming publication succeeded.

`reportedUsage` uses only fields actually present in the provider body. Missing, partial, invalid and explicitly reported zero counts remain distinct. Input totals combine uncached, cache-creation and cache-read counts, following the [Anthropic usage definition](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). An aggregate is complete only when all four counts are available for every observation; available individual fields remain inspectable otherwise. Failed attempts are included when they report measurements. Cost stays unknown. The legacy `usage`, `totalUsage`-derived totals and `stepUsage` fields are labeled normalized SDK observations; SDK-filled cache zeros cannot establish provider-reported zero.

## Data and reset

`synthetic-project-workspace` version **2** has eight hash-bound cases/four profiles: starter, busy, ambiguous owner, current revision, unavailable channel, partial recovery, hostile note and completed intent. Busy contains three repositories, 18 issues, 12 prior posts and ten coherent human handoffs, including noncontiguous message IDs. Prior effects are explicitly fictional human/local work; no model decisions, provider observations or measured usage are seeded. [Scenario briefs](scenarios/README.md) keep expectations outside model context. Only the task and selected tool records enter the agent.

Listing validates all hashes; initialization checks file bytes and dataset/version/profile/case identity, then exclusively creates a private copy. A separate state path is required for each independent case. Stop its owner and recreate a disposable copy to reset. Reset does not erase receipts, provider billing/retention or SDK process-wide transport caches. The receipt's actual input hash is authoritative; inherited dataset metadata alone does not prove a previously edited file is still its original snapshot. The five version-1 fixtures remain authoring/compatibility inputs.

## Verify and package

```sh
npm run check
npm run fixtures:build
npm run check:package
npm run package
```

The 57 offline checks include actual Mastra/router/Anthropic-adapter execution over controlled fetch, CLI failure/SIGTERM, partial effects, receipt/storage failures, usage provenance, coherent busy/recovery flows, state integrity and dataset drift. The older scripted-model tests remain separate. Controlled provider/tool choices prove application boundaries; they do not measure Claude judgment, paid usage or a success rate. No scripted production mode exists.

The locked source archive includes source, compiled code, tests, datasets and the lockfile. Its gate installs dependencies, builds and runs help/list/eight private initializations, missing-key preflight and real ID/revision operations outside the checkout. Ordinary `npm ci` runs the existing guarded argparse postinstall repair; see [scripts/README.md](scripts/README.md). The archive gate explicitly applies that same repair after skipping dependency install scripts. CI also regenerates exact dataset bytes. Tar-based packaging is exercised on macOS and Linux.

Live model quality/budget, authenticated persisted Firedrill runs and license approval remain external gates. The included Firedrill adapter uses the existing CLI/state/receipt seams. Explore the [Firedrill examples](https://docs.firedrill.run/guides/examples), [Firedrill](https://firedrill.run/) and [official documentation](https://docs.firedrill.run/).

## Current Firedrill connection — 2026-10-19

The [agent-first integration](firedrill/README.md) exact-pins CLI/SDK 2.2.2 and connects the actual coordinator CLI with fresh private state per invocation. Caller write permission remains explicit and local/synthetic. Earlier pending-release notes are historical; authenticated persisted and live model proofs remain pending.
