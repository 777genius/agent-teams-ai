# Messenger Connectors Uncertainty Pass 73

Date: 2026-05-01
Focus: provider send result aftermath and manual resolution ownership

## Question

Does the documentation clearly explain what happens after `ProviderSendResult`?

## Finding

Not quite. The docs now separated `ProviderOutboxItem`, `ProviderSendAttempt` and `ProviderSendResult`, but the post-result outcome was still partly implicit:

```text
sent -> write ExternalMessageLink
unknown -> manual resolution
rate_limited -> retry later
terminal -> repair or failure
```

That needs one durable interpretation layer so UI, recovery and tests do not all infer outcomes independently.

## Correct Split

```text
ProviderSendResult
  raw adapter/backend evidence

ProviderDeliveryResolution
  feature-owned durable interpretation and next action

MessengerManualResolutionTask
  explicit user/support action when delivery is ambiguous
```

`ProviderSendResult` answers:

- did the adapter/backend observe success;
- did it observe known-not-sent;
- did it observe retryable-before-request;
- did it observe provider rate limit;
- did it lose the result after request_started.

`ProviderDeliveryResolution` answers:

- create outbound `ExternalMessageLink`;
- schedule retry;
- mark terminal provider failure;
- create manual resolution task;
- keep local-only;
- queue duplicate only after explicit approval.

`MessengerManualResolutionTask` answers:

- who needs to decide;
- which outbox item/attempt/result needs a decision;
- what safe actions are available;
- what warning copy is required;
- what previous resolution it supersedes.

## Correct Post-Send Flow

```text
ProviderSendAttempt request_started
-> provider adapter or official relay sends
-> ProviderSendResult
-> ProviderDeliveryResolution
-> if sent: outbound ExternalMessageLink
-> if retryable: schedule next ProviderSendAttempt
-> if terminal: route/connection repair state
-> if unknown: MessengerManualResolutionTask
```

## Rule

Manual actions must not mutate provider send history in place.

They append a new resolution:

```text
send_unknown
-> manual_resolution_required
-> user action
-> new ProviderDeliveryResolution
```

Examples:

- `marked_sent_linked` creates or restores outbound `ExternalMessageLink`;
- `marked_sent_unlinked` records external delivery without exact reply link;
- `user_checked_not_sent_retry_queued` creates a new retryable outbox item or attempt under explicit approval;
- `duplicate_send_approved_queued` creates a new outbox item with `duplicateOfOutboxId`;
- `external_send_cancelled` makes the message local-only.

Every manual action records:

- actor;
- timestamp;
- reason;
- previous resolution id;
- resulting resolution id;
- warning accepted when duplicate send is possible.

## Why This Matters

Without `ProviderDeliveryResolution`, each caller can interpret `ProviderSendResult` differently:

- UI may show Retry for `send_unknown`;
- recovery may enqueue duplicate provider send;
- link repair may create an `ExternalMessageLink` without audit;
- rate-limit retry may bypass outbox ownership;
- terminal provider failure may look like runtime failure.

## Tests To Add First

1. `sent` result creates exactly one outbound `ExternalMessageLink`.
2. `send_unknown` creates one `MessengerManualResolutionTask`.
3. Plain Retry is not offered for `send_unknown`.
4. `marked_sent_linked` appends a new delivery resolution and restores link.
5. `marked_sent_unlinked` does not restore exact reply routing.
6. `duplicate_send_approved_queued` creates a new outbox item with `duplicateOfOutboxId`.
7. Terminal provider failure does not retry runtime delivery.

## Top 3 Options

1. First-class `ProviderDeliveryResolution` plus `MessengerManualResolutionTask`.
   🎯 9   🛡️ 10   🧠 6   Approx `700-1500` LOC.
   Recommended. It keeps send evidence, feature outcome and user repair separate.

2. Store resolution fields inside `ProviderOutboxItem`.
   🎯 7   🛡️ 8   🧠 4   Approx `400-900` LOC.
   Simpler, but easier to overwrite history and harder to audit manual actions.

3. Let UI infer unknown/manual state directly from `ProviderSendResult`.
   🎯 4   🛡️ 4   🧠 3   Approx `200-500` LOC.
   Rejected. It scatters recovery rules and can reintroduce unsafe Retry.

## Verdict

The docs are now more organic because provider send has a complete outcome chain:

```text
send intent
-> send attempt
-> send result
-> delivery resolution
-> link, retry, terminal repair or manual task
```

Implementation should keep these as separate tests and separate repository records.
