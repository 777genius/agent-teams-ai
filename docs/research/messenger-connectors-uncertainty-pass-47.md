# Messenger Connectors - Uncertainty Pass 47

Date: 2026-04-30
Scope: crash consistency, exactly-once local state, cross-store side effects, and storage strategy

## 1. Bottom Line

The weakest remaining implementation area is now crash consistency across multiple local stores.

The risky chain is:

```text
ProcessedProviderUpdate
-> route decision
-> local inbox/sent projection
-> runtime turn ledger
-> visible reply persistence
-> ExternalMessageLink
-> ProviderOutbox
-> provider send result
```

If these are written as independent JSON files without a unit-of-work boundary, the app can crash between writes and create:

- duplicate lead delivery;
- missing `ExternalMessageLink`;
- local reply visible in UI but never sent to Telegram;
- Telegram send succeeded but local store says retry;
- provider inbound marked processed before the turn is recoverable;
- local projection row written but feature store missing the committed side-effect marker.

Updated recommendation:

🎯 9   🛡️ 9   🧠 7   Approx `1800-3600` LOC

```text
Use one feature-owned canonical MessengerStateStore for all critical connector tables in MVP.
Use existing team inbox/sent files and provider API calls as idempotent side effects with verify/reconcile steps.
```

This changes the earlier "many feature stores" wording:

```text
connections.json, message-links.json, outbox.json, runtime-turns.json, etc.
```

should be treated as logical tables. For MVP they should live in one canonical file or one canonical event log, not as independent transactional files.

## 2. External Facts Checked

SQLite official docs:

- SQLite transactions are ACID.
- SQLite states that all changes within a single transaction either occur completely or not at all, including across program crash, OS crash, or power failure.
- WAL mode makes commits append to a WAL file and supports concurrent readers with one writer.
- WAL mode has caveats: all processes must be on the same host, WAL uses extra `-wal` and `-shm` files, checkpointing matters, and transactions across multiple attached databases are not atomic as a set.

Node official docs:

- `node:sqlite` was added in Node 22.5.0.
- In Node v25.7.0 it is a release candidate.
- In Node v22 line it is no longer behind `--experimental-sqlite`, but still experimental.
- `DatabaseSync` APIs are synchronous.

Local package/version checks:

```text
node: v22.21.1
node:sqlite: available, but prints ExperimentalWarning in this environment
better-sqlite3: latest 12.9.0, MIT, npm modified 2026-04-12
sqlite3: latest 6.0.1, BSD-3-Clause, npm modified 2026-03-12
```

Local dependency check:

```text
No better-sqlite3 or sqlite3 dependency is currently installed in the repo.
```

Implication:

```text
SQLite is the strongest storage primitive, but adding it now creates Electron/native packaging cost.
The repo already has a mature VersionedJsonStore + file lock pattern, so MVP should use a single canonical feature store plus recovery sagas.
```

## 3. Local Storage Facts

### 3.1 VersionedJsonStore

`VersionedJsonStore` provides:

- schema envelope;
- validation on read;
- quarantine for invalid JSON/data/future schema;
- `withFileLock`;
- stable JSON comparison;
- atomic write through `atomicWriteAsync`.

Limits:

- transaction scope is one file;
- no multi-file atomicity;
- update function clones full JSON data;
- large arrays become slower over time;
- per-file lock timeout is 5 seconds;
- lock staleness is time-based, not process-liveness-based.

### 3.2 atomicWriteAsync

`atomicWriteAsync`:

- writes temp file;
- best-effort fsyncs temp file;
- renames temp file over target;
- handles `EXDEV` with copy/unlink fallback;
- retries `EPERM`.

Limits:

- directory fsync after rename is not explicit;
- `EXDEV` fallback is not the same atomicity as same-directory rename;
- it protects one target path, not a group of files.

### 3.3 Existing inbox writes

`TeamInboxWriter.sendMessage()`:

- uses file lock plus in-process inbox lock;
- appends payload;
- atomic writes;
- verifies the message id exists after write;
- returns message id.

This is good as a side-effect destination.

### 3.4 Existing sent message writes

`TeamSentMessagesStore.appendMessage()`:

- reads existing `sentMessages.json`;
- appends;
- trims to 200 rows;
- atomic writes;
- catches and logs errors without throwing.

`TeamProvisioningService.persistSentMessage()`:

- calls `agent-teams-controller.messages.appendSentMessage()`;
- catches and logs errors without throwing.

Implication:

```text
sentMessages.json must not be the canonical provider projection ledger.
The messenger feature must verify visible reply persistence by deterministic message id before enqueueing provider outbox.
```

### 3.5 TeamMessageFeedService

`TeamMessageFeedService`:

- merges inbox messages, lead session messages and sent messages;
- dedupes by message id;
- can synthesize `relayOfMessageId` for passive user reply summaries by text/time;
- caches feed for up to 5 seconds;
- sorts by timestamp and message id.

Implication:

```text
TeamMessageFeedService is UI projection only.
It must never be used to decide provider send eligibility.
```

## 4. Storage Strategy Options

1. Single canonical MessengerStateStore plus side-effect sagas - 🎯 9   🛡️ 9   🧠 7, approx `1800-3600` LOC.
   Recommended MVP. No new dependency, fits current repo, gives one-file atomic updates for critical connector state, and makes side effects recoverable.

2. SQLite feature database with real transactions - 🎯 7   🛡️ 10   🧠 8, approx `2600-5200` LOC plus packaging work.
   Strongest technical storage model. Better for long-term scale, querying, and high message volume. Not ideal for first PR because `node:sqlite` is still experimental in the local Node line and `better-sqlite3` adds native Electron rebuild/package surface.

3. Many independent VersionedJsonStore files plus manifest/receipt recovery - 🎯 7   🛡️ 8   🧠 8, approx `2600-5200` LOC.
   Similar to the OpenCode runtime store manifest model. Works, but creates more recovery code than a single canonical feature store and still cannot make existing inbox/sent/provider side effects atomic.

Rejected shortcut:

🎯 3   🛡️ 4   🧠 3   Approx `500-1000` LOC

```text
Separate JSON files for processed-updates, runtime-turns, message-links and outbox with ad hoc write order.
```

This is too likely to lose route/link/outbox consistency under crash.

## 5. Recommended Canonical Store Shape

Use one file:

```text
teams/<team>/messenger-connectors/messenger-state.json
```

or one account-level file if connections span teams:

```text
messenger-connectors/state.json
```

MVP recommendation:

```text
One account-level canonical store partitioned by teamId/teamName/accountBindingId.
```

Reason:

- one shared official bot connection spans teams;
- one provider update may be setup/control traffic before a team is known;
- route bindings can be account-level;
- outbox and relay ACK state should not be split per team if the account binding is shared.

Logical tables inside the store:

```ts
interface MessengerCanonicalStateV1 {
  schemaVersion: 1;
  updatedAt: string;
  connections: MessengerConnectionRecord[];
  processedUpdates: ProcessedProviderUpdateRecord[];
  conversationBindings: ProviderConversationRouteBindingRecord[];
  routeTombstones: ProviderRouteTombstoneRecord[];
  provisionAttempts: ProvisionTopicAttemptRecord[];
  conversations: MessengerConversationRecord[];
  messageLinks: ExternalMessageLinkRecord[];
  runtimeTurns: MessengerRuntimeTurnRecord[];
  localProjectionEffects: LocalProjectionEffectRecord[];
  providerOutbox: ProviderOutboxRecord[];
  providerSendAttempts: ProviderSendAttemptRecord[];
  relayClaims: RelayClaimRecord[];
  repairTasks: MessengerRepairTaskRecord[];
}
```

Rules:

- every record has `id`, `createdAt`, `updatedAt`, and `schemaVersion`;
- every external event has a deterministic key;
- every local side effect has deterministic target message id;
- every provider send has a desktop-generated request id;
- every transition is idempotent by key and payload hash;
- no plaintext backend queue content is stored in backend metadata;
- local desktop store may store plaintext because it is the user's local app state.

## 6. Unit Of Work Boundaries

### 6.1 Inbound provider update admission

Atomic canonical update:

```text
insert ProcessedProviderUpdate
insert/update MessengerConversation inbound row
insert ExternalMessageLink for inbound provider message
insert route decision
insert MessengerRuntimeTurn pending if deliverable
```

Do not write:

```text
processed update only
```

without also writing the recoverable route/runtime state.

If route is blocked:

```text
insert ProcessedProviderUpdate
insert MessengerConversation inbound row
insert terminal/local status or repair task
```

### 6.2 Local team projection side effect

Before writing to existing team inbox/sent store:

```text
insert LocalProjectionEffect {
  id,
  targetKind,
  targetTeam,
  targetMember,
  targetMessageId,
  payloadHash,
  state: "pending"
}
```

Then perform side effect:

```text
write inbox/sent row with deterministic targetMessageId
read target file back
verify targetMessageId + payloadHash-compatible fields
mark LocalProjectionEffect committed
```

Recovery:

```text
pending effect:
  if target row exists and payload compatible -> committed
  if target row missing -> retry side effect
  if target row exists with same id but incompatible payload -> repair_required
```

### 6.3 Runtime stdin side effect

Before stdin write:

```text
runtimeTurn.state = "lead_turn_queued"
leadTurnGate lease is acquired
runtimeTurn.state = "stdin_write_started"
```

After stdin write callback:

```text
runtimeTurn.state = "stdin_write_completed"
```

After replay marker:

```text
runtimeTurn.state = "runtime_replay_observed"
```

After result/reply:

```text
runtimeTurn.state = "reply_observed" | "runtime_no_reply" | "runtime_error"
```

Recovery:

```text
stdin_write_started but no callback:
  retry if process is definitely alive and marker not observed, else ambiguous

stdin_write_completed but no replay/result:
  ambiguous_after_injection, no auto-reinject

runtime_replay_observed but no result:
  wait/recover if run is alive, else ambiguous_after_injection
```

### 6.4 Visible reply persistence side effect

Before writing local visible reply:

```text
insert LocalProjectionEffect for reply row
insert/update MessengerConversation outbound draft
```

After verification:

```text
mark reply projection committed
create/activate ExternalMessageLink for internal reply
enqueue ProviderOutbox item
```

Do not enqueue provider outbox before local reply is verified.

### 6.5 Provider send side effect

Before calling Telegram/backend:

```text
ProviderOutbox.state = "sending"
insert ProviderSendAttempt {
  requestId,
  payloadHash,
  startedAt,
  state: "started"
}
```

After success:

```text
ProviderSendAttempt.state = "succeeded"
ProviderOutbox.state = "sent"
store returned provider message ids
create ExternalMessageLink rows for each provider message id
```

After retryable pre-request error:

```text
ProviderSendAttempt.state = "failed_retryable"
ProviderOutbox.state = "queued"
```

After timeout or unknown-after-request-start:

```text
ProviderSendAttempt.state = "unknown"
ProviderOutbox.state = "ambiguous"
automatic drain skips it
manual repair required
```

## 7. Crash Matrix

### 7.1 Crash before ProcessedProviderUpdate commit

Telegram/backend can retry update.

Policy:

```text
Process normally.
```

### 7.2 Crash after ProcessedProviderUpdate but before runtime turn

This should be impossible if update admission is one canonical unit of work.

If detected through old schema:

```text
rebuild route/runtime state from MessengerConversation inbound row or mark repair_required.
```

### 7.3 Crash after local projection effect pending but before inbox write

Recovery:

```text
effect pending + target row missing -> retry write.
```

### 7.4 Crash after inbox write but before effect committed

Recovery:

```text
effect pending + target row exists with deterministic id -> mark committed.
```

### 7.5 Crash after stdin write completed but before replay

Recovery:

```text
mark ambiguous_after_injection unless transcript/replay observer later proves marker.
Do not auto-reinject.
```

### 7.6 Crash after replay observed but before result

Recovery:

```text
if run still alive -> keep waiting with timeout
if run gone -> ambiguous_after_injection
```

### 7.7 Crash after visible reply persisted but before outbox item

Recovery:

```text
reply projection committed + no outbox + ExternalMessageLink eligible -> enqueue outbox once.
```

### 7.8 Crash after outbox queued but before provider call

Recovery:

```text
outbox queued -> automatic drain can send.
```

### 7.9 Crash after provider call started but before result stored

Recovery:

```text
send attempt started with no terminal result -> provider_send_unknown.
Do not blind retry.
```

Official shared bot mode:

```text
ask backend result cache by desktop request id.
If cache says sent -> mark sent.
If cache says unknown -> keep ambiguous.
```

Own-bot mode:

```text
No Telegram idempotency key exists for sendMessage.
Keep ambiguous and require manual repair.
```

### 7.10 Crash after provider success but before message links

Recovery:

```text
if provider result cache or local success record has message ids -> create missing ExternalMessageLink rows.
if not -> ambiguous, no blind retry.
```

## 8. Dedupe Keys

Recommended deterministic ids:

```text
ProcessedProviderUpdate.id =
  provider + accountBindingId + botOrAppId + updateId

MessengerConversation inbound id =
  "in:" + ProviderMessageKey

LocalProjectionEffect.id =
  localEffectKind + targetStore + targetMessageId

MessengerRuntimeTurn.id =
  "runtime-turn:" + inboundConversationId + routeGeneration

ProviderOutbox.id =
  "outbox:" + localReplyConversationId + providerConnectionId

ProviderSendAttempt.id =
  ProviderOutbox.id + attemptNumber

ExternalMessageLink.id =
  "link:" + providerMessageKey or "link-local:" + localMessageId
```

Payload hash rules:

- hash canonical trusted metadata and text payload;
- store HMAC/digest for backend relay metadata, not plaintext;
- do not use hash alone as identity;
- never use provider text as idempotency key.

## 9. Why Existing App Stores Stay Side Effects

`inboxes/*.json` and `sentMessages.json` are user-facing app artifacts. They are necessary for current UI and team runtime compatibility.

But connector truth needs stronger invariants:

```text
Was this provider update already routed?
Was this provider message linked to a local reply?
Was this local reply already sent to Telegram?
Did a provider send maybe succeed?
```

Existing app stores cannot answer those questions reliably because:

- `sentMessages.json` is capped at 200 rows;
- sent-message persistence may log-and-swallow errors;
- `TeamMessageFeedService` can synthesize links by timing/text;
- UI cache can be stale for up to 5 seconds;
- lead session messages and live process messages can dedupe and merge;
- not all old inbox rows have stable explicit message ids.

Therefore:

```text
Existing stores are projection destinations and UI inputs.
MessengerStateStore is the provider-routing source of truth.
```

## 10. Repair States

Add explicit repair states instead of guessing:

```text
local_projection_missing
local_projection_payload_conflict
runtime_ambiguous_after_injection
runtime_replay_unmatched
runtime_result_unowned
provider_send_unknown
provider_message_link_missing
route_tombstoned_inbound
store_corrupt_quarantined
store_future_schema
```

Repair UI should show:

- what external message is affected;
- whether the lead may already have seen it;
- whether Telegram may already have received a reply;
- safe actions: retry local projection, mark handled, manual send, reconnect route, ignore.

Unsafe repair actions must be explicit:

```text
Force provider resend of ambiguous item.
Force runtime reinject after stdin_write_completed.
```

## 11. Compaction And Retention

Canonical state will grow. MVP retention:

```text
processedUpdates: keep 30 days or last 5000 per connection
providerSendAttempts: keep 90 days for ambiguous/failed, 30 days for sent
messageLinks: keep while related local message/outbox may be reply target
runtimeTurns: keep 30 days plus all unresolved
repairTasks: keep until resolved plus 30 days
```

Important:

```text
Do not delete ExternalMessageLink while a provider message can still be replied to.
```

For Telegram, no official fixed "user may reply after N days" contract is enough to trim aggressively. Keep link rows longer than processed update rows.

## 12. Store Migration Policy

Rules:

- core domain defines state transitions independent of storage;
- store adapter validates schema before use;
- future schema blocks startup of connector feature, not whole app;
- invalid store is quarantined and repair UI explains impact;
- migrations are append-only/backfill-friendly;
- never silently drop outbox ambiguous records during migration.

If moving to SQLite later:

```text
Write a StorePort adapter for SQLite.
Keep domain/use cases unchanged.
Add one migration command from JSON canonical store to SQLite tables.
```

## 13. Updated Implementation Sequence

Before Telegram E2E:

1. Add `MessengerCanonicalStateV1` domain schema.
2. Add `MessengerStateStorePort` in core application.
3. Add `VersionedJsonMessengerStateStore` as main infrastructure.
4. Implement `MessengerUnitOfWork` for atomic logical-table updates.
5. Add deterministic id builders and payload hash helpers.
6. Add `LocalProjectionEffect` state machine.
7. Add local projection verifier for inbox/sent rows.
8. Add recovery scanner on app startup and connection resume.
9. Add repair task creation for conflicts and ambiguous provider sends.
10. Only then wire Telegram inbound/outbox adapters.

## 14. Tests To Add

```text
test/main/features/messenger-connectors/
  messengerStateStore.test.ts
  messengerUnitOfWork.test.ts
  localProjectionEffect.test.ts
  localProjectionRecovery.test.ts
  providerOutboxRecovery.test.ts
  crashMatrixPolicy.test.ts
  repairTaskPolicy.test.ts
```

Must-pass cases:

1. Duplicate provider update with same payload returns existing route decision.
2. Duplicate provider update with same key but different payload becomes `payload_conflict`.
3. Inbound admission writes processed update, conversation, link and runtime turn in one unit.
4. Local projection pending plus missing target row retries.
5. Local projection pending plus existing matching row marks committed.
6. Local projection pending plus existing conflicting row creates repair task.
7. Reply projection committed plus missing outbox enqueues once.
8. Provider send started plus no result becomes ambiguous on recovery.
9. Ambiguous provider send is skipped by automatic drain.
10. Sent outbox missing message links recreates links from stored provider result.
11. Corrupt canonical store quarantines and blocks connector readiness only.
12. Future schema blocks connector readiness without deleting data.
13. Compaction never removes unresolved outbox/turn/repair rows.
14. `TeamMessageFeedService` synthesized `relayOfMessageId` is not accepted as provider proof.

## 15. Remaining Lowest-Confidence Points

1. Whether MVP should start with one canonical JSON store or SQLite - 🎯 8   🛡️ 9   🧠 7.
   Current recommendation is one canonical JSON store. SQLite is stronger but adds native/Electron risk.

2. Exact canonical store partitioning - 🎯 8   🛡️ 8   🧠 5.
   Account-level store is recommended because official bot account spans teams, but per-team data paths are simpler for backup/restore.

3. Local sent-message verification path - 🎯 7   🛡️ 8   🧠 5.
   Existing sent persistence may swallow errors. Need a read-back verifier that does not depend on `TeamMessageFeedService`.

4. Store compaction thresholds - 🎯 7   🛡️ 8   🧠 4.
   Need product decision on local history retention and repair audit retention.

5. Future SQLite migration - 🎯 7   🛡️ 9   🧠 7.
   Keep ports clean now so migration is storage-adapter work later.

## 16. Source Links

- SQLite transactional docs: https://www.sqlite.org/transactional.html
- SQLite WAL docs: https://www.sqlite.org/wal.html
- Node `node:sqlite` docs: https://nodejs.org/api/sqlite.html
- better-sqlite3 npm: https://www.npmjs.com/package/better-sqlite3
- sqlite3 npm: https://www.npmjs.com/package/sqlite3
