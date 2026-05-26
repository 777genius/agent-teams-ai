# Phase 4 - Persistence, Transactions, Outbox, Locks Plan

## Status

Draft implementation plan.

This phase adds the durable foundation required before GitHub, messenger,
billing, or any other external side effect can be safely executed.

Phase 4 must preserve the existing direction:

- Clean Architecture inside feature packages
- simple DDD where domain language helps
- SOLID boundaries
- port/adapter dependencies
- no external side effects inside request handlers
- no GitHub, messenger, billing, or queue SDKs

## Primary Outcome

After Phase 4, an API request or future desktop action can durably record
intent, append an outbox event in the same transaction, store encrypted external
action content by reference, and let a worker claim/retry/dead-letter that event
without relying on in-memory state for correctness.

## Current Dependency Research

Checked with `pnpm view` on 2026-05-26:

- `prisma`: `7.8.0`
- `@prisma/client`: `7.8.0`
- `kysely`: `0.29.2`
- `drizzle-orm`: `0.45.2`
- `pg`: `8.21.0`

Implementation must re-check latest stable versions immediately before adding
dependencies, then pin exact versions in `control-plane/package.json` and
`pnpm-lock.yaml`.

## Key Decision - Database Access

### Option 1 - Prisma schema/migrations + raw SQL for claims

🎯 9 🛡️ 9 🧠 6  
Approx change size: 1200-2200 lines.

Use Prisma for schema, migrations, typed basic CRUD, and repository adapters.
Use raw SQL only for Postgres-specific concurrency primitives such as
`FOR UPDATE SKIP LOCKED`, advisory locks if needed, and atomic claim queries.

This is the recommended path because Prisma is familiar, migration workflow is
well understood, and raw SQL can cover the exact concurrency primitives that an
outbox needs.

Risk: Prisma abstractions can tempt infrastructure concerns into application
code. Guardrails must forbid Prisma imports outside database/outbox
infrastructure.

### Option 2 - Kysely + pg + SQL migrations

🎯 7 🛡️ 9 🧠 7  
Approx change size: 1500-2600 lines.

Use explicit SQL migrations and Kysely for typed query construction. This gives
more direct control over Postgres and makes lock/outbox semantics very clear.

Risk: more custom migration/test tooling and more handwritten SQL ownership.
Good for control, slower for the team.

### Option 3 - Drizzle ORM + SQL migrations

🎯 6 🛡️ 8 🧠 7  
Approx change size: 1400-2400 lines.

Drizzle keeps SQL close and typed, but the project already discussed Prisma as
the likely persistence phase dependency. Choose this only if Prisma migrations or
runtime model become a concrete blocker.

## Recommended Decision

Use **Option 1 - Prisma schema/migrations + raw SQL for claim/lock paths**.

Reasoning:

- Prisma is productive for schema ownership and regular repository adapters.
- Postgres-specific outbox claiming is easier and safer as explicit raw SQL.
- The application/domain layers remain database-agnostic through ports.
- Extraction to a separate service later remains possible because the durable
  contracts live in tables and feature application ports, not Nest modules.

## Non-Goals

Do not implement in Phase 4:

- GitHub App webhook handling
- GitHub installation tokens
- GitHub comments/reviews/checks
- Telegram/Slack/Discord connectors
- billing or entitlements
- desktop pairing/auth flows
- Redis, Kafka, BullMQ, pg-boss, SQS, or RabbitMQ
- external object storage
- cloud KMS integration
- a generic event bus framework
- user-visible UI

## Package Shape

```text
control-plane/
  packages/
    platform/
      database/
        src/
          index.ts
          database.config.ts
          transaction/
          prisma/
          nest/

      crypto/
        src/
          index.ts
          envelope-encryption.ts
          node-crypto-envelope-encryption.adapter.ts
          nest/

    features/
      outbox/
        src/
          index.ts
          domain/
          application/
            ports/
            use-cases/
          infrastructure/
            prisma/
            worker/
          interface/
            nest/

      external-action-content/
        src/
          index.ts
          domain/
          application/
            ports/
            use-cases/
          infrastructure/
            prisma/
          interface/
            nest/
```

Keep `AuditEvent` as a table in this phase, but do not create a full audit
feature unless the implementation starts to need real audit use cases. Avoid
premature package sprawl.

## Dependency Direction

Allowed:

```text
feature domain -> shared
feature application -> domain + shared + application ports
feature infrastructure -> feature application ports + platform/database + platform/crypto
feature interface/nest -> feature use cases + Nest module wiring
platform/database -> shared + Prisma/pg + Nest adapter
platform/crypto -> shared + node:crypto + Nest adapter
apps/api, apps/worker -> feature public Nest modules + platform modules
```

Forbidden:

```text
domain/application -> Prisma
domain/application -> Nest
domain/application -> pg
domain/application -> node:crypto
platform/database -> feature packages
shared -> platform/features/Nest/Prisma/pg
request handlers -> external side effects
```

## Domain Model

### OutboxEvent

Aggregate root for durable side-effect intent.

Fields:

- `id: OutboxEventId`
- `type: string`
- `version: number`
- `status: pending | processing | completed | dead-lettered | cancelled`
- `aggregateKind?: string`
- `aggregateId?: string`
- `workspaceId?: WorkspaceId`
- `idempotencyKey: string`
- `payload: JsonObject`
- `contentRefId?: ExternalActionContentId`
- `contentHash?: string`
- `attempts: number`
- `maxAttempts: number`
- `nextAttemptAt: UnixMilliseconds`
- `lockedBy?: string`
- `lockedUntil?: UnixMilliseconds`
- `lastSafeError?: SafeError`
- `createdAt`
- `updatedAt`
- `completedAt?`
- `deadLetteredAt?`

Domain invariants:

- `pending` can be claimed only when `nextAttemptAt <= now`.
- `processing` must have `lockedBy` and `lockedUntil`.
- retry increments `attempts` and sets future `nextAttemptAt`.
- `attempts >= maxAttempts` transitions to `dead-lettered`.
- `completed` and `dead-lettered` are terminal.
- payload must never contain raw external action content when content is large,
  sensitive, or intended for deletion.

### ExternalActionContent

Encrypted content referenced by outbox events.

Fields:

- `id`
- `kind`
- `ciphertext`
- `encryptedDataKey`
- `dataKeyAlgorithm`
- `contentEncryptionAlgorithm`
- `nonce`
- `authTag`
- `sha256`
- `keyRef`
- `expiresAt`
- `deletedAt?`
- `shreddedAt?`
- `createdAt`

Domain invariants:

- plaintext is accepted only at the application boundary and is never persisted.
- every row uses a unique per-content data encryption key.
- ciphertext must be hash-verifiable.
- content can be deleted or cryptographically shredded after successful dispatch.
- expired content cannot be dispatched.

### DeadLetterEvent

Durable terminal failure record.

Fields:

- `id`
- `outboxEventId`
- `eventType`
- `eventVersion`
- `finalSafeError`
- `attempts`
- `payloadSummary`
- `contentRefId?`
- `createdAt`

Domain invariants:

- dead-letter metadata is safe.
- no raw content body is copied into dead-letter.
- content retention policy is explicit.

### DistributedLock

DB-backed lease for coordination where row-level outbox claims are not enough.

Fields:

- `name`
- `ownerId`
- `lockedUntil`
- `fencingToken`
- `createdAt`
- `updatedAt`

Domain invariants:

- a lock is valid only until `lockedUntil`.
- every successful acquire increments `fencingToken`.
- correctness must not depend on an in-memory mutex.

## Application Ports

### Transaction Port

```ts
export interface TransactionRunner {
  runInTransaction<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>;
}

export interface TransactionContext {
  readonly transactionId: string;
}
```

Repository ports that need atomicity receive `TransactionContext`.

Important rule: application use cases must not receive Prisma transaction
objects. `TransactionContext` is opaque and adapter-owned.

### Outbox Ports

```ts
export interface OutboxWriter {
  append(event: NewOutboxEvent, context: TransactionContext): Promise<OutboxEvent>;
}

export interface OutboxClaimer {
  claimNextBatch(input: ClaimOutboxBatchInput): Promise<readonly ClaimedOutboxEvent[]>;
  markCompleted(input: CompleteOutboxEventInput): Promise<void>;
  markFailedForRetry(input: RetryOutboxEventInput): Promise<void>;
  markDeadLettered(input: DeadLetterOutboxEventInput): Promise<void>;
  recoverStaleProcessing(input: RecoverStaleOutboxInput): Promise<number>;
}
```

### External Content Ports

```ts
export interface ExternalActionContentStore {
  storeEncrypted(
    input: StoreExternalActionContentInput,
    context: TransactionContext,
  ): Promise<ExternalActionContentRef>;
  loadDecrypted(ref: ExternalActionContentRef): Promise<DecryptedExternalActionContent>;
  shred(ref: ExternalActionContentRef, context: TransactionContext): Promise<void>;
}
```

### Lock Ports

```ts
export interface DistributedLockPort {
  acquire(input: AcquireLockInput): Promise<AcquireLockResult>;
  renew(input: RenewLockInput): Promise<RenewLockResult>;
  release(input: ReleaseLockInput): Promise<void>;
}
```

## Database Schema

### `outbox_events`

Recommended columns:

```text
id uuid primary key
event_type text not null
event_version integer not null
status text not null
aggregate_kind text null
aggregate_id text null
workspace_id text null
idempotency_key text not null
payload_json jsonb not null
content_ref_id uuid null
content_sha256 text null
attempts integer not null default 0
max_attempts integer not null default 10
next_attempt_at timestamptz not null
locked_by text null
locked_until timestamptz null
last_error_code text null
last_error_category text null
last_error_message text null
last_error_retryable boolean null
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
completed_at timestamptz null
dead_lettered_at timestamptz null
```

Indexes:

```text
unique(idempotency_key)
index(status, next_attempt_at)
index(locked_until) where status = 'processing'
index(workspace_id, created_at)
index(content_ref_id)
```

### `external_action_contents`

Recommended columns:

```text
id uuid primary key
content_kind text not null
ciphertext bytea not null
encrypted_data_key bytea not null
data_key_algorithm text not null
content_encryption_algorithm text not null
nonce bytea not null
auth_tag bytea not null
sha256 text not null
key_ref text not null
expires_at timestamptz not null
deleted_at timestamptz null
shredded_at timestamptz null
created_at timestamptz not null default now()
```

Indexes:

```text
index(expires_at)
index(deleted_at)
index(shredded_at)
```

### `external_action_content_key_refs`

Recommended columns:

```text
key_ref text primary key
key_version integer not null
algorithm text not null
status text not null
created_at timestamptz not null default now()
retired_at timestamptz null
```

This table stores references and rotation metadata only. It must not store raw
master keys.

### `dead_letter_events`

Recommended columns:

```text
id uuid primary key
outbox_event_id uuid not null unique
event_type text not null
event_version integer not null
final_error_json jsonb not null
attempts integer not null
payload_summary_json jsonb not null
content_ref_id uuid null
created_at timestamptz not null default now()
```

### `audit_events`

Recommended columns:

```text
id uuid primary key
event_type text not null
actor_kind text not null
actor_id text null
workspace_id text null
subject_kind text null
subject_id text null
safe_metadata_json jsonb not null
correlation_id text null
request_id text null
created_at timestamptz not null default now()
```

### `distributed_locks`

Recommended columns:

```text
name text primary key
owner_id text not null
locked_until timestamptz not null
fencing_token bigint not null
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

## Outbox Claim Algorithm

Use one atomic Postgres operation:

```sql
UPDATE outbox_events
SET
  status = 'processing',
  locked_by = $worker_id,
  locked_until = now() + $lease_duration::interval,
  updated_at = now()
WHERE id IN (
  SELECT id
  FROM outbox_events
  WHERE status = 'pending'
    AND next_attempt_at <= now()
  ORDER BY next_attempt_at ASC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $batch_size
)
RETURNING *;
```

Important details:

- use `FOR UPDATE SKIP LOCKED` for concurrent workers.
- never claim events in memory after a non-locking select.
- keep claim batch size configurable.
- keep lease duration configurable.
- worker identity must be stable for process lifetime.
- stale `processing` events become `pending` only after `locked_until < now()`.

## Retry Policy

Default policy:

```text
attempt 1: immediate
attempt 2: 30 seconds
attempt 3: 2 minutes
attempt 4: 10 minutes
attempt 5+: min(1 hour, exponential backoff)
```

Add jitter to avoid synchronized retry bursts.

Retry stores only safe error fields:

- `code`
- `category`
- `message`
- `retryable`

Raw provider errors, stack traces, tokens, SQL messages, and plaintext content
must not be stored.

## Transaction Rules

Every future request that records side-effect intent must:

1. validate input and authorization in application use case.
2. open one transaction through `TransactionRunner`.
3. write canonical state.
4. store encrypted content if needed.
5. append outbox event with content reference/hash.
6. commit.
7. return without performing external side effects.

Rollback must leave no orphaned outbox/content rows.

## Worker Rules

Worker responsibilities in Phase 4:

- recover stale `processing` events.
- claim pending event batches.
- route event to registered in-process handlers.
- handle unknown event type/version by dead-lettering.
- mark completed events.
- mark retryable failures with next attempt.
- mark terminal failures as dead-lettered.
- emit safe logs with correlation/request/event ids when available.

Worker non-goals in Phase 4:

- GitHub dispatch
- messenger dispatch
- billing dispatch
- external provider calls

Use fake handlers in tests to prove worker lifecycle without real providers.

## Encryption Design

Recommended v1:

- Node `crypto` only, no external encryption dependency.
- master key loaded from env as base64.
- per-content random data encryption key.
- content encrypted with AES-256-GCM.
- data key wrapped/encrypted by the master key.
- `sha256` stored for integrity/reference checks.
- auth tag and nonce stored separately.

Config:

```text
CONTROL_PLANE_DATABASE_URL
CONTROL_PLANE_DATABASE_SSL_MODE
CONTROL_PLANE_ENCRYPTION_MASTER_KEY
CONTROL_PLANE_OUTBOX_BATCH_SIZE
CONTROL_PLANE_OUTBOX_LEASE_SECONDS
CONTROL_PLANE_OUTBOX_POLL_INTERVAL_MS
CONTROL_PLANE_OUTBOX_MAX_ATTEMPTS
```

Hosted mode must fail fast if database URL or encryption master key is missing.
Local-disabled mode may boot without DB only if DB-backed features are disabled.

## Architecture Guardrails

Update `architecture:check`:

- keep shared dependency-free.
- continue forbidding Prisma/pg/Nest in domain/application.
- allow Prisma/pg only in `packages/platform/database`,
  `packages/features/*/src/infrastructure/**`, and tests.
- forbid external provider SDKs in Phase 4.
- forbid raw external action content in outbox/audit field names where practical.
- forbid feature infrastructure imports across bounded contexts.
- ensure feature public exports remain explicit.

Add regression tests:

- domain importing Prisma fails.
- application importing Prisma fails.
- shared declaring dependency fails.
- feature infrastructure importing another feature infrastructure fails.
- outbox package exporting private layers fails.

## Implementation Steps

### Step 1 - Database Platform

Create:

```text
packages/platform/database
```

Add:

- Prisma schema and migration command.
- `DatabaseModule`.
- `DatabaseClient` adapter.
- `TransactionRunner` implementation.
- config parsing for DB env.
- safe health summary fields only.

Verification:

- package builds.
- config fails fast in hosted mode without DB URL.
- no Prisma imports outside allowed infrastructure.

### Step 2 - Crypto Platform

Create:

```text
packages/platform/crypto
```

Add:

- envelope encryption port.
- Node crypto adapter.
- key reference metadata.
- tests for encrypt/decrypt/hash/shred semantics.

Verification:

- plaintext never appears in persisted fixture output.
- wrong key/auth tag fails closed.
- safe errors are returned.

### Step 3 - External Action Content Feature

Create:

```text
packages/features/external-action-content
```

Add:

- content domain model.
- store/load/shred use cases.
- repository port.
- Prisma repository adapter.
- Nest module wiring.

Verification:

- store + load roundtrip.
- expired content cannot be loaded for dispatch.
- shredded content cannot be decrypted.

### Step 4 - Outbox Feature

Create:

```text
packages/features/outbox
```

Add:

- outbox domain model.
- writer and claimer ports.
- append/claim/complete/retry/dead-letter use cases.
- Prisma repository adapter.
- worker runner.
- fake handler registry for tests.

Verification:

- append inside transaction.
- duplicate idempotency key returns existing or conflicts deterministically.
- concurrent workers claim distinct events.
- stale processing recovers.
- unknown version dead-letters.

### Step 5 - Worker Integration

Wire outbox worker into `apps/worker` behind config.

Phase 4 worker can process fake/no-op event handlers only. Real provider
dispatch begins later.

Verification:

- worker smoke still works without DB in local-disabled mode.
- DB-enabled smoke claims and completes a fake event.
- SIGTERM stops polling without losing claimed events.

### Step 6 - Documentation And Runbooks

Add docs:

- migration runbook.
- outbox worker operational runbook.
- encryption and retention policy.
- local DB setup.
- dead-letter recovery procedure.

## Test Plan

Unit tests:

- outbox status transitions.
- retry/backoff calculation.
- dead-letter transition.
- lock lease validity.
- envelope encryption roundtrip.
- safe error conversion for DB/encryption errors.

Integration tests:

- migrations apply to empty database.
- transaction rollback removes outbox/content writes.
- append event inside transaction.
- `FOR UPDATE SKIP LOCKED` claim split across concurrent workers.
- stale processing recovery.
- idempotency uniqueness.
- encrypted content store/load/shred.
- dead-letter rows contain no plaintext.

Architecture tests:

- domain/application cannot import Prisma/pg/Nest.
- shared remains dependency-free.
- external SDKs still forbidden.
- only infrastructure/platform packages can import DB clients.

Smoke tests:

- API still starts in local-disabled mode.
- worker still starts in local-disabled mode.
- DB-enabled worker processes fake outbox event.

Recommended commands:

```bash
pnpm --dir control-plane install --frozen-lockfile
pnpm --dir control-plane architecture:check
pnpm --dir control-plane lint
pnpm --dir control-plane typecheck
pnpm --dir control-plane test
pnpm --dir control-plane build
pnpm --dir control-plane api:smoke
pnpm --dir control-plane api:smoke:dist
pnpm --dir control-plane worker:smoke
pnpm --dir control-plane worker:smoke:dist
```

Add DB-specific scripts during implementation:

```bash
pnpm --dir control-plane db:migrate
pnpm --dir control-plane db:test:prepare
pnpm --dir control-plane test:db
pnpm --dir control-plane worker:smoke:db
```

## Edge Cases

- API request succeeds but transaction commit fails: no outbox event exists,
  response must be safe 5xx.
- canonical state write succeeds but outbox append fails: transaction rolls back.
- content row write succeeds but outbox append fails: transaction rolls back.
- worker claims event and crashes before dispatch: lease expires and event
  becomes claimable.
- worker dispatch succeeds but completion write fails: later phases need
  provider-level idempotency/update-or-create markers.
- unknown event type/version: dead-letter, do not drop.
- decryption failure: dead-letter, never regenerate content.
- expired content: dead-letter or cancel with safe error.
- duplicate idempotency key under concurrency: one winner, deterministic return.
- DB clock skew: use database `now()` for claim/lease SQL.
- long transaction: keep request transactions short, never call external
  providers inside them.
- migration partially applied: migration tool must fail fast before app starts.

## Security And Privacy Requirements

- never store raw external action content in outbox payload or audit metadata.
- never log plaintext content.
- never store raw provider errors.
- dead-letter stores safe summaries only.
- encryption master key is never logged or exposed in config summary.
- `safeDetails` remain primitive and non-secret.
- DB URL must be redacted in logs.
- audit metadata must be allowlisted, not arbitrary request bodies.

## Done Criteria

Phase 4 is complete when:

- database platform package exists and builds.
- migrations create all Phase 4 tables.
- transaction runner is used by outbox/content writes.
- outbox append and content store can commit atomically.
- outbox worker can claim, retry, recover stale, complete, and dead-letter.
- encrypted content can be stored, loaded, and shredded.
- DB-backed idempotency is proven by tests.
- no in-memory lock is required for correctness.
- architecture checker enforces DB dependency boundaries.
- docs explain migration, worker, encryption, and dead-letter operations.
- full control-plane verification passes.

## Suggested Commit Split

1. `feat(control-plane): add database platform foundation`
2. `feat(control-plane): add envelope encryption platform`
3. `feat(control-plane): add external action content storage`
4. `feat(control-plane): add outbox domain and repositories`
5. `feat(control-plane): add outbox worker lifecycle`
6. `test(control-plane): cover persistence outbox and lock behavior`
7. `docs(control-plane): document persistence and outbox operations`

Keep commits small enough that every one can pass `architecture:check`,
`typecheck`, and focused tests.
