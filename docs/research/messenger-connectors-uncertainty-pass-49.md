# Messenger Connectors - Uncertainty Pass 49

Date: 2026-04-30
Scope: webhook ACK deadline, bounded retry policy, per-binding backpressure, claim-ledger retention, relay credential UX, claim ACK missing product states

## 1. Bottom Line

The weakest remaining point is no longer the basic relay shape. It is the operational policy around a missed desktop ACK:

```text
backend dispatched plaintext to desktop
desktop ACK did not reach backend in time
Telegram will retry non-2xx webhook responses
shared bot must not let one binding poison global delivery
desktop must not start runtime until ack_accepted
user must not be told the app was offline after plaintext was dispatched
```

The new recommendation:

🎯 8   🛡️ 9   🧠 8   Approx `1800-3600` LOC on top of pass 48

```text
Use bounded Telegram retry for ACK-missing claims:
return non-2xx for a small retry budget, then send a terminal
"delivery unconfirmed" provider status and return 2xx.
```

This keeps the no-plaintext-backend-queue invariant without allowing an ambiguous claim to clog the shared bot forever.

Strongest current invariant:

```text
offline is only valid before plaintext dispatch.
after plaintext dispatch, missing ACK means unconfirmed delivery, not offline.
```

## 2. Official Facts Rechecked

### 2.1 Telegram webhook facts

Official facts from Telegram Bot API:

- `getUpdates` and webhooks are mutually exclusive for one bot token.
- Telegram stores incoming updates until received, but not longer than 24 hours.
- Webhooks send HTTPS POST with JSON-serialized `Update`.
- Non-2xx webhook response causes Telegram to repeat the request and later give up after a reasonable number of attempts.
- `setWebhook.max_connections` is 1-100 and defaults to 40.
- Lower `max_connections` limits server load; higher values increase throughput.
- `allowed_updates` does not immediately filter updates that already existed before `setWebhook`.
- `getWebhookInfo` exposes `pending_update_count`, `last_error_date`, `last_error_message`, `max_connections`, and `allowed_updates`.
- Telegram does not document exact webhook response timeout or exact retry schedule in the Bot API page.

Implication:

```text
Exact ACK deadline must be a product/runtime config backed by staging metrics,
not a hardcoded claim about Telegram internals.
```

### 2.2 OAuth device authorization facts

RFC 8628 facts:

- Device authorization flow issues `device_code`, `user_code`, and `verification_uri`.
- The device polls while the user approves in a browser.
- `verification_uri_complete` can reduce manual typing, including QR/deep link presentation.
- The user code should remain visible to mitigate authorizing the wrong device.
- Codes have finite lifetime and polling has pending/slow-down/expired outcomes.

Implication:

```text
Relay credential setup should use a device-code style flow if the app does not
already have a robust desktop deep-link or localhost callback auth flow.
```

### 2.3 Logging and telemetry facts

OWASP logging guidance explicitly excludes sensitive values such as access tokens, PII, passwords, database strings, encryption keys and primary secrets from logs.

OpenTelemetry semantic conventions are useful for consistent trace/metric names, but sensitive fields must be called out and avoided.

Implication:

```text
Messenger relay observability should be metric/claim-id based.
No provider text, caption, raw update, token or auth header should enter logs,
traces, exception payloads or support bundles.
```

### 2.4 Local architecture facts

`docs/FEATURE_ARCHITECTURE_STANDARD.md` confirms this feature needs the full slice:

```text
contracts/
core/domain/
core/application/
main/
preload/
renderer/
```

Reasons:

- multiple process boundaries;
- provider-neutral business rules;
- transport adapters;
- credential storage;
- durable state;
- renderer health and repair UI.

Local team messaging risk:

- Direct live lead sends can deliver to stdin and then persist best-effort.
- Existing inbox/sent stores are not enough for provider-grade delivery proof.
- Messenger connector must keep its own canonical state and treat existing stores as projections.

## 3. Bounded Retry Policy

### 3.1 The problem

If backend returns non-2xx forever for `claim_ack_missing`, Telegram will keep retrying until its own undocumented give-up policy. For shared bot mode this can create:

- growing `pending_update_count`;
- repeated duplicate webhook attempts;
- wasted webhook connections;
- confusing user experience;
- possible starvation if many bindings are ambiguous at once.

If backend returns 2xx immediately after SSE write, desktop can lose the message before local commit.

Therefore the policy must sit in the middle:

```text
retry briefly to recover transient ACK loss
then stop provider retry with a truthful terminal status
```

### 3.2 Recommended MVP retry budget

Recommended default:

🎯 8   🛡️ 8   🧠 6   Approx `800-1500` LOC

```text
For a claim dispatched to desktop but not ACKed:

attempt 1:
  wait up to ackWaitMs, default 8000 ms
  if no ACK, return non-2xx

attempt 2..N:
  if desktop is connected, redispatch duplicate claim metadata/plaintext
  wait up to ackWaitMs
  if duplicate_local/local_prepared ACK arrives, return 2xx

terminal budget:
  maxTelegramAttemptsForClaim: 3
  maxUnconfirmedWindowMs: 120000
  after either budget expires, send provider status "delivery unconfirmed"
  return 2xx
```

Important:

```text
Terminal "delivery unconfirmed" is not "offline".
It means the backend sent the message toward desktop but did not receive durable commit proof.
```

### 3.3 Top 3 retry options

1. Bounded retry then terminal delivery-unconfirmed - 🎯 8   🛡️ 8   🧠 6, approx `800-1500` LOC.
   Best MVP balance. Keeps no plaintext queue, gives transient ACK loss a chance, then prevents shared-bot backlog.

2. Non-2xx until Telegram gives up - 🎯 5   🛡️ 6   🧠 4, approx `350-800` LOC.
   Simple but too dependent on undocumented Telegram retry timing and can hurt other users of the shared bot.

3. Immediate 2xx after first ACK miss with status - 🎯 6   🛡️ 7   🧠 5, approx `500-1000` LOC.
   Avoids backlog but loses recovery chance for the common case where desktop committed locally and ACK response failed.

## 4. ACK Deadline Envelope

Because Telegram does not publish exact webhook response deadline, the deadline should be tunable and measured.

Recommended initial config:

```ts
interface RelayDeadlineConfig {
  desktopLocalPrepareTargetMs: 1500;
  desktopLocalPrepareHardMs: 3000;
  backendAckWaitMs: 8000;
  backendAckWaitMinMs: 5000;
  backendAckWaitMaxMs: 9000;
  maxTelegramAttemptsForClaim: 3;
  maxUnconfirmedWindowMs: 120000;
  relayHeartbeatMs: 15000;
  relayStaleAfterMissedHeartbeats: 2;
}
```

Budget target:

```text
webhook admission and auth: < 50 ms p95
metadata claim persist: < 100 ms p95
claim lane wait for same binding: < 500 ms p95
SSE dispatch write: < 200 ms p95
desktop local prepare: < 1500 ms p95, 3000 ms hard cap
ACK HTTP round trip: < 500 ms p95
backend total ACK wait: 8000 ms default
```

Hard rule:

```text
Never wait for agent runtime reply inside the Telegram webhook request.
Webhook ACK only proves durable local admission, not task completion.
```

Staging harness:

```text
1. Connect real Telegram webhook to staging backend.
2. Simulate desktop local prepare delays: 0 ms, 500 ms, 1500 ms, 3000 ms, 6000 ms, 9000 ms.
3. Force ACK loss after local prepare.
4. Force backend crash after ACK accept before Telegram 2xx.
5. Measure retry intervals, pending_update_count and last_error_message.
6. Tune ackWaitMs and max attempts from observed behavior.
```

## 5. Claim Ledger Retention

### 5.1 Split provider update from webhook attempt

Do not model one claim as one Telegram HTTP request. Telegram retries the same provider update.

Recommended backend metadata model:

```ts
interface RelayProviderUpdateRecord {
  providerUpdateKey: string;
  accountBindingId: string;
  botUserId: string;
  state:
    | "received"
    | "dispatched"
    | "ack_accepted"
    | "terminal_offline"
    | "terminal_unsupported"
    | "terminal_delivery_unconfirmed"
    | "repair_required";
  activeClaimId: string | null;
  payloadDigestHmac: string;
  firstReceivedAt: string;
  lastAttemptAt: string;
  terminalAt: string | null;
  attemptCount: number;
}

interface RelayWebhookAttemptRecord {
  attemptId: string;
  providerUpdateKey: string;
  claimId: string | null;
  state:
    | "admitted"
    | "sender_rejected"
    | "dispatched"
    | "ack_wait_timeout"
    | "ack_accepted"
    | "terminal_status_sent"
    | "failed_before_dispatch";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  httpResultClass: "2xx" | "non_2xx" | null;
  reasonCode: string | null;
}
```

This lets us dedupe by `providerUpdateKey` while still measuring retry attempts.

### 5.2 Retention recommendation

MVP defaults:

🎯 7   🛡️ 8   🧠 5   Approx `400-900` LOC

```text
ack_accepted / terminal_offline / terminal_unsupported:
  keep hot metadata for 7 days

terminal_delivery_unconfirmed / repair_required:
  keep hot metadata for 30 days or until user resolves repair

device credential audit events:
  keep metadata for 90 days

aggregate metrics:
  keep 180 days with no account/user/provider payload identifiers
```

Compaction rule:

```text
Never compact unresolved records that can still prevent duplicate runtime turns,
ambiguous sends, repair tasks, or credential-revocation audit.
```

Privacy rule:

```text
Retention extends only metadata lifetime.
It must not introduce raw Telegram updates, text, captions, file names,
contact data, location data, provider bodies or token plaintext.
```

## 6. Per-Binding Backpressure

### 6.1 Recommended lane model

Use a feature-owned `AccountBindingClaimLane` in the backend:

```ts
interface AccountBindingClaimLane {
  accountBindingId: string;
  activeProviderUpdateKey: string | null;
  activeClaimId: string | null;
  waitingAttemptIds: string[];
  state: "idle" | "dispatching" | "waiting_ack" | "terminalizing";
}
```

Rules:

- one plaintext claim in flight per `accountBindingId`;
- global Telegram webhook concurrency can be 10 or 20 at first;
- same-binding extra attempts wait only in request memory;
- if lane wait exceeds `sameBindingWaitMs`, return non-2xx for retry;
- no unbounded in-memory queue;
- no durable plaintext queue.

Recommended initial values:

```text
setWebhook.max_connections: 10
sameBindingWaitMs: 1000-2000
globalActiveClaimsSoftLimit: backend capacity dependent
perAccountBindingActiveClaims: 1
```

Why `max_connections=10` first:

```text
Telegram default 40 optimizes throughput, but this feature intentionally waits
for desktop ACK inside the webhook request. Starting lower reduces worker pressure
while we gather real ACK latency metrics.
```

### 6.2 Top 3 lane implementations

1. Feature-owned per-binding lane map - 🎯 8   🛡️ 9   🧠 6, approx `700-1500` LOC.
   Recommended. Small enough to audit, no dependency semantics hidden around plaintext ownership.

2. `p-queue` per binding - 🎯 7   🛡️ 8   🧠 5, approx `500-1100` LOC.
   `p-queue` is fresh and MIT (`9.2.0`, checked 2026-04-30), but it still needs our own no-plaintext and cancellation policy.

3. Redis/BullMQ-style durable queue - 🎯 5   🛡️ 8   🧠 9, approx `3000-7000` LOC.
   Good for scale later only if payloads are end-to-end encrypted for desktop. Not MVP because it conflicts with no plaintext backend queue.

Library checks:

```text
p-queue: 9.2.0, MIT, modified 2026-04-27
bottleneck: 2.19.5, MIT, modified 2023-02-22
async-mutex: 0.5.0, MIT, modified 2024-03-11
rate-limiter-flexible: 11.0.1, ISC, modified 2026-04-18
```

Recommendation:

```text
Do not add a queue library for MVP lanes.
Use a small feature-owned lane object and tests.
Use `p-queue` later only for generic non-plaintext background jobs.
```

## 7. Relay Credential UX

### 7.1 Recommended setup flow

Recommended default:

🎯 8   🛡️ 9   🧠 6   Approx `1200-2400` LOC

```text
Device-code style pairing:
desktop asks backend for device authorization
desktop opens verification_uri_complete in browser when available
desktop also shows user_code
user approves the named desktop/device in browser
desktop polls until backend issues relay refresh credential
main process stores credential in vault
renderer sees masked connected status only
```

Why this is better than manual token paste:

- no long secret is copied through clipboard;
- revocation and rotation are server-owned;
- works without public localhost callback;
- works even if desktop deep links are not registered;
- can be made one-click by opening `verification_uri_complete`.

### 7.2 Top 3 relay credential setup options

1. Device-code flow with `verification_uri_complete` - 🎯 8   🛡️ 9   🧠 6, approx `1200-2400` LOC.
   Best default if we want robust cross-platform setup with minimal local networking assumptions.

2. Authorization Code + PKCE with localhost callback or app deep link - 🎯 7   🛡️ 9   🧠 7, approx `1800-3400` LOC.
   Better one-click UX when desktop callback/deep-link infra is already mature. More platform-specific edge cases.

3. Manual relay token paste - 🎯 4   🛡️ 5   🧠 3, approx `300-700` LOC.
   Reject for default. Too easy to leak through clipboard, screenshots, logs and support flows.

### 7.3 Credential states

```text
unpaired
-> pairing_requested
-> waiting_user_approval
-> credential_issued
-> connected

connected
-> token_refreshing
-> connected

connected
-> revoked

connected
-> credential_invalid
```

Hard rules:

- main process owns decrypted relay credential;
- renderer never receives refresh secret or access token;
- access tokens are short-lived;
- refresh secret rotation is supported;
- logout revokes server-side device session and deletes local credential;
- device list UI can revoke old desktops;
- pairing screen names the account, device label and approximate location when available.

## 8. Claim ACK Missing UX

### 8.1 Provider-visible copy classes

Do not over-explain internal mechanics in Telegram, but do not lie.

Provider statuses:

```text
desktop_offline:
  "Desktop app is offline. Open Agent Teams on your computer, then send again."

delivery_unconfirmed:
  "I could not confirm that Agent Teams saved this message. Open the desktop app to check delivery status."

team_not_ready:
  "This team is not ready for Telegram messages right now. Open Agent Teams to repair the connection."

unauthorized_sender:
  "This Telegram account is not connected to this Agent Teams workspace."
```

Rules:

- `desktop_offline` only before plaintext dispatch;
- `delivery_unconfirmed` after dispatch without ACK;
- never tell the user the lead is thinking until desktop has `ack_accepted` and runtime turn is queued;
- do not ask the user to resend after `delivery_unconfirmed` unless desktop repair confirms the old update was not locally stored.

### 8.2 Desktop UI states

Renderer should receive only metadata:

```ts
type MessengerRelayHealth =
  | { state: "connected"; lastHeartbeatAt: string }
  | { state: "offline"; since: string }
  | { state: "degraded"; reason: "ack_latency" | "provider_retry_pressure" }
  | { state: "repair_required"; reason: "delivery_unconfirmed" | "credential_invalid" };
```

Repair actions:

```text
Reconnect relay
Retry ACK for locally prepared claims
Mark provider update lost only when no local prepared row exists
Open route details
Revoke device
```

Do not show:

- raw Telegram text in health banner;
- bot token;
- relay access token;
- raw provider update JSON;
- backend log snippets with user content.

## 9. Observability Without Plaintext

Minimum metrics:

```text
messenger.relay.claims_received_total
messenger.relay.claims_dispatched_total
messenger.relay.acks_accepted_total
messenger.relay.acks_missing_total
messenger.relay.delivery_unconfirmed_total
messenger.relay.duplicate_local_acks_total
messenger.relay.unauthorized_sender_total
messenger.relay.provider_pending_update_count
messenger.relay.ack_wait_ms
messenger.relay.desktop_prepare_ms
messenger.relay.same_binding_lane_wait_ms
messenger.relay.webhook_attempts_per_update
```

Allowed dimensions:

```text
provider
providerMode
reasonCode
claimState
ackKind
routeMode
appVersion
```

Forbidden dimensions:

```text
message text
caption
file name
chat title
display name
username
phone
email
raw update id without HMAC/account scoping
token or auth header
```

Trace rule:

```text
Use claimId/providerUpdateKey HMAC for correlation.
Never attach `update`, `message`, `caption`, `from`, `chat`, `authorization`, `token`
or provider request/response bodies to spans/logs.
```

## 10. New Tests From This Pass

Backend tests:

```text
boundedRetry.ackMissingFirstAttemptReturnsNon2xx
boundedRetry.ackMissingBudgetExpiredSendsDeliveryUnconfirmedAndReturns2xx
boundedRetry.neverSendsOfflineAfterDispatch
boundedRetry.duplicateLocalAckClearsRetry
claimLedger.providerUpdateRecordSurvivesMultipleWebhookAttempts
claimLedger.compactionKeepsUnresolvedRecords
claimLane.serializesSameBinding
claimLane.allowsDifferentBindingsConcurrently
relayCredential.deviceCodePollingStates
relayCredential.rendererNeverReceivesSecrets
relayTelemetry.redactsForbiddenFields
```

Desktop tests:

```text
relayClient.localPrepareDeadline
relayClient.ackRetryAfterNetworkFailure
relayClient.duplicateClaimUsesExistingLocalPrepared
relayClient.runtimeDoesNotStartBeforeAckAccepted
relayHealth.deliveryUnconfirmedRepairModel
```

Staging tests:

```text
realTelegramWebhook.ackDelayMatrix
realTelegramWebhook.non2xxRetryIntervals
realTelegramWebhook.pendingUpdateCountUnderAmbiguousClaims
realTelegramWebhook.maxConnections10Vs20
```

## 11. Updated Lowest-Confidence Points

1. Exact Telegram webhook retry timing - 🎯 6   🛡️ 8   🧠 5.
   Official docs do not publish exact schedule. Need staging measurement.

2. Bounded retry budget constants - 🎯 7   🛡️ 8   🧠 5.
   Recommendation is 3 attempts or 120 seconds, but this must be tuned from real retry intervals.

3. Delivery-unconfirmed UX - 🎯 7   🛡️ 8   🧠 6.
   Technically clear, but product copy needs testing so users do not blindly resend duplicates.

4. Per-binding lane behavior under high shared-bot traffic - 🎯 7   🛡️ 8   🧠 7.
   Design is solid, but load tests are required because webhook requests wait for ACK.

5. Device credential setup UX - 🎯 8   🛡️ 9   🧠 6.
   RFC-backed shape is clear. Exact app/account UI depends on our backend account system.

6. Metadata retention defaults - 🎯 7   🛡️ 8   🧠 5.
   Safe defaults are proposed, but final values should match support/audit needs and privacy policy.

## 12. Source Links

- Telegram Bot API getting updates: https://core.telegram.org/bots/api#getting-updates
- Telegram Bot API `setWebhook`: https://core.telegram.org/bots/api#setwebhook
- Telegram Bot API `getWebhookInfo`: https://core.telegram.org/bots/api#getwebhookinfo
- RFC 8628 OAuth 2.0 Device Authorization Grant: https://datatracker.ietf.org/doc/html/rfc8628
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- OpenTelemetry Semantic Conventions: https://opentelemetry.io/docs/concepts/semantic-conventions/
- p-queue npm: https://www.npmjs.com/package/p-queue
- bottleneck npm: https://www.npmjs.com/package/bottleneck
- async-mutex npm: https://www.npmjs.com/package/async-mutex
- rate-limiter-flexible npm: https://www.npmjs.com/package/rate-limiter-flexible
