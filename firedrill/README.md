# Simulate this agent with Firedrill

Firedrill is a simulation platform for AI agents. Your coding agent can prepare
and operate these simulations; the application and its model run in your own
repository or CI.

Start in the repository root, not inside `firedrill/`:

```sh
npx firedrill-run init
```

Authorize Firedrill and select a project/environment. Installation choices are
optional; skip them when using the locked `firedrill/` toolchain below. This setup
does not invoke the target agent or grant it access to real business accounts.

The optional execution toolchain exact-pins released CLI and TypeScript SDK **2.2.2**, verified October 19, 2026. Node 22+ is required. The application retains its separately locked Mastra/Anthropic runtime and existing guarded parser repair.

## Prepare and select scope

From the repository root:

```sh
npm ci
npm run build
npm ci --prefix firedrill --ignore-scripts --no-audit --no-fund
firedrill_cli=firedrill/node_modules/@firedrill-run/cli/bin/firedrill.mjs
node "$firedrill_cli" validate firedrill/scenario.json --json --non-interactive
```

Validation is offline and allocates no batch. Authorize and select the actual project/environment with `npx firedrill-run init` in a human terminal. Automation uses `FIREDRILL_TOKEN`, `FIREDRILL_PROJECT_ID` and `FIREDRILL_ENVIRONMENT_ID` from its secret store. The application independently requires `ANTHROPIC_API_KEY` and an enabled `COORDINATOR_MODEL` or recipe `configuration.parameters.model`. Keep credentials out of recipes and source.

## Execute the actual coordinator

With an authorized provider budget:

```sh
node firedrill/simulate.mjs --preview
node "$firedrill_cli" simulate firedrill/scenario.json --scenario starter --json --non-interactive
```

The target initializes the selected hash-bound workspace and invokes the actual compiled coordinator CLI and Mastra agent. Three reviewed scenarios cover read-only inspection, an explicitly authorized synthetic issue/owner-channel update, and ambiguous repository identity. The full recipe has one repetition and concurrency one; `node firedrill/simulate.mjs` executes the same full recipe through the SDK.

`input.allowWrites` is a required literal caller boolean, separate from case identity and task text. Only true adds the existing local `--allow-writes` grant. The model cannot change that grant. Even the authorized case changes fictional JSON issues/posts only; there is no real GitHub/Slack connector or automatic production fallback. Existing current-revision and request-id protections remain in the application.

Every invocation owns a fresh private `.runs/firedrill/attempt-*` workspace and receipt directory, retained after success or failure. Earlier state is never reset by a new attempt. Outputs contain the actual CLI result under `application` and local state paths under `localState`; paths are not uploaded artifacts. Failed partial stdout/stderr retains its run directory. Completion and final prose do not establish correct business effects; inspect actual state and receipts. Local cleanup does not guarantee remote billing stopped or committed effects rolled back.

The adapter accepts current invocation `2026-10-17-target-invocation.1`, explicit task input and ID-only scenario context. It rejects controller/evaluation data and unsupported Tool bindings. Operator/CI credentials are removed before child dispatch. No Firedrill synthetic Tool is required for this local dependency seam. Existing application request/output/deadline bounds remain in effect, not billing guarantees.

## MCP, recovery and CI

Configure remote OAuth operator MCP **https://mcp.firedrill.run/mcp** using the [host-specific setup](https://docs.firedrill.run/guides/coding-agents); no local MCP package is required. Host OAuth and local CLI/SDK login are separate. MCP prepares/queues/inspects; the local execution client runs the actual application. Attach an existing batch with `node firedrill/simulate.mjs --run BATCH_ID`.

Preserve operation IDs and private journals after uncertainty. Recover with `--resume OPERATION_ID` or read retained results with `--result BATCH_ID`. A fresh simulation is new work, and a new adapter invocation gets a fresh synthetic workspace. Runner exit codes preserve pending execution/assessment, errors and optional gates. This observation-only recipe requests no grading or gate.

Ordinary CI and the source-package gate run offline checks, including the actual missing-key boundary and fresh archived integration. Use the [live CI generator](https://docs.firedrill.run/guides/ci) only after actual scope, protected credentials and budgets are configured. Authenticated persisted runs, live model quality/cost, and licensing remain separate gates.

References: [SDK](https://docs.firedrill.run/sdk/typescript), [command targets](https://docs.firedrill.run/guides/callbacks), [operator MCP](https://docs.firedrill.run/guides/control-mcp).

Before application dispatch, each private workspace saves the validated outer run/attempt/scenario IDs in `invocation.json`. This maps interrupted runs to local state; it is separate from the SDK recovery journal and grants no application authority.

## Offline verification

After installing the application dependencies and locked integration toolchain,
run `npm test --prefix firedrill` to exercise the adapter checks. These checks are
optional for first use and call no paid model. The Node 22+ requirement above is
for the Firedrill clients; it does not lower any application runtime requirement
in the root README.
