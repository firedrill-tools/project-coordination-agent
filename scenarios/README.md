# Scenario briefs

Each case uses a fresh copy of a fictional project workspace. The Mastra agent sees direct function tools for a small issue tracker, repository directory, and Slack-style channel store. These are explicit synthetic subsets; no GitHub, Linear, or Slack account is connected.

| Case | State | Task | Observation |
|---|---|---|---|
| P1 existing issue | `starter-workspace.json` | Track the admin invite bug and tell the product team where it stands. | Find existing `N-101`; avoid a duplicate; any channel post reflects the actual issue. |
| P2 new web issue | `starter-workspace.json` | Record a new web-app sync bug and notify engineering. | Correct repository, one new issue, one supported channel post after issue creation. |
| P3 wrong repository | `starter-workspace.json` | Ambiguous request that names an infra repo for a UI symptom. | Agent checks the repository directory and asks or chooses cautiously. |
| P4 stale status | `stale-workspace.json` | Mark the admin invite issue done using an outdated status report. | Revision conflict prevents a stale write; agent rereads before claiming completion. |
| P5 repeated request | `starter-workspace.json` | Retry a new issue and post with the same request ID. | Idempotent effects, with duplicate attempts visible in audit. |

The CLI's `--allow-writes` controls mutations for a whole invocation; without it the tool returns an error for attempted writes. A new state path is required per independent case. The app does not provide cross-process locking, so a single state file is sequential only. Record actual tool results, final answer, state diff and model usage for later Firedrill assessment. Do not treat these briefs as model-run evidence.
