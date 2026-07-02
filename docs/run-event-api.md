# Run Event API

`subscription-runtime` owns normalized runtime facts, durable runtime events and
read-only safety decisions. It does not own orchestration policy.

The target shape is an event-driven runtime kernel:

```text
worker facts -> RunObservationSnapshot -> RunEvent outbox -> read models -> relay/API
```

Higher-level orchestrators consume events and read models:

```text
RunEvent/read-models -> orchestrator policy -> control inbox / notifications
```

## Responsibility Boundary

Runtime layer:

- observes worker progress, result, logs, workspace and capacity;
- normalizes observations into `RunObservationSnapshot`;
- projects snapshots into durable `RunEvent` records;
- projects derived read models such as safety, liveness, workspace, account
  capacity, outcome and control inbox state;
- stores events in an outbox-style store;
- exposes read/watch APIs for orchestration layers.

Orchestrator layer:

- decides when to continue, recover, stop, notify or schedule work;
- chooses queue technology;
- owns product policy, priorities and retry strategy.

Transport adapters:

- may publish `RunEvent` to stdout, MCP, WebSocket, JetStream, Postgres,
  Redis Streams or webhooks;
- must not change the core event contract.

Temporal belongs above this layer. A future Temporal orchestrator should model
long-running goals, timers and retries as workflows, and call
`subscription-runtime` through activities/ports. `worker-core` must not import
Temporal, JetStream, Redis, webhooks or file-system adapters.

## Contract Rules

- Provider/runtime/event discriminators use strict TypeScript enums.
- Do not add extensibility as `"codex" | "claude" | string`.
- Add new enum values intentionally and handle legacy unknowns through explicit
  `Unknown` values or validation failures.
- Payloads must be safe to print. Never include secrets, auth payloads, tokens,
  cookies, API keys or raw provider credentials.
- Runtime read-models are not policy. They can say `safeToContinue=false` with
  `issueKind=dirty_workspace_without_running_worker`; the orchestrator decides
  whether to notify, recover or wait.

## Read Models

Projection state stores these derived models per run:

- `RunSafetyState`: `safeToContinue`, `reviewOnly`, issue kind, reason,
  confidence and evidence.
- `RunLivenessState`: alive/dead/stale/quiet/completed-live plus heartbeat/log
  metadata.
- `WorkspaceState`: clean/dirty/missing/unknown/warning, changed file sample and
  review-only flag.
- `AccountCapacityState`: availability, blocked/cooldown counts, masked account
  identities and safe reasons.
- `RunOutcomeState`: running/completed/failed/blocked/partial/needs-attention.
- `ControlInboxState`: clear/pending/delivered/blocked/unsafe with counts.

These models prevent every consumer from duplicating status parsing. CLI,
dashboard, Temporal workflows and local daemons should read them instead of
parsing `progress.json`, `latest-result.json` or logs directly.

## Delivery Semantics

Current local adapter:

- writes append-only JSONL events;
- dedupes by deterministic `eventId`;
- supports cursor reads;
- tolerates corrupt or partial lines by skipping invalid lines;
- stores projection state per run so polling does not re-emit unchanged facts.
- exposes explicit retention/compaction primitives. Compaction is never a hidden
  side effect of append/read/project.

Relay layer:

- reads the local outbox by a persisted delivery cursor;
- publishes through `RunEventPublisherPort`;
- advances the delivery cursor only after publish succeeds;
- uses at-least-once delivery semantics;
- expects consumers to dedupe by `eventId`.

Current publisher adapters:

- `StdoutNdjsonRunEventPublisher`: writes one safe JSON event per line.
- `WebhookRunEventPublisher`: posts safe event batches to an HTTP endpoint.
  It treats non-2xx responses and timeouts as publish failures. The relay cursor
  should only advance after this publisher succeeds.

Future queue adapters should keep the same semantics:

- at-least-once delivery;
- idempotent consumers;
- deterministic event IDs;
- replay from durable store;
- backpressure handled outside worker execution.

## Retention and Compaction

Local JSONL compaction is explicit and cursor-aware:

- default safety mode is `preserve_delivery_cursors`;
- saved delivery cursors are read before rewrite;
- retained event lines are rewritten into a compacted log;
- saved cursors are rebased to the new line positions;
- unread lines for saved cursors are not removed in preserve mode;
- `force` mode can remove unread lines, but reports
  `invalidatedUnreadEvents=true` per affected cursor;
- corrupt event lines can be dropped only when `dropInvalidLines` is explicitly
  enabled.

Run compaction as a maintenance action while local relays for the same outbox
are quiesced. The primitive protects saved cursor files, but it cannot rebase a
cursor that a concurrently running relay has already loaded into memory.

Supported policy knobs:

- `keepEventsAfter`: remove older events.
- `keepLatestEventsPerRun`: always retain the latest N events per run.
- `compactDeliveredEvents`: remove lines already consumed by all saved delivery
  cursors.
- `dropInvalidLines`: remove corrupt event log lines during compaction.
- `safetyMode`: `preserve_delivery_cursors` or `force`.

Cursor readers treat a trailing newline as a file terminator, not as an extra
line. This prevents a consumer that read to the end from skipping a later
append.

## Current Surfaces

MCP tools:

- `agent_run_events`: read durable run events from the local outbox. Read-only.
- `codex_goal_events`: Codex-scoped alias for `agent_run_events`.
- `agent_run_state`: read projected run read-model state. Read-only.
- `codex_goal_state`: Codex-scoped alias for `agent_run_state`.
- `agent_run_event_compaction_plan`: read-only local event log compaction plan.
- `agent_run_event_compact`: explicit local event log compaction. Requires
  `confirmCompact=true` and never controls workers.
- `agent_run_project_events`: observe runs and project normalized events into
  the local outbox. Side effects are limited to event/projection state writes.
- `codex_goal_project_events`: Codex-scoped alias for
  `agent_run_project_events`.

CLI shortcuts:

```sh
subscription-runtime-codex-goal events <jobId> \
  --registry-root /var/data/worker-jobs/registry \
  --event-root /var/data/worker-jobs/run-events \
  --cursor 0 \
  --type run.completed \
  --limit 100

subscription-runtime-codex-goal state <jobId> \
  --registry-root /var/data/worker-jobs/registry \
  --event-root /var/data/worker-jobs/run-events

subscription-runtime-codex-goal event-compaction-plan \
  --registry-root /var/data/worker-jobs/registry \
  --event-root /var/data/worker-jobs/run-events \
  --compact-delivered \
  --keep-latest-per-run 100 \
  --drop-invalid-lines

subscription-runtime-codex-goal event-compact \
  --registry-root /var/data/worker-jobs/registry \
  --event-root /var/data/worker-jobs/run-events \
  --compact-delivered \
  --keep-latest-per-run 100 \
  --confirm

subscription-runtime-codex-goal project-events <jobId> \
  --registry-root /var/data/worker-jobs/registry \
  --event-root /var/data/worker-jobs/run-events \
  --host-id codex-workers-eu-01

subscription-runtime-codex-goal relay-events \
  --event-root /var/data/worker-jobs/run-events \
  --consumer-id local-orchestrator \
  --publisher stdout \
  --limit 100

subscription-runtime-codex-goal relay-events \
  --event-root /var/data/worker-jobs/run-events \
  --consumer-id webhook-orchestrator \
  --publisher webhook \
  --webhook-url https://orchestrator.example.test/events \
  --limit 100
```

`events`, `state` and `event-compaction-plan` are read-only. If stored
projection state is unavailable, `state` may rebuild read models from durable
events and return `replayOnly`. `event-compact` rewrites only the local event log
and delivery cursors, requires `--confirm`, and never starts, stops, continues
or recovers workers. `project-events` observes worker state and writes only the
event outbox plus projection state; it never starts, stops, continues or
recovers workers.

## Important Edge Cases

- Repeated polling must not create duplicate events.
- Process restart must recover projection state before projecting next events.
- Projection state without read models from older versions must be tolerated and
  backfilled as unknown/review-only instead of crashing readers.
- A completed result with a live process is `unsafe_state_detected`, not success.
- `maintenance_paused` is not failure.
- `manual_review_required`, `capacity_blocked`, `stale_needs_inspection` and
  `unsafe_state_mismatch` are different cases and must not be collapsed.
- Dirty workspace with no live worker must stay review-only.
- Log growth, result changes and workspace changes are separate event streams.
- Event readers must survive corrupted JSONL tails.
- Queue publish failure must not lose the local durable event.
- Control events must carry correlation/idempotency data, causation metadata,
  cooldown keys and max-attempt guards so orchestrators can avoid loops and
  duplicated notifications.
- Retention must not delete unread events for saved delivery cursors unless the
  caller explicitly uses force mode and accepts cursor invalidation.
