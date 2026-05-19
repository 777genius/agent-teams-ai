# Messenger Connectors - Uncertainty Pass 60

Date: 2026-05-01
Scope: Official shared bot outbound send result cache, Telegram `sendMessage` ambiguity, request ids and duplicate prevention

## Question

How do we send Telegram replies through the official shared bot without creating duplicate messages when the backend, network, or desktop loses the result?

Short answer:

```text
Use a desktop request id plus backend metadata result cache.
Backend returns sent only after Telegram result metadata is persisted.
If Telegram may have accepted the send but persisted metadata is missing, enter send_unknown.
Never blind retry after provider request_started.
```

## Fresh Source Check

Official Bot API facts:

- `sendMessage` sends a text message and returns the sent `Message` on success.
- `sendMessage.message_thread_id` targets a message thread in a forum supergroup or private bot-chat topic when topic mode is enabled.
- `sendMessage.reply_parameters` can point at the original message.
- `ReplyParameters.allow_sending_without_reply` controls whether the message may still be sent if the replied-to message is missing.
- `Message.message_id` is unique inside the chat.
- `Message.message_id` can be `0` in specific scheduled-message cases, so routing code should validate positive ids for normal connector sends.
- Bot API calls made in webhook responses do not return success/result to the app.
- The Bot API docs do not define a client-supplied idempotency key for `sendMessage`.

Sources:

- https://core.telegram.org/bots/api#sendmessage
- https://core.telegram.org/bots/api#message
- https://core.telegram.org/bots/api#replyparameters
- https://core.telegram.org/bots/api#making-requests-when-getting-updates

## Main Finding

For official shared bot outbound sends, the backend owns the bot token and the desktop owns the plaintext outbox.

That creates a split-brain risk:

```text
desktop knows what should be sent
backend can call Telegram
Telegram may accept the send
desktop may not receive the provider message_id
```

Telegram does not give a documented `sendMessage` idempotency key. A retry after an unknown result can send a duplicate.

Therefore:

```text
provider request_started is the retry boundary
after request_started, timeout/crash/lost result becomes send_unknown
```

## Outbound Checkpoints

Use explicit checkpoints:

```text
S0 desktop_outbox_prepared
S1 backend_send_request_admitted
S2 backend_metadata_request_persisted
S3 telegram_send_started
S4 telegram_send_result_received
S5 backend_result_metadata_persisted
S6 desktop_result_applied
```

Rules:

- S0 is local intent, not provider delivery.
- S2 allows dedupe of repeated desktop requests.
- S3 is the no-blind-retry boundary.
- S4 without S5 is ambiguous.
- Backend may respond `sent` to desktop only after S5.
- Desktop may mark provider outbox `sent` only after S6.

## Request Ids

Desktop creates:

```text
desktopRequestId
providerOutboxId
providerSendAttemptId
payloadDigest
conversationRouteId
routeGeneration
replyLinkId?
```

Backend cache key:

```text
officialSendRequestKey =
  accountBindingId + desktopDeviceId + desktopRequestId
```

Backend stores metadata only:

- request key
- account binding id
- route id and generation
- provider chat id
- provider thread id
- reply target provider message id
- payload size bucket
- HMAC payload digest
- request state
- provider message id after success
- provider date after success
- retry-after when rate limited
- redacted error class
- timestamps

Backend must not store:

- message text
- raw reply text
- raw update JSON
- raw Telegram request body
- bot token
- desktop refresh credential
- raw payload hash without HMAC

## Backend Send Request States

```text
admitted
-> metadata_persisted
-> provider_request_started
-> provider_result_received
-> result_persisted
-> returned_to_desktop

provider_request_started
-> result_unknown
-> returned_unknown_to_desktop

metadata_persisted
-> rejected_before_provider
```

Desktop provider outbox states:

```text
queued
-> sending
-> sent

sending
-> send_unknown
-> manual_resolution_required

queued
-> failed_retryable
queued
-> failed_terminal
```

State mapping:

```text
backend result_persisted -> desktop sent
backend rejected_before_provider retryable -> desktop failed_retryable
backend rejected_before_provider terminal -> desktop failed_terminal
backend result_unknown -> desktop send_unknown
```

## Crash Windows

### Crash before S3

Provider request was not started.

Outcome:

```text
Retry is safe if backend request state proves no provider_request_started.
```

### Crash after S3 before S4

Provider may have accepted the send.

Outcome:

```text
No blind retry.
Return result_unknown/send_unknown.
User can repair with Link by Telegram reply, mark sent unlinked, checked retry, duplicate, or keep local only.
```

### Crash after S4 before S5

Telegram definitely returned success to the backend process, but metadata cache may not contain the `message_id`.

Outcome:

```text
Treat as result_unknown unless the backend can recover persisted metadata.
Do not infer success from logs, metrics, or desktop timeout.
```

### Crash after S5 before desktop receives response

Backend has metadata result.

Outcome:

```text
Desktop retries same desktopRequestId.
Backend returns cached result.
No duplicate send.
```

### Desktop crashes after receiving result before local persist

Backend has metadata result.

Outcome:

```text
Desktop recovery reads local sending outbox, calls status/result by desktopRequestId, applies cached provider message id.
```

## Reply Parameters

For exact reply projection, outbound sends should include `reply_parameters` when there is a proven `ExternalMessageLink`.

Recommended:

```text
reply_parameters.message_id = target provider message_id
reply_parameters.chat_id = target chat id only when required by provider shape
reply_parameters.allow_sending_without_reply = false
```

Why `allow_sending_without_reply=false`:

```text
If the reply target is unavailable, sending as a non-reply can break future route correlation.
Failing before provider delivery is safer than silently sending a detached message.
```

If Telegram rejects because the replied-to message is unavailable:

```text
failed_terminal_reply_target_missing
```

Then desktop can show:

```text
Reply target is unavailable in Telegram. Send as a new message?
```

That user-approved detached send creates a new outbox attempt with explicit policy:

```text
replyDetachedApproved = true
```

## Inline Webhook Calls Are Not For Outbound

Do not send official outbound replies by returning a Bot API method from a webhook response.

Reason:

```text
Telegram does not return the result of inline webhook method calls to the app.
We need the sent Message.message_id for ExternalMessageLink.
```

Use explicit backend outbound worker calls instead.

## Rate Limits And Retry

Before S3:

```text
retryable backend/network admission errors can retry with the same desktopRequestId
```

After S3:

```text
network timeout, process crash, 5xx with uncertain request status -> send_unknown
```

Provider response classification:

```text
429 with retry_after before request_started -> failed_retryable/rate_limited
400 reply target missing -> failed_terminal_reply_target_missing
403 bot blocked/user stopped bot -> failed_terminal_provider_blocked
chat/thread not found -> repair_required route tombstone
5xx after request_started uncertainty -> send_unknown
```

## Top 3 Outbound Result Strategies

1. Desktop request id plus backend metadata result cache.
   🎯 9   🛡️ 9   🧠 7   Approx 1400-3000 LOC.
   Recommended. Keeps plaintext off backend durable storage and prevents duplicate sends after cached success.

2. Backend plaintext outbox queue with idempotent worker.
   🎯 8   🛡️ 9   🧠 9   Approx 3000-6000 LOC.
   Strong delivery semantics, but violates no-plaintext backend queue for MVP.

3. Desktop retries send proxy on timeout.
   🎯 6   🛡️ 4   🧠 3   Approx 400-900 LOC.
   Rejected. Simple but can create duplicate Telegram messages.

## Tests Needed

- Backend stores request metadata before provider call.
- Backend returns cached result for duplicate `desktopRequestId`.
- Backend responds `sent` only after result metadata is persisted.
- Timeout before provider request started is retryable.
- Timeout after provider request started becomes `send_unknown`.
- Crash after Telegram success but before result cache persist becomes `send_unknown`.
- Crash after result cache persist returns cached provider `message_id`.
- Desktop recovery can query result by `desktopRequestId`.
- `reply_parameters.allow_sending_without_reply=false` blocks detached replies.
- Missing reply target becomes terminal before silent detached send.
- Detached send requires explicit user approval and a new attempt id.
- Logs contain no message text.
- Result cache contains no raw Telegram request body.
- HMAC payload digest changes when message text changes.
- Same desktopRequestId with different payload digest is rejected as conflict.

## Updated Confidence

This pass increases confidence in official outbound because the duplicate boundary is now explicit:

```text
provider_request_started is the no-blind-retry boundary
```

Updated rating:

```text
Official provider send result lost after Telegram success:
Before: 🎯 7   🛡️ 8   🧠 7
After:  🎯 9   🛡️ 9   🧠 7
```

Remaining uncertainty:

- exact Telegram error descriptions for deleted private-topic threads
- exact provider 5xx/timeout distribution under load
- final UX copy for `send_unknown`
- whether future encrypted backend queue is worth premium reliability mode

## Recommendation

Use:

```text
OfficialProviderSendResultCache
OfficialSendRequestId
OfficialSendAttemptLedger
OfficialSendErrorClassifier
DesktopOutboxRecoveryUseCase
```

And enforce:

```text
No blind retry after provider_request_started.
No desktop sent state until provider message_id is persisted and returned.
```
