# Messenger Connectors - Uncertainty Pass 40

Date: 2026-04-30
Status: deeper pass on official relay atomicity, ACK gates, and provider result caches

## Scope

This pass focuses on the weakest reliability area left after the topic registry work:

```text
Telegram webhook retry
-> backend no-plaintext relay
-> desktop durable local admission
-> backend ACK decision
-> runtime start gate
-> official backend provider sends
```

Updated conclusion:

```text
The official shared bot cannot provide exactly-once delivery.
It can provide at-least-once input plus idempotent desktop admission.
Runtime must not start until backend ACK acceptance is confirmed.
Official provider sends and topic provisioning need backend metadata result caches keyed by client request ids.
If provider success happens before result-cache persist, the state is unknown and must not auto-retry.
```

This is the missing piece that reduces `claim_ack_missing` from "maybe the agent already replied" to "desktop may have a local prepared turn, but runtime has not started yet".

## Sources Rechecked

Official and primary sources checked on 2026-04-30:

- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram `getUpdates`: https://core.telegram.org/bots/api#getupdates
- Telegram `setWebhook`: https://core.telegram.org/bots/api#setwebhook
- Telegram `getWebhookInfo`: https://core.telegram.org/bots/api#getwebhookinfo
- Telegram `sendMessage`: https://core.telegram.org/bots/api#sendmessage
- Telegram `createForumTopic`: https://core.telegram.org/bots/api#createforumtopic
- Telegram webhook inline requests: https://core.telegram.org/bots/api#making-requests-when-getting-updates
- WHATWG server-sent events: https://html.spec.whatwg.org/dev/server-sent-events.html
- MDN server-sent events: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events

Source facts that directly affect design:

- Telegram has two mutually exclusive update modes: `getUpdates` and webhook.
- Telegram stores incoming updates until received, but not longer than 24 hours.
- `getUpdates` confirms an update when called with an offset higher than that update id.
- Webhook setup supports `secret_token` through `X-Telegram-Bot-Api-Secret-Token`.
- Webhook `max_connections` defaults to 40 and can be set from 1 to 100.
- `getWebhookInfo` exposes pending update count and last webhook delivery errors.
- Inline Bot API requests in webhook responses do not reveal success/result to the app.
- `sendMessage` returns the sent `Message`, but has no documented client idempotency key.
- `createForumTopic` returns `ForumTopic`, but has no documented client idempotency key.
- WHATWG SSE supports reconnect and `Last-Event-ID`, but that is stream resume metadata, not a durable app-level ACK.
- SSE is one-way. ACK/control must be a separate HTTPS request if we use SSE downlink.

Package checks from npm registry on 2026-04-30:

- `eventsource` 4.1.0, MIT, modified 2025-11-19.
- `eventsource-parser` 3.0.8, MIT, modified 2026-04-19.
- `undici` 8.1.0, MIT, modified 2026-04-14.
- `ws` 8.20.0, MIT, modified 2026-03-21.

## 1. Core Correction: ACK Before Runtime, Not Just Before Webhook 2xx

Earlier passes correctly said:

```text
Telegram webhook 2xx requires desktop durable ACK or terminal non-delivery.
```

This pass adds the stricter desktop rule:

```text
Desktop must not start runtime delivery until backend confirms ACK acceptance.
```

Why:

```text
Backend sends claim over SSE.
Desktop persists inbound locally.
Desktop sends ACK.
ACK request or response is lost.
Telegram retries the webhook.
```

If runtime started immediately after local persist, the agent may already reply while the backend still has `claim_ack_missing`. A retry can then create duplicate local turns or contradictory Telegram statuses.

Safer model:

```text
1. Desktop receives claim.
2. Desktop persists local inbound turn as prepared.
3. Desktop POSTs ACK with providerUpdateKey + payloadDigest + localTurnId.
4. Backend records ACK as accepted.
5. Backend returns ACK response to desktop.
6. Desktop marks local turn as admitted.
7. Only now desktop enqueues runtime work.
8. Backend can return Telegram webhook 2xx.
```

If step 5 is lost, desktop retries the ACK. It still does not run the agent.

## 2. Inbound State Machines

Backend metadata state, no plaintext:

```text
webhook_received
-> no_desktop_terminal_status_sent
-> telegram_acked

webhook_received
-> claim_dispatched
-> desktop_ack_accepted
-> telegram_acked

claim_dispatched
-> ack_deadline_expired
-> telegram_retry_expected

telegram_retry_expected
-> duplicate_webhook_received
-> claim_redelivered_or_waiting

duplicate_webhook_received
-> duplicate_local_ack_accepted
-> telegram_acked
```

Desktop local state:

```text
claim_received
-> local_prepare_persisting
-> local_prepared
-> ack_posting
-> ack_accepted
-> runtime_queue_pending
-> runtime_started

ack_posting
-> ack_response_lost
-> ack_retry_pending

claim_received
-> duplicate_provider_update_seen
-> duplicate_local_ack_posting
```

Hard gate:

```text
runtime_queue_pending is impossible before ack_accepted.
```

This creates an explicit difference:

```text
local_prepared:
  desktop has plaintext locally
  no runtime side effects yet

ack_accepted:
  backend can safely ACK Telegram
  desktop can start runtime
```

## 3. Duplicate Telegram Retry Handling

Provider key:

```text
providerUpdateKey = telegram + botUserId + update_id
```

Payload guard:

```text
payloadDigest = HMAC-SHA256(secret, canonical redacted-sensitive update payload)
```

Backend retry handling:

```text
if providerUpdateKey has desktop_ack_accepted:
  return 2xx
  do not redispatch plaintext

if providerUpdateKey has claim_dispatched but no ack and retry arrives:
  if same desktop is connected:
    redispatch with same providerUpdateKey and new relayAttemptId
  if no desktop is connected:
    keep retry path open within webhook budget or return non-2xx
  do not send "offline" after a claim may have reached desktop

if providerUpdateKey is unknown:
  process as new update
```

Desktop retry handling:

```text
if providerUpdateKey + payloadDigest already local_prepared:
  return duplicate_local ACK with existing localTurnId

if providerUpdateKey exists with different payloadDigest:
  reject as payload_conflict
  do not route

if providerUpdateKey absent:
  persist prepared local turn
  ACK normally
```

Top 3 inbound duplicate policies:

1. Prepared-local gate plus duplicate_local ACK - 🎯 9   🛡️ 9   🧠 6, approx `900-1800` changed LOC.
   - Recommended.
   - Prevents runtime duplicates after lost ACK.
   - Preserves no-plaintext backend queue.

2. Start runtime immediately after local persist - 🎯 5   🛡️ 5   🧠 3, approx `300-700` changed LOC.
   - Reject.
   - Lost ACK can create runtime side effects before Telegram update is accepted.

3. Backend stores plaintext until final runtime completion - 🎯 4   🛡️ 8   🧠 7, approx `1600-3600` changed LOC.
   - Reliable in a normal hosted bot.
   - Violates the MVP no-plaintext-backend-queue decision.

Recommendation:

```text
Use option 1.
```

## 4. Official Provider Send Result Cache

In official shared bot mode, desktop cannot call Telegram directly because it does not have the official bot token.

So outbound replies use this shape:

```text
desktop local provider outbox
-> backend official send endpoint
-> Telegram sendMessage
-> backend metadata result cache
-> desktop outbox sent or send_unknown
```

Request:

```ts
type OfficialProviderSendRequest = {
  providerSendRequestId: string;
  outboxId: string;
  accountBindingId: string;
  routeId: string;
  provider: "telegram";
  chatId: string;
  messageThreadId: string | null;
  replyToProviderMessageId?: string;
  body: SensitiveText;
  bodyDigest: string;
  createdAt: string;
};
```

Backend result cache, no plaintext:

```ts
type OfficialProviderSendResultCacheRow = {
  providerSendRequestId: string;
  provider: "telegram";
  accountBindingId: string;
  routeId: string;
  providerMessageId?: string;
  providerChatId: string;
  providerThreadId?: string;
  status:
    | "not_started"
    | "send_in_flight"
    | "sent"
    | "send_unknown"
    | "failed_terminal";
  bodyDigest: string;
  attemptStartedAt?: string;
  providerSucceededAt?: string;
  cachedAt?: string;
  sanitizedFailureCode?: string;
};
```

Critical ordering:

```text
Backend must persist result cache before responding success to desktop.
```

Crash matrix:

```text
desktop crashes before POST:
  desktop outbox retries later

backend receives POST, crashes before Telegram send:
  desktop retry sends same providerSendRequestId
  backend can send normally

backend sends Telegram message, persists result cache, response lost:
  desktop retry gets cached providerMessageId
  no duplicate send

backend sends Telegram message, crashes before result cache:
  desktop retry cannot know if Telegram sent
  state becomes send_unknown
  do not blind retry
```

Top 3 official outbound send strategies:

1. Desktop-owned outbox plus backend metadata result cache - 🎯 9   🛡️ 9   🧠 6, approx `1100-2400` changed LOC.
   - Recommended.
   - Keeps plaintext durable only on desktop.
   - Avoids duplicates when response is lost after cache persist.

2. Backend-owned durable plaintext send queue - 🎯 6   🛡️ 9   🧠 5, approx `900-1800` changed LOC.
   - Reliable for a hosted bot.
   - Violates current privacy/product decision.

3. Stateless backend send endpoint with client retry - 🎯 4   🛡️ 4   🧠 2, approx `200-600` changed LOC.
   - Reject.
   - Any timeout after Telegram success can duplicate messages.

Recommendation:

```text
Use option 1.
```

## 5. Official Topic Provision Result Cache

Topic provisioning has the same problem as `sendMessage`, but it is more damaging because duplicate topics confuse routing.

Request:

```ts
type OfficialTopicProvisionRequest = {
  provisionRequestId: string;
  accountBindingId: string;
  routeId: string;
  routeGeneration: number;
  provider: "telegram";
  privateChatId: string;
  requestedTitle: string;
  requestedTitleDigest: string;
};
```

Backend result cache:

```ts
type OfficialTopicProvisionResultCacheRow = {
  provisionRequestId: string;
  accountBindingId: string;
  routeId: string;
  routeGeneration: number;
  privateChatId: string;
  messageThreadId?: string;
  status:
    | "not_started"
    | "create_in_flight"
    | "created"
    | "provision_unknown"
    | "failed_terminal";
  requestedTitleDigest: string;
  providerSucceededAt?: string;
  cachedAt?: string;
  sanitizedFailureCode?: string;
};
```

Critical ordering:

```text
Backend persists created messageThreadId before responding success.
Desktop persists route binding before marking route probe_pending.
```

Crash matrix:

```text
backend crashes before createForumTopic:
  retry same provisionRequestId

backend creates topic, persists cache, response lost:
  retry returns same messageThreadId

backend creates topic, crashes before cache:
  provision_unknown
  do not retry create automatically
  user may see orphan topic

desktop receives result, crashes before route binding persist:
  desktop retries provisionRequestId
  backend returns cached messageThreadId

desktop persists route binding, probe send response lost:
  route remains unverified
  outbound probe state handles ambiguity separately
```

Top 3 topic provisioning recovery strategies:

1. Backend result cache plus desktop route binding ACK - 🎯 8   🛡️ 9   🧠 7, approx `1400-3000` changed LOC.
   - Recommended.
   - Best available without Telegram idempotency key or topic listing.

2. Retry createForumTopic blindly on timeout - 🎯 4   🛡️ 4   🧠 2, approx `200-600` changed LOC.
   - Reject.
   - Creates duplicate visible topics.

3. Backend owns all official route bindings durably - 🎯 6   🛡️ 8   🧠 6, approx `1600-3400` changed LOC.
   - More server-reliable.
   - Worse privacy and own-bot parity.

Recommendation:

```text
Use option 1.
```

## 6. SSE Is A Transport, Not A Delivery Contract

SSE can be the MVP transport, but only if all reliability is application-level.

Do not rely on:

```text
SSE TCP write success
EventSource readyState
Last-Event-ID alone
backend in-memory connection map
```

Use:

```text
relayAttemptId
providerUpdateKey
payloadDigest
desktop local prepared row
POST ACK
ACK accepted response
leaseEpoch
capacity report
```

Top 3 desktop relay client options:

1. Main-process fetch stream plus `eventsource-parser` - 🎯 8   🛡️ 9   🧠 6, approx `1200-2600` changed LOC.
   - Recommended if using SSE.
   - Main process can use Authorization headers and custom retry.
   - Parser is small and current: `eventsource-parser` 3.0.8, MIT, checked 2026-04-30.

2. Main-process `eventsource` package - 🎯 6   🛡️ 7   🧠 4, approx `900-1900` changed LOC.
   - Simpler browser-like API.
   - Less control over request/ACK coupling and auth details.
   - Current: `eventsource` 4.1.0, MIT, checked 2026-04-30.

3. WebSocket via `ws` - 🎯 7   🛡️ 9   🧠 7, approx `2200-4400` changed LOC.
   - Strong bidirectional protocol.
   - Good later option.
   - More moving pieces than SSE+POST for MVP.

Recommendation:

```text
Use option 1 for MVP.
Keep WebSocket as V2 fallback if deployment proxy behavior makes streaming unreliable.
Never run official relay from renderer EventSource.
```

## 7. User-Visible Status Semantics

Statuses must match ownership:

```text
offline:
  no eligible desktop lease before plaintext dispatch

busy:
  desktop lease exists, but capacity says no new turns
  plaintext was not dispatched

uncertain:
  plaintext claim may have reached desktop
  backend has no accepted ACK yet

delivered_to_desktop:
  backend accepted ACK
  desktop can start runtime

sent_to_telegram:
  provider send result cache has providerMessageId

send_unknown:
  official backend may have sent but result cache was not persisted
```

Do not send:

```text
"desktop offline"
```

after a claim was dispatched to desktop. The honest status is:

```text
"Delivery is still being confirmed. Open Agent Teams to check this thread."
```

Use that only if product wants a visible uncertain notice. MVP can also show local health only and let Telegram retry.

## 8. Retention And Privacy

Backend metadata retention should be long enough for retries and support, but not become a behavioral database.

Recommended MVP retention:

```text
incoming claim metadata:
  7-30 days

official send result cache:
  30 days

topic provision result cache:
  90 days or until route tombstone retention expires

HMAC digests:
  rotate server secret with versioned digest keys
```

Metadata that may be persisted:

```text
providerUpdateKey
providerSendRequestId
provisionRequestId
routeId
accountBindingId
provider ids
state
timestamps
sanitized failure code
HMAC digest
```

Metadata that should not be persisted:

```text
message text
topic title raw value unless explicitly accepted as metadata
raw Telegram update JSON
file names
captions
plain hashes
bot tokens
```

## 9. Ports And Policy Placement

Per feature architecture and SOLID, keep these separate:

```text
RelayAdmissionPolicy:
  decides whether a claim can become local_prepared and ackable

RelayAckGatePolicy:
  decides when runtime may start

OfficialProviderSendPolicy:
  maps result-cache and timeout states to sent/send_unknown/failed_terminal

TopicProvisioningPolicy:
  maps provision result-cache states to probe_pending/provision_unknown/failed_terminal

ProviderResultCachePort:
  stores official metadata results, no plaintext

OfficialRelayTransportPort:
  sends ephemeral claims and receives app-level ACKs
```

Do not mix:

```text
SSE parser
Telegram Bot API client
local JSON store
runtime stdin writer
route activation policy
```

in one class. They have different reasons to change.

## 10. Tests That Close This Gap

Add before official bot E2E:

```text
RelayAckGatePolicy.test.ts:
  runtime cannot start before ack_accepted
  local_prepared without ack_accepted survives restart as ack_retry_pending
  duplicate providerUpdateKey returns duplicate_local
  duplicate providerUpdateKey with different digest becomes payload_conflict

OfficialWebhookRetryPolicy.test.ts:
  desktop_persisted ACK authorizes Telegram 2xx
  ACK response lost does not start runtime until ACK retry succeeds
  webhook retry after lost ACK redelivers claim
  duplicate_local ACK authorizes Telegram 2xx
  claim dispatched without ACK never sends offline status

OfficialProviderSendResultCache.test.ts:
  response lost after cache persist returns cached providerMessageId
  crash before Telegram send retries safely
  crash after Telegram send before cache persist becomes send_unknown
  stateless retry is rejected

OfficialTopicProvisionResultCache.test.ts:
  response lost after topic cache persist returns same messageThreadId
  crash before create retries same provisionRequestId
  crash after create before cache persist becomes provision_unknown
  provision_unknown does not call createForumTopic automatically

RelayStreamClient.test.ts:
  Last-Event-ID is treated as resume hint, not ACK
  stream write success does not mark delivered
  leaseEpoch mismatch rejects ACK
  main process owns relay tokens and renderer never receives them
```

## Updated Lowest-Confidence Map

1. Provider success before result-cache persist.
   🎯 7   🛡️ 8   🧠 7
   - Intrinsically ambiguous without Telegram idempotency keys.
   - Best answer is explicit `send_unknown` and `provision_unknown`.

2. Live private-topic client behavior.
   🎯 7   🛡️ 8   🧠 5
   - Still needs fixture capture across Telegram Desktop, mobile, and web.

3. Runtime acceptance after ACK gate.
   🎯 7   🛡️ 8   🧠 8
   - ACK gate prevents duplicate runtime starts.
   - Still need transcript marker proof that runtime indexed the prompt.

4. Proxy behavior for HTTP streaming.
   🎯 7   🛡️ 8   🧠 6
   - SSE is fine only with app-level ACK and deployment smoke tests.

5. Retention and privacy wording for backend metadata.
   🎯 8   🛡️ 8   🧠 4
   - Product copy must say backend stores metadata, not plaintext.

## Final Recommendation

Implement official relay as a three-gate system:

```text
Gate 1 - local prepare:
  desktop durably stores inbound but does not start runtime

Gate 2 - backend ACK accepted:
  backend can ACK Telegram
  desktop may start runtime

Gate 3 - provider result cache:
  official outbound send/provision only becomes successful after backend persists provider metadata result
```

This adds code, but it makes the hard guarantee clear:

```text
No durable backend plaintext queue.
No runtime side effects before Telegram acceptance is recoverable.
No blind retries for Telegram operations without idempotency keys.
```
