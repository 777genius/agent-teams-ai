# Claude Worker Pool RFC

Status: draft

## Problem

`subscription-runtime` already exposes a generic bounded worker pool and a
Codex file-backed worker. Claude currently has a provider adapter and runtime
execution engine, but it does not have a first-class backend worker equivalent
to `FileBackendCodexWorker`.

The desired deployment shape is a warmed pool of Claude Code workers that can
process jobs and stop assigning new work to a worker before it reaches a usage
limit, or immediately after a quota/rate limit signal is observed.

## Non-Goals

- Do not put Claude quota, auth, warming or retry logic into host apps such as
  `quanta-pr-reviewer`.
- Do not add Claude-specific fields to `worker-core` or `core` task contracts.
- Do not poll private Claude usage endpoints. Use passive Claude Code
  `statusLine.rate_limits` telemetry when available, and fall back to local
  soft limits plus quota/rate-limit failure classification when telemetry is
  missing.
- Do not assume multiple local slots on the same Claude account increase quota.

## Key Assumption

A real Claude worker pool requires multiple independent Claude subscription
sessions/accounts/tokens. Multiple slots using one token are still useful for
prewarm, restart isolation and queueing, but they do not provide independent
quota capacity.

## Current Code Shape

- `worker-core/BoundedSubscriptionWorkerPool` owns slot lifecycle, queueing,
  prewarm, restart, health and disposal.
- `worker-codex/FileBackendCodexWorker` composes storage, runner, workspace,
  Codex session driver and Codex agent driver into a `SubscriptionWorker`.
- `provider-claude` already exposes `ClaudeSessionDriver`,
  `ClaudeTaskAgentDriver` and `ClaudeRuntimeTaskExecutionEngine`.

The missing pieces are:

1. a Claude `SubscriptionWorker`;
2. capacity-aware worker selection;
3. provider-neutral slot cooldown/quota state;
4. Claude-specific classification of soft and hard limit signals.

## Proposed Architecture

```txt
host app
  -> queue-core / queue-bullmq / direct call
    -> worker-core CapacityAwareSubscriptionWorkerPool
      -> worker-claude FileBackendClaudeWorker
        -> provider-claude ClaudeTaskAgentDriver
          -> ClaudeRuntimeTaskExecutionEngine
            -> claude-runtime / Claude Code bg runtime
```

`worker-core` stays provider-neutral. It can ask a worker for health and capacity
signals, but it must not understand Claude-specific text.

`worker-claude` owns Claude session materialization, `CLAUDE_CONFIG_DIR`
isolation, runtime context creation, prewarm behavior and mapping Claude
failures into generic capacity signals.

## New Worker-Core Concepts

Add provider-neutral capacity metadata without changing the base
`SubscriptionWorker` contract for existing consumers.

```ts
export type WorkerSlotAvailability =
  | "available"
  | "busy"
  | "warming"
  | "cooldown"
  | "quota_exhausted"
  | "degraded"
  | "disabled";

export type WorkerCapacitySnapshot = {
  readonly availability: WorkerSlotAvailability;
  readonly reason?: string;
  readonly cooldownUntil?: Date;
  readonly recentRuns?: number;
  readonly softLimitRemainingRuns?: number;
  readonly lastLimitSignalAt?: Date;
  readonly details?: Readonly<Record<string, string>>;
};

export interface CapacityAwareSubscriptionWorker<Job, Result>
  extends SubscriptionWorker<Job, Result> {
  capacity(): WorkerCapacitySnapshot;
}
```

Add a provider-neutral account capacity boundary for subscription runtimes where
many worker slots can share one quota domain:

```ts
export type WorkerAccountCapacityStore = {
  read(input: { accountId: string; now?: Date }): WorkerCapacitySnapshot | null;
  observe(input: WorkerAccountLimitSignal): void;
  clear(input: { accountId: string }): void;
};
```

`worker-core/AccountCapacityAwareWorker` wraps any
`SubscriptionWorker<Job, Result>`. It never parses Claude or Codex credentials.
It only reads provider-neutral capacity details:

- `accountId`: preferred provider-neutral quota/account key;
- `quotaGroup`: backwards-compatible provider adapter key;
- `subscriptionAccountId`: optional host-facing account key.

If one wrapped worker reports an account-level cooldown or quota exhaustion,
the shared `WorkerAccountCapacityStore` makes every sibling worker with the same
account id unavailable until the reset time expires. Different accounts remain
available. This keeps host apps and generic queues free of Claude-specific
state, while still allowing provider adapters to expose safe quota signals.
Hosts should prefer `accountCapacityAwareWorkerFactory()` when wiring
`BoundedSubscriptionWorkerPool`, so account policy stays outside provider
worker constructors.

The pool can support a `slotSelector` policy:

```ts
export type WorkerSlotSelector<Job> = (input: {
  readonly slots: readonly WorkerPoolSlotSnapshot[];
  readonly job: Job;
  readonly now: Date;
}) => WorkerPoolSlotSnapshot | null;
```

Default behavior stays compatible: first idle healthy slot.

## Claude Worker

Add `worker-claude/FileBackendClaudeWorker`.

Responsibilities:

- read/write Claude OAuth session artifacts through existing runtime stores;
- isolate each worker with a stable per-worker `CLAUDE_CONFIG_DIR`;
- compose `ClaudeSessionDriver`, `ClaudeTaskAgentDriver`,
  `ClaudeRuntimeTaskExecutionEngine`, runner and workspace;
- expose `prewarm()`, `run()`, `health()`, `dispose()`;
- expose `runThreadJob()` for logical Claude threads that must continue across
  worker slots with explicit `--resume` session ids;
- track local soft rotation counters;
- classify Claude runtime warnings/failures into capacity state.
- expose safe capacity details including `providerInstanceId`, `configDir` and
  `quotaGroup` so duplicate OAuth sessions can be spotted without logging the
  token.

The public job/result shape should mirror Codex worker simplicity:

```ts
export type FileBackendClaudeWorkerJob = {
  readonly runId?: string;
  readonly prompt: string;
  readonly kind?: ProviderTask["kind"];
  readonly outputSchemaName?: string;
  readonly controls?: ProviderTask["controls"];
  readonly abortSignal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, string>>;
};
```

## Limit Rotation Policy

Claude Code exposes Claude.ai subscription usage windows through
`statusLine.rate_limits` after the first model response. The pool should treat
that as passive telemetry, not as an active usage API:

- `rateLimitMinRemainingPercent`: when a configured window has less remaining
  capacity than this threshold, stop assigning new work to the slot until that
  window's `resets_at`;
- `rateLimitWindows`: select which windows to enforce, defaulting to both the
  five-hour and seven-day windows;
- `softMaxRunsPerWindow`: after N successful runs, stop assigning new work to
  the slot until the local capacity window resets;
- failure classifier: quota/rate-limit failures mark the slot
  `quota_exhausted` or `cooldown`;
- account-aware decorator: when one slot sees a provider account-level limit,
  all slots with the same `accountId`/`quotaGroup` stop receiving work until
  the reset time;
- in-flight work is allowed to finish unless the host aborts it.

Tests must reproduce limit states with fake telemetry snapshots instead of
exhausting a real subscription. The real `statusLine` script is also tested with
a sample Claude Code payload so parsing, reset timestamps and threshold behavior
stay deterministic.

## Prewarm

Default prewarm must avoid burning meaningful quota:

1. validate that the session artifact exists and is not malformed;
2. prepare stable `CLAUDE_CONFIG_DIR`;
3. create provider/runtime context;
4. optionally run a non-spending or minimal CLI/runtime healthcheck if available.

Add an explicit opt-in for spending prewarm:

```ts
warmupPrompt?: string | false;
```

`false` means context-only prewarm. A string means run a real task such as
`Return exactly OK.` and therefore spend quota.

## Logical Thread Handoff

Claude Code resume is bound to the Claude session id and the project cwd.
Worker handoff therefore uses:

- one logical thread store: `threadId -> latestSessionId/latestBundleId`;
- one transcript bundle store that copies Claude `projects/**/<session>.jsonl`
  files from the previous worker config dir into the selected worker config dir;
- explicit `provider.send()` follow-up calls with the previous provider session
  id, instead of implicit `--continue`;
- the same workspace path for every worker that can process one logical thread.

The worker rejects a handoff when the stored thread cwd differs from the selected
worker workspace path. This prevents a silent new Claude context when a pool is
misconfigured with per-slot workspaces.

## Failure Semantics

Recommended slot state transitions:

- auth/session invalid -> `disabled`, reconnect required;
- setup/permission prompt -> `degraded`, no new work;
- timeout -> keep available unless repeated threshold is exceeded;
- local soft run limit -> `cooldown`, no new work until the window resets;
- hard quota/rate limit -> `cooldown`, no new work until reset policy;
- unknown runtime failure -> retryable failure, degrade after threshold.

Queued jobs should be assigned only to slots whose capacity is `available`.
If no slots are available, behavior must be configured:

- wait in queue until a cooldown expires;
- fail fast;
- optionally fallback to another provider such as Codex.

## Test Plan

Unit tests:

- pool skips idle slots in `cooldown` and chooses the next available slot;
- account-aware worker propagates a limit from one worker to all siblings with
  the same account id without affecting another account;
- account cooldown expires at the provider reset time and the worker becomes
  assignable again;
- quota failure marks a slot exhausted and retries an idempotent job on another
  slot when retry policy allows it;
- prewarm failures degrade one slot without destroying the whole pool when the
  policy allows partial readiness;
- all slots exhausted follows configured behavior: queue, fail or fallback;
- one token across multiple Claude slots is surfaced in health/capacity details
  as the same `quotaGroup`, not independent quota.

Provider tests:

- Claude warning text is classified as soft limit signal;
- Claude quota/rate failures are classified as hard limit signals;
- `FileBackendClaudeWorker` redacts OAuth tokens in warnings and failures;
- `CLAUDE_CONFIG_DIR` is stable per worker and distinct across workers.

Live smoke:

- one local Claude token: worker starts, prewarms and runs one task;
- one local Claude token: two isolated Claude config dirs hand off the same
  logical thread through a shared workspace and explicit resume;
- two independent Claude tokens when available: two workers process jobs and
  rotation can be observed with an artificially low soft run limit.

Use the package smoke harness for local verification:

```sh
export CLAUDE_CODE_OAUTH_TOKEN=...
export CLAUDE_PATH="$(command -v claude)"
npm run smoke:worker-claude
npm run smoke:worker-claude-thread
```

For a real two-worker smoke, also set `CLAUDE_CODE_OAUTH_TOKEN_2` to a distinct
Claude session token. The harness uses a soft one-run window for the two-worker
case, so the second request should be assigned to the second worker without
needing to exhaust a real Claude subscription limit.

## Open Questions

1. Does each Claude worker correspond to a separate Claude account/session/token?
2. If all Claude workers are unavailable, should the pool wait, fail fast or
   fallback to Codex?
3. Is real prompt prewarm allowed, knowing it spends quota?
4. Does the first deployment run in one process, or do we need shared capacity
   state across replicas immediately?
5. On a soft limit warning, should in-flight work finish or be cancelled and
   retried on another worker?

## Recommended Defaults

Use these defaults if product or infra owners do not decide otherwise:

- Treat one Claude worker as one independent Claude session/token. If only one
  token is configured, default to one Claude slot for quota scheduling.
- When all Claude workers are unavailable, wait in the queue until either a
  worker recovers or the queue/job timeout expires. Do not fallback to Codex
  unless the host explicitly opts in.
- Use context-only prewarm by default. Spending warmup prompts must be explicit.
- Keep capacity state in memory for the first deployment. Add a shared capacity
  store only when multiple runtime processes schedule the same Claude accounts.
- Let in-flight jobs finish on soft limit warnings. Stop assigning new work to
  that worker immediately.

## Recommended Implementation Order

1. Add this RFC and confirm the open questions.
2. Add provider-neutral capacity snapshots and slot selection to `worker-core`.
3. Add `worker-claude/FileBackendClaudeWorker`.
4. Add Claude soft/hard limit signal classification tests.
5. Add deterministic fake-worker tests for rotation/cooldown.
6. Add local live smoke for one token.
7. Add two-token live smoke when independent Claude sessions are available.
8. Integrate host apps such as `quanta-pr-reviewer` through the runtime adapter
   only after the runtime behavior is verified.
