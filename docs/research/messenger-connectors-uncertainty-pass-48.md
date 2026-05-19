# Messenger Connectors - Uncertainty Pass 48

Date: 2026-04-30
Scope: official shared bot relay protocol, desktop ACK semantics, privacy boundary, relay auth, webhook retry behavior

## 1. Bottom Line

The weakest remaining product-critical area is the official shared bot relay.

The difficult part is this chain:

```text
Telegram webhook
-> backend sees plaintext transiently
-> backend sends plaintext claim to connected desktop
-> desktop durably commits local state
-> desktop ACK reaches backend
-> backend returns webhook 2xx
-> desktop starts local runtime
```

The strict rule stays:

```text
Desktop runtime must not start until backend accepts the local durable ACK.
```

New stronger rule from this pass:

```text
Once backend has dispatched plaintext to a desktop connection, the update is no longer "offline".
If ACK is missing, the state is claim_ack_missing or ambiguous_ownership.
Do not send an offline status for that provider update.
```

Recommended MVP relay:

🎯 8   🛡️ 9   🧠 8   Approx `3200-6200` LOC backend + desktop + tests

```text
SSE downlink in main process, HTTPS ACK uplink, no durable plaintext backend queue,
one in-flight plaintext claim per account binding, backend metadata-only claim ledger.
```

Rejected shortcut:

🎯 4   🛡️ 5   🧠 4   Approx `1000-2200` LOC

```text
Backend sends Telegram webhook 2xx immediately after writing to SSE socket.
```

Socket write is not local durable commit proof. It can lose messages on desktop crash, network split, or parser failure.

## 2. Official Facts Checked

### 2.1 Telegram webhook facts

Official Bot API facts:

- `getUpdates` and webhooks are mutually exclusive for one bot token.
- Telegram stores incoming updates until received, but not longer than 24 hours.
- Webhooks deliver HTTPS POST requests containing JSON-serialized `Update`.
- If webhook response is not 2xx, Telegram retries and eventually gives up after a reasonable number of attempts.
- `setWebhook.secret_token` causes Telegram to include `X-Telegram-Bot-Api-Secret-Token`.
- `secret_token` is 1-256 chars and allows `A-Z`, `a-z`, `0-9`, `_`, `-`.
- `max_connections` controls simultaneous webhook connections and supports 1-100, default 40.
- `allowed_updates` limits subscribed update types, but does not affect already-created updates immediately.
- `getWebhookInfo` exposes `pending_update_count`, last delivery error fields, `max_connections`, and `allowed_updates`.
- Inline Bot API calls in webhook responses do not return success/result to the app.

Implications:

```text
Use webhook secret_token.
Use narrow allowed_updates.
Do not use inline webhook Bot API responses for MVP sends.
Do not treat non-2xx retry as rare. It is part of the protocol.
```

### 2.2 SSE facts

WHATWG/MDN facts:

- SSE is one-way server-to-client.
- Events are `text/event-stream`.
- The browser `EventSource` reconnects and sends `Last-Event-ID` when reestablishing.
- `Last-Event-ID` is a resume cursor string, not delivery proof.
- Browser EventSource has connection limits on non-HTTP/2 origins.

Implications:

```text
Use main-process fetch stream plus eventsource-parser, not renderer EventSource.
Use Last-Event-ID only to resume metadata/control events.
Do not use it as proof that desktop committed plaintext.
```

### 2.3 Local desktop security facts

Existing local `HttpServer`:

- binds to `127.0.0.1` by default;
- serves renderer/API routes;
- has `/api/events` UI SSE with keepalive pings;
- is not designed for remote Telegram relay.

Existing `ApiKeyService`:

- uses Electron `safeStorage` when secure backend is available;
- rejects Linux `basic_text` as secure backend;
- falls back to AES-256-GCM with machine-derived key;
- stores with restrictive file permissions where possible.

Electron safeStorage facts:

- macOS uses Keychain semantics;
- Windows uses DPAPI semantics;
- Linux depends on available secret store;
- Linux `basic_text` is not secure and can be detected.

Implication:

```text
Relay credentials should reuse the same credential-vault pattern, but renderer must only see masked status.
```

## 3. Relay Entities

Provider update identity:

```text
ProviderUpdateKey =
  provider + accountBindingId + botUserId + updateId
```

Backend metadata-only records:

```ts
interface BackendRelayClaim {
  claimId: string;
  providerUpdateKey: string;
  accountBindingId: string;
  connectionId: string | null;
  state:
    | "received"
    | "dispatched"
    | "ack_accepted"
    | "ack_rejected_terminal"
    | "ack_missing"
    | "telegram_retry_wait"
    | "terminal_status_sent";
  payloadDigestHmac: string;
  createdAt: string;
  dispatchedAt: string | null;
  ackedAt: string | null;
  lastTelegramAttemptAt: string;
  reason: string | null;
}
```

Desktop canonical records:

```ts
interface DesktopRelayClaimRecord {
  claimId: string;
  providerUpdateKey: string;
  accountBindingId: string;
  providerPayloadHash: string;
  state:
    | "claim_received"
    | "local_prepared"
    | "ack_sent"
    | "ack_accepted"
    | "ack_rejected"
    | "runtime_queue_pending";
  localConversationId: string | null;
  runtimeTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Plaintext rules:

```text
Backend may hold plaintext only in request memory and active SSE write buffers.
Backend must not write plaintext update JSON, text, captions, file names, or raw payload to durable storage.
Desktop stores plaintext locally in the user's canonical MessengerStateStore.
```

## 4. Relay Protocol

### 4.1 Desktop connection

Desktop starts outbound connection:

```text
GET /v1/messenger/relay/events
Authorization: Bearer <short-lived relay access token>
X-Agent-Teams-Device-Id: <device id>
X-Agent-Teams-App-Version: <version>
Last-Event-ID: <last seen metadata event id, optional>
```

Backend responds with SSE:

```text
event: relay_hello
id: relay-event-...
data: {
  connectionId,
  serverTime,
  accountBindings,
  heartbeatIntervalMs,
  protocolVersion
}
```

Rules:

- one active relay connection per device id;
- one active owner per provider account binding;
- renderer does not open this stream;
- stream parser lives in main process;
- no bot token is exposed to desktop for official shared bot mode.

### 4.2 Telegram webhook admission

Backend webhook steps:

```text
1. Verify X-Telegram-Bot-Api-Secret-Token.
2. Parse Update and compute ProviderUpdateKey.
3. Check/update backend metadata claim ledger.
4. Resolve account binding and sender authorization.
5. If no connected desktop for binding, send offline/unsupported provider status and return 2xx.
6. If connected desktop exists, create claim and dispatch provider_update_claim SSE event.
7. Wait for desktop ACK until ack deadline.
8. If ACK accepted, return 2xx to Telegram.
9. If ACK missing, return non-2xx so Telegram retries.
```

Why non-2xx on ACK missing:

```text
No backend plaintext queue means backend cannot safely complete Telegram delivery
unless desktop proves local durable commit or backend sends a terminal status.
```

### 4.3 Provider update claim event

SSE event:

```text
event: provider_update_claim
id: relay-event-...
data: {
  protocolVersion,
  claimId,
  providerUpdateKey,
  accountBindingId,
  botUserId,
  receivedAt,
  payloadDigestHmac,
  update
}
```

The `update` field contains plaintext Telegram update data in transit to desktop.

Rules:

- backend does not log `update`;
- backend does not persist `update`;
- desktop must durably persist normalized local state before ACK;
- desktop ACK must include `payloadDigestHmac` or local digest evidence to prevent mismatched ACK.

### 4.4 Desktop ACK

ACK endpoint:

```text
POST /v1/messenger/relay/claims/{claimId}/ack
Authorization: Bearer <short-lived relay access token>
```

ACK body:

```ts
type RelayAckKind =
  | "local_prepared"
  | "duplicate_local"
  | "rejected_terminal"
  | "rejected_retryable"
  | "unsupported_update"
  | "busy_retryable";

interface RelayAckRequest {
  protocolVersion: 1;
  claimId: string;
  providerUpdateKey: string;
  ackKind: RelayAckKind;
  desktopReceiptId: string;
  localStateRevision: string;
  payloadDigestHmac: string;
  localConversationId?: string;
  runtimeTurnId?: string;
  reason?: string;
}
```

Backend response:

```ts
type RelayAckResponse =
  | { ok: true; state: "ack_accepted"; backendClaimRevision: string }
  | { ok: false; state: "ack_rejected"; reason: string; retryable: boolean };
```

Desktop rule:

```text
runtime_queue_pending is impossible before ACK response ok=true.
```

### 4.5 Duplicate Telegram retry

If Telegram retries the same `ProviderUpdateKey`:

```text
backend sees existing claim metadata
backend sends provider_update_claim_duplicate to active desktop if needed
desktop checks MessengerStateStore by ProviderUpdateKey
if local_prepared exists with same digest, desktop sends duplicate_local ACK
backend returns 2xx
```

If no desktop is connected and backend has existing `dispatched` but no ACK:

```text
backend must not send offline status
backend returns non-2xx until retry budget / policy expires
backend keeps metadata-only ambiguous state
```

This is the unavoidable weak point without a backend plaintext or encrypted queue.

## 5. Timeout Policy

Recommended MVP defaults:

```text
desktop claim local prepare deadline: 3000-5000 ms
backend webhook ACK wait deadline: 7000-9000 ms
SSE heartbeat interval: 15000-30000 ms
relay connection stale timeout: 2 missed heartbeats + transport close
claim_ack_missing UI warning: immediately after backend reports it or desktop sees ack timeout
```

Top timeout options:

1. Short ACK wait, Telegram retry on missing ACK - 🎯 8   🛡️ 9   🧠 6, approx `600-1200` LOC.
   Recommended. Preserves no-plaintext-queue invariant and lets Telegram retry if desktop did not commit.

2. Long ACK wait to reduce retries - 🎯 6   🛡️ 7   🧠 5, approx `500-1000` LOC.
   More likely to hit infrastructure/webhook timeouts and tie up backend workers.

3. Return 2xx after SSE socket write - 🎯 4   🛡️ 5   🧠 4, approx `300-700` LOC.
   Reject. It trades away delivery safety for lower retry noise.

## 6. Concurrency And Backpressure

Telegram `max_connections` default is 40. For a shared bot, global `max_connections=1` is too limiting if multiple users exist.

Recommended:

🎯 8   🛡️ 9   🧠 7   Approx `700-1600` LOC

```text
Backend may accept multiple webhook requests globally, but serializes plaintext claims per accountBindingId.
```

Per-binding policy:

```text
one in-flight provider_update_claim per accountBindingId
next update for same binding waits only in request memory up to deadline
if busy beyond deadline, return non-2xx for Telegram retry
```

Global policy:

```text
setWebhook max_connections: start with 10 or 20, not 40, then tune
allowed_updates: message, edited_message, callback_query, my_chat_member
```

Do not use:

```text
durable backend plaintext queue
unbounded in-memory queue
per-team Telegram webhook owner
```

## 7. Auth And Credential Model

### 7.1 Desktop relay credentials

Recommended:

🎯 8   🛡️ 9   🧠 7   Approx `1200-2600` LOC

```text
Device-bound relay credential stored locally with safeStorage/AES-local fallback,
exchanged for short-lived access tokens used by SSE and ACK calls.
```

Credential records:

```ts
interface RelayDeviceCredential {
  deviceId: string;
  accountId: string;
  refreshSecretEncrypted: string;
  encryptionMethod: "safeStorage" | "aes-local";
  createdAt: string;
  rotatedAt: string;
  revokedAt: string | null;
}
```

Rules:

- renderer sees connected/masked status only;
- main process owns decrypted credential;
- access token TTL is short;
- refresh token rotation is supported;
- logout/revoke deletes local credential and server device session;
- backend stores token hashes, not token plaintext.

### 7.2 Top auth options

1. Device credential + short-lived access token - 🎯 8   🛡️ 9   🧠 7, approx `1200-2600` LOC.
   Best MVP security shape without mTLS.

2. Long-lived static relay token - 🎯 6   🛡️ 6   🧠 4, approx `500-1000` LOC.
   Easier but weak revocation and larger blast radius if copied from disk.

3. Unauthenticated local pairing code in URL only - 🎯 3   🛡️ 3   🧠 3, approx `300-700` LOC.
   Reject. Too easy to leak through logs/browser/history.

## 8. Privacy Boundary

Shared official bot privacy story:

```text
Backend sees plaintext transiently because Telegram delivers webhook plaintext to our backend.
Backend must not durably store plaintext.
Desktop stores plaintext locally because it is the user's chosen local app state.
```

Backend durable allowed:

```text
ProviderUpdateKey
claimId
connectionId
accountBindingId
state
timestamps
HMAC payload digest
Telegram status message ids
error/reason codes
provider method names
payload byte length bucket
```

Backend durable forbidden:

```text
raw Telegram update JSON
message text
caption
file names
contact data
location data
plain payload hash
bot token
desktop refresh token plaintext
```

Logging rules:

- structured logs must whitelist fields;
- default error serializer must redact `update`, `text`, `caption`, `token`, `authorization`;
- provider request/response bodies are never logged;
- crash reports include claim ids and reason codes only.

## 9. Failure Matrix

### 9.1 No desktop connected

Policy:

```text
send Telegram status: desktop offline
persist provider status message id
return webhook 2xx
```

### 9.2 Desktop connected, claim dispatch fails before bytes are written

Policy:

```text
return non-2xx
Telegram retries
claim state: dispatch_failed_retryable
```

### 9.3 Claim bytes written, no ACK

Policy:

```text
claim_ack_missing
return non-2xx
do not send offline status
do not start desktop runtime unless desktop later receives ack_accepted
```

### 9.4 Desktop commits local state, ACK request fails

Policy:

```text
desktop keeps local_prepared/ack_pending
desktop retries ACK while token/session valid
runtime still waits
Telegram retry can produce duplicate claim
desktop answers duplicate_local ACK
```

### 9.5 Backend accepts ACK, response lost to desktop

Policy:

```text
desktop can GET claim status by claimId
if backend says ack_accepted, desktop transitions to runtime_queue_pending
```

### 9.6 Backend accepts ACK, crashes before returning 2xx to Telegram

Policy:

```text
Telegram retries
backend claim ledger says ack_accepted
backend returns 2xx for duplicate retry
desktop does not reprocess
```

### 9.7 Telegram retries after desktop already processed

Policy:

```text
desktop duplicate_local ACK
no second runtime turn
no second provider outbox item
```

### 9.8 Backend sent status offline, then desktop reconnects

Policy:

```text
status is terminal for that provider update
desktop does not process old update
future user message works normally
```

### 9.9 User blocks bot

Policy:

```text
my_chat_member update or sendMessage 403 marks route blocked
desktop shows reconnect/blocked status
no retry loop
```

## 10. Result Caches For Official Bot Sends

Official shared bot mode means desktop does not have the bot token. Backend sends Telegram messages on desktop request.

Required request:

```ts
interface OfficialProviderSendRequest {
  requestId: string;
  accountBindingId: string;
  providerConversationKey: string;
  outboxItemId: string;
  payloadDigestHmac: string;
  text: string;
  replyToProviderMessageKey?: string;
}
```

Backend cache:

```ts
interface OfficialProviderSendResultCacheRecord {
  requestId: string;
  accountBindingId: string;
  outboxItemId: string;
  state: "in_flight" | "sent" | "failed_terminal" | "unknown";
  providerMessageKeys: string[];
  errorCode: string | null;
  payloadDigestHmac: string;
  createdAt: string;
  updatedAt: string;
}
```

Rules:

- backend persists `in_flight` before Telegram call;
- backend persists `sent` with message ids before responding success;
- if Telegram success may have happened but cache write failed, mark `unknown`;
- duplicate requestId returns cached result;
- desktop never blind-retries `unknown`.

## 11. Backend Sender Identity Gate

Backend must gate before dispatching plaintext to desktop:

```text
provider account binding exists
Telegram sender id matches allowed account identity
chat id matches expected user/private chat where required
message is not from our bot
route is active or setup/control eligible
```

If sender identity fails:

```text
do not dispatch plaintext to desktop
optionally send provider-visible unauthorized/help message
return 2xx
```

Reason:

```text
The desktop should not receive arbitrary Telegram messages sent to the shared bot.
```

## 12. Tests To Add

```text
test/main/features/messenger-connectors/
  officialRelayProtocol.test.ts
  officialRelayAckStateMachine.test.ts
  officialRelayDuplicateRetry.test.ts
  officialRelayPrivacyRedaction.test.ts
  officialRelayCredentialStore.test.ts
  officialProviderSendResultCache.test.ts
```

Backend contract tests:

```text
backend/test/messenger-relay/
  telegramWebhookSecret.test.ts
  telegramWebhookAckDeadline.test.ts
  relayClaimLedger.test.ts
  relayConnectionOwnership.test.ts
  noPlaintextPersistence.test.ts
  officialSendResultCache.test.ts
```

Must-pass cases:

1. No desktop connected sends offline status and returns 2xx.
2. Connected desktop with local_prepared ACK returns webhook 2xx.
3. Claim write succeeds but ACK missing returns non-2xx.
4. Duplicate Telegram retry after local_prepared returns duplicate_local ACK and 2xx.
5. ACK missing never sends offline status.
6. Backend logs do not include update text/caption/raw JSON.
7. Renderer cannot access relay token or plaintext provider update.
8. Unauthorized Telegram sender is rejected before desktop dispatch.
9. Backend duplicate send requestId returns cached provider result.
10. Provider send in_flight with unknown result is not auto-retried.
11. SSE Last-Event-ID resumes metadata only and does not mark claim delivered.
12. Desktop runtime does not start before ack_accepted.

## 13. Remaining Lowest-Confidence Points

1. Exact webhook ACK deadline that balances Telegram retry behavior and desktop local commit latency - 🎯 7   🛡️ 8   🧠 5.
   Need staging metrics with real Telegram webhook delivery.

2. Backend metadata ledger retention - 🎯 7   🛡️ 8   🧠 5.
   Need retention that supports duplicate retries and audits without becoming a user-message shadow store.

3. Per-binding serialization under high shared-bot traffic - 🎯 7   🛡️ 8   🧠 7.
   Need load tests because max_connections 10/20 with per-binding locks is a design hypothesis.

4. Exact device credential issuance UX - 🎯 7   🛡️ 9   🧠 6.
   Need product flow for sign-in, pairing, revocation and multiple desktops.

5. Claim ACK missing UX - 🎯 7   🛡️ 8   🧠 6.
   Need clear copy because "offline" is wrong after plaintext was dispatched.

## 14. Source Links

- Telegram Bot API `setWebhook`: https://core.telegram.org/bots/api#setwebhook
- Telegram Bot API `getWebhookInfo`: https://core.telegram.org/bots/api#getwebhookinfo
- Telegram Bot API updates: https://core.telegram.org/bots/api#getting-updates
- WHATWG server-sent events: https://html.spec.whatwg.org/dev/server-sent-events.html
- MDN server-sent events guide: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- eventsource-parser npm: https://www.npmjs.com/package/eventsource-parser
