# Messenger Connectors - Uncertainty Pass 59

Date: 2026-05-01
Scope: Official shared bot webhook-to-desktop relay ACK semantics, retry windows, no-plaintext backend queue, and ambiguous ownership

## Question

Can the official shared Telegram bot be stable without a plaintext backend queue?

Short answer:

```text
Yes, but only if webhook success is tied to desktop durable ACK.
SSE delivery is not enough.
Last-Event-ID is not enough.
Runtime delivery must wait until backend accepts the desktop ACK.
```

## Fresh Source Check

Official Telegram facts:

- `getUpdates` and webhooks are mutually exclusive for one bot.
- Incoming updates are stored by Telegram until received, but not longer than 24 hours.
- `update_id` lets webhook receivers ignore repeated updates or restore order if updates get out of order.
- Webhook requests are retried when the response is not `2xx`.
- Telegram says it gives up after a reasonable amount of attempts, but does not publish exact retry timing.
- `setWebhook.max_connections` is 1-100 and defaults to 40.
- `setWebhook.secret_token` is sent as `X-Telegram-Bot-Api-Secret-Token`.
- `getWebhookInfo` exposes `pending_update_count`, `last_error_date`, and `last_error_message`.
- Bot API calls embedded in webhook responses do not return success/result to the app.

SSE facts:

- Event streams are `text/event-stream`.
- SSE clients reconnect when the connection closes.
- SSE `id` sets the client last event id; reconnect sends `Last-Event-ID`.
- `Last-Event-ID` is resume metadata, not an application-level durable ACK.
- Comment lines can be used as keepalive.
- Plain browser EventSource has connection limits without HTTP/2; the relay must run in main process, not renderer tabs.

Sources:

- https://core.telegram.org/bots/api#getting-updates
- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#getwebhookinfo
- https://core.telegram.org/bots/api#making-requests-when-getting-updates
- https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- https://html.spec.whatwg.org/dev/server-sent-events.html

## Main Finding

The hard boundary is this:

```text
Telegram 2xx must mean either:
  desktop durably prepared the update locally, or
  the update was terminally not deliverable before plaintext dispatch.
```

It must not mean:

- backend wrote plaintext to an SSE socket
- desktop TCP connection was open
- desktop EventSource received an `id`
- renderer saw a notification
- backend claim row exists
- backend called an inline Bot API method in the webhook response

## Relay Checkpoints

Use explicit checkpoints:

```text
T0 telegram_webhook_received
T1 backend_metadata_claim_persisted
T2 plaintext_claim_dispatched_to_desktop_stream
T3 desktop_local_prepare_committed_and_read_back
T4 backend_ack_accepted
T5 runtime_delivery_started
```

Rules:

```text
T1 does not allow Telegram 2xx.
T2 does not allow Telegram 2xx.
T3 allows desktop to send ACK.
T4 allows Telegram 2xx.
T5 must happen only after T4.
```

Why T5 waits for T4:

```text
If runtime starts before backend accepts ACK, the lead may answer a message whose provider ownership is still ambiguous.
```

## State Machines

Webhook attempt:

```text
received
-> admitted
-> claim_metadata_persisted
-> dispatching
-> dispatched_waiting_ack
-> ack_accepted_2xx

dispatched_waiting_ack
-> ack_timeout_retryable_non_2xx
-> duplicate_retry_received
-> ack_accepted_2xx

dispatched_waiting_ack
-> retry_budget_exhausted
-> delivery_unconfirmed_status_sent
-> terminal_2xx
```

Relay claim:

```text
new
-> offered_to_desktop
-> local_prepared
-> ack_accepted

offered_to_desktop
-> duplicate_offered
-> duplicate_local
-> ack_accepted

offered_to_desktop
-> terminal_rejected_before_runtime
```

Provider-visible status:

```text
desktop_offline
team_not_ready
unauthorized_sender
delivery_unconfirmed
unsupported_update
```

Important distinction:

```text
desktop_offline is allowed only before plaintext dispatch.
delivery_unconfirmed is required after plaintext dispatch without ACK.
```

## Idempotency Keys

Use deterministic metadata keys:

```text
providerUpdateKey = telegram:<botUserId>:<update_id>
claimId = hmac(providerUpdateKey + accountBindingId + routeGeneration?)
payloadDigest = hmac(canonicalProviderUpdateShapeWithoutPlaintext)
```

The backend metadata claim ledger can store:

- provider update key
- claim id
- account binding id
- route id and generation when known
- update kind
- payload size bucket
- HMAC payload digest
- attempt count
- dispatch state
- ACK state
- provider-visible status message id
- timestamps
- redacted error class

The backend metadata claim ledger must not store:

- message text
- captions
- file names
- raw update JSON
- contact data
- location data
- bot token
- desktop refresh credential
- raw provider payload hash without secret HMAC

## No Plaintext Queue Crash Windows

### Crash after T1 before T2

Backend has metadata only. Telegram has not received 2xx.

Expected result:

```text
Telegram retries the same update.
Backend matches providerUpdateKey and dispatches plaintext from the retried request.
```

### Crash after T2 before T3

Plaintext may have been lost in an active stream buffer. Telegram has not received 2xx.

Expected result:

```text
Telegram retries.
If desktop had not stored it, it stores the retried claim.
If desktop had stored it, it returns duplicate_local.
```

### Crash after T3 before T4

Desktop has local durable row. Backend has not accepted ACK or Telegram did not receive 2xx.

Expected result:

```text
Telegram retries.
Backend redispatches duplicate claim.
Desktop returns duplicate_local based on providerUpdateKey.
Backend returns 2xx.
```

### Crash after T4 before Telegram receives 2xx

Backend accepted ACK, but Telegram may retry if the HTTP response failed.

Expected result:

```text
Telegram retries.
Backend already knows ACK accepted or desktop returns duplicate_local.
Backend returns 2xx.
```

### Crash after Telegram receives 2xx

Telegram will not retry. This is safe only if T4 happened first.

Expected result:

```text
Desktop local row exists and runtime can proceed.
```

## ACK Deadline Policy

Do not depend on Telegram's exact retry schedule.

Recommended initial policy:

```text
backend ACK wait: 8000 ms default, configurable 5000-9000 ms
max retryable Telegram attempts after plaintext dispatch: 3
max unconfirmed wall clock window: 120000 ms
same account-binding lane wait: 1000-2000 ms
SSE heartbeat: 15000 ms
connection stale: 2 missed heartbeats or transport close
```

These are product/runtime defaults, not Telegram guarantees.

Why bounded non-2xx:

```text
Returning non-2xx forever can poison the shared bot webhook queue.
Returning 2xx immediately can lose messages.
Bounded retry preserves reliability while keeping the shared bot healthy.
```

## Top 3 Relay ACK Options

1. Strict durable ACK before Telegram 2xx, bounded retry, `delivery_unconfirmed`.
   🎯 8   🛡️ 10   🧠 8   Approx 1800-3800 LOC.
   Recommended. Best privacy/reliability balance without a plaintext backend queue.

2. Backend durable plaintext queue, immediate Telegram 2xx.
   🎯 8   🛡️ 9   🧠 9   Approx 3000-5500 LOC.
   Reliability is strong, but it violates the current no-plaintext-backend-queue product decision.

3. Fire-and-forget SSE dispatch, immediate Telegram 2xx.
   🎯 7   🛡️ 4   🧠 3   Approx 500-1200 LOC.
   Rejected. Simple, but can lose provider messages after backend or desktop disconnects.

## Transport Details

SSE downlink event types:

```text
relay_claim
relay_heartbeat
relay_control
relay_revoked
```

ACK uplink:

```text
POST /v1/messenger/relay/claims/{claimId}/ack
```

ACK request body:

```text
{
  "ackKind": "local_prepared" | "duplicate_local" | "rejected_terminal" | "unsupported_update" | "busy_retryable",
  "providerUpdateKey": "...",
  "localConversationId": "...?",
  "localMessageId": "...?",
  "stateVersion": "...",
  "payloadDigest": "...",
  "deviceId": "...",
  "ackNonce": "..."
}
```

ACK acceptance requires:

- relay credential valid
- device binding valid
- account binding matches claim
- ack nonce matches active claim delivery
- payload digest matches metadata
- local prepared proof fields are present for `local_prepared`
- duplicate proof fields are present for `duplicate_local`

Renderer must not:

- open the relay SSE stream
- see relay credentials
- receive raw provider update JSON
- ACK claims

## Telegram Status Messages

Before plaintext dispatch:

```text
Desktop is offline. Open Agent Teams to receive messages.
```

After plaintext dispatch without ACK:

```text
Delivery to Agent Teams is unconfirmed. Check the desktop app before sending again.
```

Avoid:

- claiming offline after plaintext was dispatched
- saying the lead received it without desktop ACK
- asking the user to resend immediately
- exposing claim ids, local paths or provider payload details

## Tests Needed

- Webhook with no connected desktop returns offline terminal status without plaintext dispatch.
- Webhook with connected desktop commits local row before backend ACK acceptance.
- Runtime delivery does not start before backend ACK accepted.
- SSE `Last-Event-ID` resume does not mark a claim ACKed.
- Duplicate Telegram retry after local commit returns `duplicate_local`.
- Backend crash after metadata claim persist but before dispatch recovers from Telegram retry.
- Backend crash after stream dispatch but before desktop ACK recovers from Telegram retry.
- Backend crash after desktop local commit but before Telegram 2xx recovers through `duplicate_local`.
- ACK timeout returns non-2xx only within retry budget.
- Retry budget exhaustion sends `delivery_unconfirmed` and returns 2xx.
- Claim ledger contains no raw update JSON or message text.
- Logs and traces contain no provider plaintext.
- Per-account binding dispatch is serialized.
- Global webhook concurrency still accepts other account bindings.
- Renderer cannot connect to official relay endpoint.
- Secret webhook header is required before any sender identity or plaintext dispatch logic.

## Updated Confidence

This pass increases confidence in the relay architecture, while keeping exact Telegram retry timing as an empirical staging metric.

```text
Before: 🎯 8   🛡️ 9   🧠 8
After:  🎯 9   🛡️ 10  🧠 8
```

Remaining uncertainty:

- exact webhook retry interval distribution in production
- exact shared-bot queue behavior under many account bindings
- final `delivery_unconfirmed` user copy
- final ACK wait default after staging measurements

## Recommendation

Keep the current privacy decision:

```text
No durable plaintext backend queue in MVP.
```

But make the relay contract strict:

```text
Telegram 2xx only after backend-accepted desktop durable ACK
or terminal non-delivery before plaintext dispatch.
```

This is the key invariant that makes the official shared bot reliable enough without storing user messages on our backend.
