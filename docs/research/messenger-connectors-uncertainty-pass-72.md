# Messenger Connectors Uncertainty Pass 72

Date: 2026-05-01
Focus: provider outbox item vs provider send attempt vs provider send result

## Question

Is the documentation clear about where local proof ends and non-idempotent provider send begins?

## Finding

The top canonical flow jumped from `ProviderOutboxItem` directly to `Telegram sendMessage`. Lower research already had `request_started`, `send_unknown` and metadata-only backend send attempts, but the living summary did not expose that as a first-class boundary.

That can cause a dangerous implementation shortcut:

```text
outbox item exists
-> worker calls Telegram
-> app crashes or response is lost
-> retry sees outbox item still pending
-> duplicate provider message
```

## Correct Split

```text
ExternalReplyProjectionIntent
  proves that a verified local visible reply may leave the app

ProviderOutboxItem
  owns deterministic outbound id, chunks, formatting, route and intended reply target

ProviderSendAttempt
  owns lease, attempt id, request phase and request_started boundary

ProviderSendResult
  owns sent, known-not-sent, rate-limited, retryable-before-request or unknown outcome

ProviderDeliveryResolution
  owns link, retry schedule, terminal failure, manual task or local-only next action
```

## Correct Outbound Flow

```text
MessengerConversationEntry outbound
-> ExternalReplyProjectionIntent
-> ProviderOutboxItem
-> ProviderSendAttempt leased
-> ProviderSendAttempt request_started
-> provider adapter or official relay sends to provider
-> ProviderSendResult
-> ProviderDeliveryResolution
-> outbound ExternalMessageLink if sent
-> MessengerManualResolutionTask if unknown
```

## Official Shared Bot Specifics

Official shared bot outbound has two ledgers:

```text
desktop local provider outbox:
  plaintext, chunks, route, proof, local attempt state

backend metadata result cache:
  clientOutboundId, route id, body HMAC, body length, provider ids, status
```

The backend must not persist plaintext. The desktop remains the durable plaintext owner.

The backend metadata cache can prove:

- sent with provider message id;
- known-not-sent;
- rate-limited;
- send_unknown after request started and result was not durably persisted.

It cannot prove safe automatic retry after Telegram may have accepted the send.

## Rule

`ProviderOutboxItem` is not the no-blind-retry boundary.

`ProviderSendAttempt.request_started` is the no-blind-retry boundary.

Auto-retry is allowed only when:

- no request started;
- provider returned rate limit with retry-after;
- failure is classified as retryable-before-request.

After request started, missing result becomes:

```text
send_unknown
provider_send_unknown
manual_resolution_required
```

No automatic duplicate send.

## Tests To Add First

1. Crash after `ProviderOutboxItem` before `ProviderSendAttempt.request_started` can retry.
2. Crash after `request_started` cannot auto-retry.
3. HTTP 429 stores retry-after and retries only after provider delay.
4. HTTP 200 with provider message id creates outbound `ExternalMessageLink`.
5. Backend metadata cache rejects plaintext fields.
6. Official shared bot result loss after `request_started` becomes `send_unknown`.
7. Own-bot direct send uses the same outbox/attempt/result state machine without backend metadata cache.

## Top 3 Options

1. First-class `ProviderSendAttempt` and `ProviderSendResult`.
   🎯 9   🛡️ 10   🧠 7   Approx `900-1800` LOC.
   Recommended. It makes duplicate-send prevention testable.

2. Store attempt fields inside `ProviderOutboxItem`.
   🎯 7   🛡️ 8   🧠 5   Approx `500-1200` LOC.
   Less surface, but easier to blur item ownership and request_started boundary.

3. Retry pending provider outbox items until sent.
   🎯 3   🛡️ 3   🧠 2   Approx `200-500` LOC.
   Rejected. Telegram has no documented sendMessage idempotency key, so this can duplicate messages.

## Verdict

The docs are now more organic because outbound has the same quality of boundaries as inbound:

```text
local proof
-> deterministic outbox item
-> explicit provider send attempt
-> normalized provider send result
-> delivery resolution
-> provider message link or manual task
```

Implementation should test this state machine before connecting a real Telegram token.
