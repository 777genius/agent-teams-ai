# Messenger Connectors - Uncertainty Pass 38

Date: 2026-04-29
Scope: official shared bot relay, webhook ACK gates, desktop online semantics, no plaintext backend queue, and inbound ownership ambiguity

## Executive Delta

The weakest area after pass 37 is the official shared bot relay:

```text
Telegram webhook
-> our backend
-> connected desktop app
-> local durable commit
-> backend ACK decision
-> later runtime turn and Telegram reply projection
```

The hard part is not transport syntax. The hard part is the ACK contract:

```text
Telegram update must be considered accepted only after the desktop durably owns it,
or after the backend has sent a terminal provider-visible status such as offline or unsupported.
```

New important distinction:

```text
No connected desktop at webhook start = offline.
Claim sent to desktop but local commit ACK missing = ambiguous ownership, not offline.
```

If we collapse those states, we can create a bad user-visible race:

```text
desktop commits inbound locally
ACK is lost
backend says "desktop offline"
agent later replies from local commit
Telegram user sees contradictory messages
```

## Source Facts Rechecked

Telegram official facts checked on 2026-04-29:

- Telegram has two mutually exclusive update modes: `getUpdates` and webhooks.
- Incoming updates are stored until received, but not longer than 24 hours.
- `Update.update_id` is useful for ignoring repeated updates and restoring order if webhooks are out of order.
- `getUpdates` confirms updates by requesting an offset higher than the update id.
- Webhook setup supports `secret_token`, delivered through `X-Telegram-Bot-Api-Secret-Token`.
- `setWebhook.max_connections` defaults to 40 and can be lowered.
- `getWebhookInfo` exposes `pending_update_count`, last webhook errors, max connections, and allowed updates.
- Direct Bot API calls in webhook responses do not return success/result to the app.
- Telegram FAQ says replying directly to webhook updates has the downside that success/result is unknowable.
- Telegram FAQ says bot broadcast limits include roughly one message per second in a single chat and 429 may happen.

Sources:

- https://core.telegram.org/bots/api#getting-updates
- https://core.telegram.org/bots/api#getupdates
- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#getwebhookinfo
- https://core.telegram.org/bots/api#making-requests-when-getting-updates
- https://core.telegram.org/bots/faq

Package checks from npm registry on 2026-04-29:

- `@fastify/websocket` 11.2.0, MIT, modified 2026-03-05.
- `eventsource-parser` 3.0.8, MIT, modified 2026-04-19.
- `ws` 8.20.0, MIT, modified 2026-03-21.

Implications:

```text
Do not use inline webhook Bot API responses for any message where we need provider Message id.
Use explicit sendMessage calls through provider outbox.
Use webhook secret verification on backend.
Lower max_connections if per-bot ordering/backpressure is more important than throughput.
Model 429/rate limits even for status messages.
```

## Local Code Facts Rechecked

Existing app server:

- `HttpServer` is Fastify-based.
- It binds to `127.0.0.1` by default.
- It serves local API routes and renderer/static output.
- `events.ts` provides local SSE at `/api/events`.
- SSE clients are in-memory `FastifyReply` objects.
- Broadcast is one-way local UI/event fanout.
- Current route registration is local app/sidecar oriented, not public relay oriented.

Important implication:

```text
The official Telegram bot should not require a locally reachable desktop server.
Desktop must initiate an outbound connection to our backend.
```

Why:

- Users are behind NAT, firewalls, sleeping laptops, and changing networks.
- The current local `HttpServer` is intentionally localhost-only.
- Exposing it publicly would create a new security surface and bad UX.

Existing useful local patterns:

- Feature-slice architecture standard supports a main adapter for relay input.
- `VersionedJsonStore` pattern is suitable for local `ProcessedProviderUpdate`, conversation, and turn stores.
- Existing local SSE route proves the app already accepts event-stream style infrastructure, but it is not a reliability ledger.

## Official Relay Invariants

These are stricter than normal chat app relay rules because we promised no plaintext backend queue.

### Invariant 1: Desktop-initiated only

```text
desktop -> backend: connect relay session
backend -> desktop: send ephemeral claims over that session
desktop -> backend: local commit ACK
```

No inbound public port on the user's computer.

### Invariant 2: No durable plaintext backend queue

Backend may hold plaintext only in request memory while:

```text
Telegram webhook handler is active
relay claim is in flight
ACK deadline has not passed
```

Backend may persist non-plaintext metadata:

```text
providerUpdateKey
bindingId
connectionId
claimId
state
timestamps
HMAC payload digest
reason codes
provider status message ids
```

Do not persist raw user text, captions, file names, attachment metadata, or unsalted/plain hashes.

Use HMAC for digests:

```text
payloadDigest = HMAC-SHA256(serverSecret, canonicalProviderPayload)
```

Reason:

```text
Plain hashes of short chat messages are guessable.
```

### Invariant 3: ACK means local durable ownership

Desktop ACK must mean:

```text
ProcessedProviderUpdate persisted
MessengerConversation inbound row persisted
ExternalMessageLink persisted
route decision persisted or terminal local status persisted
MessengerRuntimeTurn pending persisted when applicable
```

It must not mean:

```text
desktop received network bytes
renderer saw a toast
agent saw the prompt
Telegram reply was sent
```

### Invariant 4: Offline and ambiguous are different

```text
offline = no eligible desktop session had accepted a claim for this update
ambiguous = claim may have reached desktop, but backend did not receive local commit ACK
```

Offline can produce a Telegram status and 2xx webhook response.

Ambiguous should not produce offline status automatically. It should retry through Telegram webhook retry or wait for desktop recovery.

## Recommended Relay Protocol

### Connection

Desktop opens an outbound authenticated relay session:

```text
POST /relay/connect
Authorization: Bearer <desktop session token>

{
  desktopInstanceId,
  userId,
  appVersion,
  capabilities,
  supportedProviders,
  localStoreEpoch,
  lastSeenRelaySeq
}
```

Backend returns:

```text
{
  connectionId,
  leaseToken,
  expiresAt,
  heartbeatAfterMs,
  maxInFlightClaims
}
```

Then desktop opens a downlink:

```text
GET /relay/events?connectionId=...
Authorization: Bearer <leaseToken>
Accept: text/event-stream
```

Or WebSocket equivalent.

### Claim event

Backend emits an ephemeral claim:

```json
{
  "type": "telegram_update_claim",
  "claimId": "claim_...",
  "providerUpdateKey": "telegram:bot:chat:thread:update",
  "payloadDigest": "hmac-sha256:...",
  "ackDeadlineAt": "2026-04-29T...",
  "provider": "telegram",
  "bindingId": "binding_...",
  "conversationAddress": {
    "chatId": "...",
    "threadId": "..."
  },
  "update": {
    "redactedInLogs": true
  }
}
```

The real update payload is inside the event, but never logged or persisted on backend.

### Desktop ACK

After local durable commit:

```text
POST /relay/claims/:claimId/ack
Authorization: Bearer <leaseToken>

{
  providerUpdateKey,
  payloadDigest,
  localCommitId,
  conversationMessageId,
  runtimeTurnId,
  acceptedAt
}
```

ACK contains no plaintext.

### Backend webhook decision

For each Telegram webhook update:

```text
validate secret_token
normalize update
dedupe by providerUpdateKey
resolve user binding
if unsupported:
  send unsupported status through provider outbox or direct sendMessage
  mark terminal metadata
  return 2xx
if no connected desktop:
  send offline status
  mark offline_notified metadata
  return 2xx
if connected desktop:
  dispatch ephemeral claim
  wait for local commit ACK until deadline
  if ACK arrives:
    mark accepted_local metadata
    return 2xx
  else:
    mark claim_ack_missing metadata
    return non-2xx for Telegram retry
```

Do not:

```text
return 2xx after only writing a backend metadata row
return 2xx after only writing to an in-memory relay socket
send offline status after claim was already dispatched
store plaintext for later desktop pickup
```

## Top 3 Relay Transport Options

### 1. SSE downlink plus HTTPS ACK uplink

🎯 8   🛡️ 8   🧠 5   Approx change size: 1800-3500 LOC across desktop and backend

Shape:

```text
desktop opens long-lived text/event-stream to backend
backend emits claim events
desktop persists locally
desktop POSTs ACK
backend returns Telegram webhook 2xx only after ACK
```

Why this is the best MVP:

- Desktop initiates outbound connection.
- No public desktop server.
- No WebSocket dependency required on desktop.
- Works well through many proxies.
- Existing app already has SSE concepts, though current SSE is local UI-only.
- ACK is an explicit HTTP request that can be authenticated and audited without plaintext.

Weaknesses:

- Bidirectional behavior is split across two HTTP channels.
- Need robust reconnect and event parsing.
- Need backend in-flight claim map and per-connection flow control.
- If the SSE write succeeds but ACK is lost, ownership is ambiguous.

Recommended package if using parser:

```text
eventsource-parser 3.0.8, MIT, checked 2026-04-29
```

Verdict:

```text
Recommended official shared bot MVP transport.
```

### 2. WebSocket bidirectional relay

🎯 8   🛡️ 9   🧠 7   Approx change size: 2500-4500 LOC across desktop and backend

Shape:

```text
desktop opens WebSocket
backend sends claim frames
desktop sends ACK frames on same socket
heartbeat and leases keep session online
```

Why it is attractive:

- Clean bidirectional protocol.
- Better flow control and multiplexing.
- Easier to tie claim and ACK to one connection.
- Good long-term if we expect many relay event types.

Weaknesses:

- More moving parts and reconnect edge cases.
- Requires WebSocket support/dependency choices in backend and desktop runtime.
- Some enterprise networks are less friendly to WebSockets than plain HTTPS.

Checked package options:

```text
@fastify/websocket 11.2.0, MIT, checked 2026-04-29
ws 8.20.0, MIT, checked 2026-04-29
```

Verdict:

```text
Good V2 or high-throughput path.
Not necessary for first reliable MVP.
```

### 3. Desktop short/long polling receive endpoint

🎯 7   🛡️ 7   🧠 4   Approx change size: 1400-2800 LOC across desktop and backend

Shape:

```text
desktop repeatedly calls /relay/receive
backend holds request briefly
Telegram webhook claims are returned through an open receive request
desktop ACKs local commit
```

Why it is attractive:

- Simple HTTP.
- No SSE parser or WebSocket dependency.
- Very clear request/response lifecycle.

Weaknesses:

- Lower concurrency unless multiple receive requests are open.
- Bursts can see desktop as falsely unavailable between receives.
- More polling overhead.
- Harder to deliver several claims quickly without slipping into backend queue semantics.

Verdict:

```text
Acceptable fallback if SSE is blocked.
Not the primary MVP path.
```

## ACK State Machine

Backend metadata state, no plaintext:

```text
received
-> duplicate_ignored

received
-> unsupported_notified
-> terminal_acked

received
-> offline_notified
-> terminal_acked

received
-> claim_dispatched
-> accepted_local
-> telegram_acked

claim_dispatched
-> claim_ack_missing
-> retry_expected

claim_ack_missing
-> duplicate_retry_received
-> claim_dispatched
```

Rules:

- `telegram_acked` means webhook returned 2xx after local commit ACK.
- `terminal_acked` means webhook returned 2xx after a provider-visible terminal status.
- `claim_ack_missing` is not terminal.
- `claim_ack_missing` must not trigger offline status by itself.
- Duplicate retry must re-use `providerUpdateKey` and payload digest checks.

Desktop local state:

```text
claim_received
-> local_committing
-> local_committed
-> ack_sent

local_committing
-> local_commit_failed_retryable
-> nack_sent

local_committed
-> ack_send_failed
```

If ACK send fails after local commit:

```text
desktop keeps local committed row
desktop retries ACK by claimId/providerUpdateKey if lease is alive
if backend later redelivers same update, desktop dedupes by providerUpdateKey and ACKs again
```

## Online Semantics

Backend should consider desktop online only if:

```text
relay session authenticated
lease not expired
heartbeat fresh
downlink writable
in-flight claim count below limit
desktop advertised provider binding is enabled
desktop advertised local store is healthy
```

Backend should consider desktop not eligible if:

```text
no relay session
lease expired
downlink backpressure or write failure
desktop says paused
desktop store unhealthy
binding disabled
app version below minimum protocol
```

Desktop UI states:

```text
Relay connected
Relay degraded
Relay disconnected
Relay paused
Relay protocol incompatible
Relay store unhealthy
```

Do not show "online" just because the desktop app process exists.

## Privacy And Logging Rules

Backend forbidden logs:

- message text
- captions
- attachment file names
- raw Telegram update JSON
- user phone/contact data
- Bot API token
- claim payload

Allowed logs:

- providerUpdateKey
- claimId
- connectionId
- bindingId
- state transition
- HMAC digest prefix
- duration
- reason code

Redaction policy:

```text
all relay logs pass through redaction before logger
structured logs use explicit safe fields
errors from Telegram are sanitized before persistence
```

Crash policy:

```text
If backend crashes while holding plaintext in memory,
the plaintext is lost and Telegram retry handles re-delivery.
Do not recover from backend disk queue because there is no plaintext disk queue.
```

## Rate Limit And Status Message Policy

Offline/unsupported statuses are still Telegram sends.

Rules:

- Use provider outbox state machine for status sends if the result matters.
- Per chat/topic, avoid rapid repeated offline notices.
- Coalesce repeated offline inbound updates into one status when possible.
- If status send gets 429, respect `retry_after`.
- Store status provider message id if send succeeds.

Low-confidence edge:

```text
If desktop is offline and backend must not store plaintext,
we cannot later tell the desktop what the user wrote.
The offline status must tell the user to retry when the app is online.
```

Recommended offline text shape:

```text
Agent Teams desktop is offline, so I cannot deliver this message right now.
Open the desktop app and resend here when it shows Telegram connected.
```

Do not promise delayed delivery in MVP.

## Clean Architecture Placement

Core/domain:

```text
RelayClaimStateMachine
RelayConnectionEligibilityPolicy
RelayAckDecisionPolicy
RelayPrivacyPolicy
```

Core/application:

```text
HandleOfficialRelayUpdateUseCase
AcceptRelayClaimAckUseCase
MarkRelayClaimMissingAckUseCase
ResolveRelayDesktopEligibilityUseCase
SendTerminalProviderStatusUseCase
```

Ports:

```text
OfficialRelayConnectionRegistry
OfficialRelayClaimDispatchPort
RelayMetadataRepository
MessengerProviderGateway
ClockPort
LoggerPort
RedactionPort
```

Main desktop adapters:

```text
OfficialRelaySseClientAdapter
OfficialRelayAckClientAdapter
LocalRelayClaimCommitter
RelayHealthPresenter
```

Backend adapters:

```text
TelegramWebhookInputAdapter
TelegramProviderGateway
RelaySseConnectionAdapter
RelayMetadataStore
```

Important boundary:

```text
Desktop feature core should not import backend relay implementation.
Backend relay should share only protocol contracts, not desktop main services.
```

## Edge Cases Added By This Pass

Webhook and claim:

- Webhook secret token missing.
- Webhook secret token wrong.
- Duplicate Telegram update while first is `claim_dispatched`.
- Duplicate Telegram update after `accepted_local`.
- Update arrives with no binding.
- Update arrives with binding but no connected desktop.
- Update arrives while desktop session is connected but paused.
- Update arrives while desktop local store is unhealthy.
- Update arrives while in-flight claim limit is full.
- Claim write to downlink fails before bytes leave backend.
- Claim write appears successful but desktop never ACKs.
- Desktop ACK arrives after backend already returned non-2xx.
- Desktop ACK arrives after lease rotation.
- Desktop ACK has mismatched payload digest.
- Desktop ACK has unknown claimId but known providerUpdateKey.

Privacy:

- Backend logger receives thrown Error containing raw Telegram JSON.
- Backend process crashes while claim is in memory.
- Backend restart receives Telegram retry for update it had previously dispatched.
- Payload text is short and hash would be guessable.
- User sends contact/location/media while official MVP is text-only.

Status messages:

- Offline status send succeeds.
- Offline status send times out.
- Offline status send gets 429 with retry_after.
- Offline status send itself is ambiguous.
- Repeated offline messages in same topic are rate-limited.

Desktop recovery:

- Desktop commits locally and ACK send fails.
- Desktop restarts before ACK retry.
- Desktop receives same providerUpdateKey again after restart.
- Desktop local store has inbound row but missing runtime turn.
- Desktop local store has runtime turn but missing ACK metadata.

## Decision Update

Add to canonical plan:

```text
Official shared bot relay uses desktop-initiated outbound transport.
Recommended MVP transport is SSE downlink plus HTTPS ACK uplink.
Webhook 2xx requires local commit ACK or terminal provider-visible status.
No desktop session means offline.
Claim dispatched without ACK means ambiguous ownership, not offline.
Backend may persist metadata only, no plaintext queue.
Persist HMAC digests, not plain hashes.
Do not use inline webhook Bot API responses for user-visible sends.
```

Updated confidence for official shared bot relay:

```text
SSE downlink + HTTPS ACK + no plaintext queue:
🎯 8   🛡️ 8   🧠 7   Approx implementation size: 2500-5000 LOC with backend, desktop, tests, and docs
```

Remaining highest uncertainty:

```text
Exact product policy for claim_ack_missing after long desktop absence.
```

Recommended default:

```text
Treat it as ambiguous and let Telegram retry.
Do not send offline status for an update that was already dispatched to desktop.
Show relay health warning in desktop if ACK retry is pending.
```
