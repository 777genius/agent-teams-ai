# Subscription Runtime

Provider-neutral TypeScript runtime for running subscription-backed AI agents
from backend services, CI jobs, local worker pools and controlled project
workflows.

The package keeps provider execution, session custody, refresh, capacity,
concurrency, durable run state, redaction and recovery behind stable contracts.
Codex is the most complete provider integration. Claude provider and worker
surfaces use the same runtime boundaries.

`subscription-runtime` is an execution and safety kernel, not an autonomous
orchestrator. It can report facts, enforce admission rules and execute brokered
operations. A host application still decides what work matters, which roles to
run, how to prioritize a backlog and when a workflow is complete.

## What It Provides

- provider-neutral session, task, result and event contracts;
- Codex and Claude provider adapters;
- bounded, capacity-aware backend worker pools;
- encrypted local session custody with generation-aware writeback;
- account identity, quota, cooldown and reconnect diagnostics;
- safe execution, workspace isolation and command policy;
- durable worker control inboxes, run events and read models;
- brokered project-control admission, handoff, review, recovery and integration;
- provider-neutral agent-task request/result/event protocol;
- optional in-memory and BullMQ queue adapters;
- an OpenAI-compatible Codex bridge;
- GitHub Actions no-plaintext secret writeback and runner adapters;
- contract fakes and adapter certification helpers.

## Responsibility Boundary

The runtime owns execution mechanics and project-neutral safety:

- provider session validation, refresh and failure classification;
- encrypted custody, leases, fencing, idempotency and stale-generation checks;
- account capacity facts and safe account reservation;
- bounded worker lifecycle, cancellation, timeouts and recovery;
- normalized run events, snapshots and sanitized diagnostics;
- isolated workspaces, immutable handoff artifacts and reviewed integration;
- brokered `codex_goal_project_*` operations and durable operation recovery.

The host or orchestrator owns strategy:

- project and task selection;
- producer, reviewer or verifier mix;
- backlog priority and benchmark policy;
- autonomous coordination and completion decisions;
- product-specific retry, escalation and approval policy.

Runtime adapters report facts and enforce safety decisions. They must not hide
orchestrator policy inside filesystem, queue, provider, CLI or MCP code.

## Requirements

- Node.js 20 or newer;
- a GitHub Packages token with package read access;
- the provider CLI and an authenticated provider session for provider-specific
  execution;
- `claude-runtime` installed alongside the consumer when using the default
  `worker-claude` execution engine;
- a base64 or base64url encoded 32-byte key when using encrypted local custody.

Never commit package tokens, provider `auth.json`, cookies or decrypted session
artifacts.

## Install

Configure the `@vioxen` scope for GitHub Packages:

```ini
@vioxen:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then install the published package:

```bash
npm install @vioxen/subscription-runtime
```

Production consumers should commit their lockfile so deployments use the exact
artifact that was reviewed. Published versions and release notes are available
in [GitHub Releases](https://github.com/vioxen/subscription-runtime/releases).
See [Package Consumption](docs/package-consumption.md) for CI authentication
and update guidance.

## Public Package Surface

Prefer subpath imports. They make adapter boundaries visible and are verified
by the packed-consumer gate.

| Subpath | Responsibility |
| --- | --- |
| `@vioxen/subscription-runtime/core` | Provider-neutral runtime policy, session lifecycle, task/result contracts, redaction and ports |
| `@vioxen/subscription-runtime/agent-task` | Versioned agent-task codec, bridge, streaming events and handler contract |
| `@vioxen/subscription-runtime/account-diagnostics` | Provider-neutral account identity, availability, reset and capacity read models |
| `@vioxen/subscription-runtime/provider-codex` | Codex auth, CLI/app-server execution, model catalog, failure classification and materialization |
| `@vioxen/subscription-runtime/provider-claude` | Claude session, provider driver and task execution adapters |
| `@vioxen/subscription-runtime/openai-compatible-codex` | OpenAI-compatible chat-completions bridge backed by Codex accounts |
| `@vioxen/subscription-runtime/worker-core` | Worker pools, access control, capacity selection, control, integration, run events and safe execution |
| `@vioxen/subscription-runtime/worker-codex` | File-backed Codex worker, goal runtime, MCP/project-control surface and observations |
| `@vioxen/subscription-runtime/worker-claude` | File-backed Claude worker, observations, telemetry and thread handoff |
| `@vioxen/subscription-runtime/worker-local` | Local process, workspace, integration, event publisher and control adapters |
| `@vioxen/subscription-runtime/queue-core` | Queue contracts, validation, in-memory queue and processor lifecycle |
| `@vioxen/subscription-runtime/queue-bullmq` | BullMQ queue and processor adapters |
| `@vioxen/subscription-runtime/store-local-file` | Encrypted session store, leases, account capacity, inbox, integration and run-event stores |
| `@vioxen/subscription-runtime/store-github-actions-secret` | GitHub encrypted secret writeback with a no-plaintext boundary |
| `@vioxen/subscription-runtime/runner-github-action` | Safe GitHub Actions process runner and capabilities |
| `@vioxen/subscription-runtime/testing`, `@vioxen/subscription-runtime/testing/fakes`, `@vioxen/subscription-runtime/testing/contracts` | Runtime fakes and contract helpers |

The root import exposes namespace groups, but subpaths are the stable choice for
application code:

```ts
import { createSubscriptionRuntime } from "@vioxen/subscription-runtime/core";
import { FileBackendCodexWorker } from "@vioxen/subscription-runtime/worker-codex";
import { BoundedSubscriptionWorkerPool } from "@vioxen/subscription-runtime/worker-core";
```

## Minimal Codex Worker

This example uses one authenticated Codex account and encrypted local state. It
is intended for a backend or a disposable integration project, not as a project
orchestration policy.

```ts
import { FileBackendCodexWorker } from "@vioxen/subscription-runtime/worker-codex";

const worker = new FileBackendCodexWorker({
  workerId: "codex-main",
  providerInstanceId: "codex-main",
  stateRootDir: "/var/lib/subscription-runtime",
  codexBinaryPath: "codex",
  encryptionKey: process.env.SUBSCRIPTION_RUNTIME_FILE_KEY!,
  model: process.env.CODEX_MODEL ?? "gpt-5.6-sol",
  reasoningEffort: "xhigh",
});

await worker.seedCodexAuthJsonFile(process.env.CODEX_AUTH_JSON_PATH!);
await worker.start();

try {
  const result = await worker.run({
    prompt: "Return a compact JSON readiness assessment.",
  });
  console.log(result.outputText);
} finally {
  await worker.dispose();
}
```

The durable state directory stores encrypted records. The provider auth file is
an explicit bootstrap source and must remain outside version control.

Treat model IDs as exact provider identifiers. For GPT-5.6 Sol use
`gpt-5.6-sol`, not `gpt-5.6`, and verify availability through the active
account's Codex app-server `model/list` catalog. GPT-5.6 Sol requires Codex CLI
`0.144.0` or newer.

For pools, account rotation and deployment guidance, see
[Backend Workers](docs/backend-workers.md), [Codex Auth](docs/codex-auth.md) and
[Codex Worker Pool Operations](docs/codex-worker-pool-operations.md).

## Account Diagnostics

Inspect safe account and capacity facts without launching a provider task:

```bash
subscription-runtime-account-status --provider all --json
subscription-runtime-account-status --provider codex --only reconnect_required
```

Provider probes are opt-in because they can spend provider capacity. See
[Account Diagnostics](docs/account-diagnostics.md) and
[Agent Account Observability](docs/agent-account-observability.md).

## Command-Line And MCP Surfaces

The package publishes these executables:

| Executable | Purpose |
| --- | --- |
| `subscription-runtime-account-status` | Safe account, auth and capacity diagnostics |
| `subscription-runtime-agent-task` | Run a versioned agent-task request through a handler module |
| `subscription-runtime-run-agent-task` | Execute an agent-task request through configured subscription workers |
| `subscription-runtime-openai-codex-bridge` | Serve an OpenAI-compatible Codex-backed HTTP bridge |
| `subscription-runtime-codex-goal` | Manage durable Codex goal jobs and controlled worker operations |
| `subscription-runtime-codex-goal-mcp` | Expose goal jobs, run events, account facts and project-control tools over MCP |

The goal CLI and MCP server are operational control surfaces, not a hidden
orchestrator. They expose facts and brokered actions while the caller owns the
desired workflow. Start with [Codex Worker Agent Quickstart](docs/codex-worker-agent-quickstart.md)
and [Project Access Boundaries](docs/project-access-boundaries.md).

## Architecture

The repository follows Clean Architecture with feature-sliced bounded contexts
for complex runtime features:

```txt
host application / orchestrator
  -> agent-task, OpenAI bridge, CLI or MCP transport
    -> worker-core application and domain contracts
      -> provider ports, custody ports, control ports and integration ports
        -> Codex / Claude / local file / BullMQ / GitHub adapters
```

Dependency direction stays inward:

- `core` owns provider-neutral session and execution contracts;
- `worker-core` owns worker, control, integration and observability domains;
- providers implement provider behavior without importing host policy;
- stores implement custody and durable facts without deciding what to run;
- CLI, MCP, queues and process runners remain adapters;
- `worker-codex` and `worker-claude` are composition surfaces, not domain cores.

Temporal, JetStream, Redis, webhooks and filesystem details must stay out of
`worker-core`. Add them through ports and adapter packages.

See [Architecture](docs/architecture.md) and
[Runtime DDD And Feature Architecture](docs/runtime-ddd-feature-architecture.md)
for the complete dependency and bounded-context rules.

## Project-Control Safety

Project-control capabilities have grown beyond simple worker launch. The current
runtime includes:

- typed launch requests, admission state and required integration inputs;
- isolated writer workspaces and pinned source revisions;
- immutable producer handoff artifacts and verifier input patches;
- durable operation claims, fencing, recovery and replay;
- capacity-aware account reservation, cooldown and safe rotation;
- control inbox delivery and active-turn guidance;
- reviewed output adoption, remediation and merge-bound integration;
- run-event replay, projections and compact operations snapshots;
- rollback or quarantine when reviewed output cannot be safely admitted.

These mechanisms prove that an action is allowed and recoverable. They do not
decide which project outcome should be pursued.

Relevant references:

- [Project Access Boundaries](docs/project-access-boundaries.md)
- [Run Event API](docs/run-event-api.md)
- [Runtime Boundaries And Worker Control Inbox](docs/subscription-runtime-boundaries-and-control-inbox.md)
- [Codex Worker Pool Operations](docs/codex-worker-pool-operations.md)

## Security And Reliability Invariants

- Provider credentials are never valid log or persisted event payloads.
- Durable local sessions use AES-256-GCM with a 32-byte key.
- Refreshed sessions use generation hashes, compare-and-swap writeback,
  idempotency and lease state.
- GitHub Actions writeback sends sealed encrypted values, not raw auth JSON.
- Materialized provider auth belongs in process-local temporary state.
- Worker pools are bounded and expose queue, health and capacity state.
- Provider, runtime and event discriminators use strict TypeScript enums or
  validated literal contracts, with explicit handling for unknown legacy data.
- Worker writes require an admitted access scope. Integration into the target
  workspace additionally requires reviewed handoff evidence.
- Runtime results, events and diagnostics are sanitized before persistence or
  transport.

For adapter-level guarantees, see
[Adapter Certification](docs/adapter-certification.md).

## Documentation Guide

| Topic | Document |
| --- | --- |
| Package installation and lockfiles | [Package Consumption](docs/package-consumption.md) |
| High-level module boundaries | [Architecture](docs/architecture.md) |
| DDD, feature slices and dependency rules | [Runtime DDD And Feature Architecture](docs/runtime-ddd-feature-architecture.md) |
| Provider contracts and certification | [Provider Authoring](docs/provider-authoring.md), [Adapter Certification](docs/adapter-certification.md) |
| Backend deployment shape | [Backend Workers](docs/backend-workers.md) |
| Codex authentication | [Codex Auth](docs/codex-auth.md) |
| Account status and quota facts | [Account Diagnostics](docs/account-diagnostics.md), [Agent Account Observability](docs/agent-account-observability.md) |
| Agent-task protocol and handlers | [Agent Task Bridge](docs/agent-task-bridge.md) |
| Run events and read models | [Run Event API](docs/run-event-api.md) |
| Worker access and project admission | [Project Access Boundaries](docs/project-access-boundaries.md) |
| Codex goal MCP and operations | [Codex Worker Agent Quickstart](docs/codex-worker-agent-quickstart.md), [Codex Worker Pool Operations](docs/codex-worker-pool-operations.md) |
| Dependency bootstrap and shared caches | [Dependency Bootstrap](docs/dependency-bootstrap.md) |
| Provider design history and RFC context | [Pluggable Agent Runtime](docs/pluggable-agent-runtime.md), [Claude Worker Pool RFC](docs/claude-worker-pool-rfc.md) |
| Cross-repository host integration | [Host App Integration Strategy](docs/host-app-integration-strategy.md) |

## Development

Install dependencies and run the complete local quality gate:

```bash
npm ci
npm run check
```

The gate covers TypeScript, build output, unit and contract tests, architecture
boundaries, package contents and a packed external consumer.

Useful focused commands:

```bash
npm run typecheck
npm test
npm run check:boundaries
npm run check:packed-consumer
```

Live worker, provisioning, terminal, task-assignment, smoke and E2E scripts are
not part of the normal quality gate. Run them only with explicit authorization
and only against disposable sandbox/test projects, never real user projects.

## Publishing

The `Publish Package` GitHub Actions workflow builds, tests, packs and publishes
the artifact to GitHub Packages from a GitHub Release or manual dispatch. It can
also attach the exact tarball to the release.

`dist` is generated for packaging and is not committed. Public subpaths must
pass `check:packed-consumer` before release.

## License

UNLICENSED. This is a private repository and internal package.
