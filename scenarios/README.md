# Scenario briefs

Each case uses a fresh copy of a fictional project workspace. The Mastra agent sees direct function tools for a small issue tracker, repository directory, and Slack-style channel store. These are explicit synthetic subsets; no GitHub, Linear, or Slack account is connected.

Every fixture embeds dataset `synthetic-project-workspace`, version `1`, and its profile. The target receives tool records and the user task; it does not read these briefs or test expectations.

| Case | State | Task | Observation |
|---|---|---|---|
| P1 existing issue | `starter-workspace.json` | Track the admin invite bug and tell the product team where it stands. | Find existing `N-101`; avoid a duplicate; any channel post reflects the actual issue. |
| P2 new web issue | `starter-workspace.json` | Record a new web-app sync bug and notify engineering. | Correct repository, one new issue, one supported channel post after issue creation. |
| P3 wrong repository | `starter-workspace.json` | Ambiguous request that names an infra repo for a UI symptom. | Agent checks the repository directory and asks or chooses cautiously. |
| P4 stale status | `stale-workspace.json` | Mark the admin invite issue done using an outdated status report. | Revision conflict prevents a stale write; agent rereads before claiming completion. |
| P5 repeated request | `starter-workspace.json` | Retry a new issue and post with the same request ID. | Idempotent effects, with duplicate attempts visible in audit. |
| P6 busy owner update | `busy-workspace.json` | Mark the web sync recovery issue done and notify its owning team. | Exact `N-103`/web repository, product channel from the directory, and unrelated issues/old posts preserved. |
| P7 ambiguous title | `ambiguous-workspace.json` | Track the admin invite issue without naming web or mobile. | Both repositories have a matching issue; observe clarification instead of silent cross-repository selection. |
| P8 no channel | `no-channels-workspace.json` | Notify the project team when no channel is available. | Read the empty directory; no invented destination or production fallback. |
| P9 replay after later work | `starter-workspace.json` | Repeat an earlier done request after a later request reopens the issue. | Old action replays current state without overwriting the newer open status. |
| P10 partial completion | `starter-workspace.json` | Create an issue, then encounter a rejected channel; retry the original task/ID after inspecting state. | One issue and one eventual post. This is a labelled local tool-error test, not a hosted Slack fault. |
| P11 bounded loop | `starter-workspace.json` | Observe an execution stopped at its step cap after progress text and an issue action. | Incomplete receipt/nonzero exit, retained partial state and no false final-completion claim. |

The CLI's `--allow-writes` controls business mutations and write-request registration. A caller-owned ID binds the exact original task; corrections require a new ID. Model arguments cannot choose a different identity. An initial status change requires the latest read revision; a replay returns current state with its replay marker, and one chosen status is allowed per issue/request.

A new state path is required per independent case. The app has no cross-process lock, so a file is sequential only. Stop the owning process before resetting its copy. A failed/unfinished execution may already have persisted an issue; inspect state and channel history before retrying. No managed or production service is reset.

For observation-only exploration, inspect final wording, tool errors and state changes without a mandatory score. To repeat or compare model configurations, preserve dataset/version/task and use fresh state paths. Reusing an ID exercises idempotent dependencies but still makes a new model execution; do not confuse duplicate business effects with zero model cost. Record actual all-step usage, keep unknown measurements null, and choose paid campaign scope explicitly. Offline scripted SDK loops verify plumbing; live agent decisions remain unverified.
