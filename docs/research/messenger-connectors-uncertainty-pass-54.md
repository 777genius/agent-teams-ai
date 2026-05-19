# Messenger Connectors - Uncertainty Pass 54

Date: 2026-05-01
Scope: `send_unknown` product contract, manual repair, duplicate-safe UX, provider link recovery

## Question

If Telegram `sendMessage` may have reached Telegram but our app did not persist a success receipt, what exactly should the product do?

Short answer:

```text
Do not auto-retry.
Create a local manual resolution item.
Let the user choose an explicit repair action.
Record the repair as first-class state.
```

This pass turns `send_unknown` from a vague warning into a concrete state machine.

## Source Facts

The official Bot API facts that matter are unchanged:

- `sendMessage` returns a sent `Message` only on normal API success.
- The method has no app-supplied idempotency key.
- Calling Bot API methods in webhook responses does not return the method result to the bot app.
- `ResponseParameters.retry_after` exists for flood control, but it does not solve unknown result after request start.

Sources:

- https://core.telegram.org/bots/api#sendmessage
- https://core.telegram.org/bots/api#responseparameters
- https://core.telegram.org/bots/api#making-requests-when-getting-updates

## Unknown Is Not One State

The UI and recovery scanner should distinguish these cases:

```text
request_started_no_response
backend_result_cache_missing_after_possible_success
desktop_lost_backend_success_response
local_receipt_write_failed
multipart_part_unknown
```

Meanings:

- `request_started_no_response`: request may have reached Telegram, no parsed API response.
- `backend_result_cache_missing_after_possible_success`: backend may have sent successfully but failed before metadata cache persist.
- `desktop_lost_backend_success_response`: backend has metadata receipt, desktop missed the response. This is recoverable by request id and should not stay unknown.
- `local_receipt_write_failed`: response was known in memory but local durable receipt did not commit.
- `multipart_part_unknown`: one chunk in a split reply is unknown, so later parts must pause.

Important distinction:

```text
If backend metadata result cache has message_id, recover automatically.
If no durable provider receipt exists anywhere, require manual resolution.
```

## Manual Resolution State Machine

Recommended local model:

```text
send_unknown
-> manual_resolution_required

manual_resolution_required
-> marked_sent_linked
-> marked_sent_unlinked
-> user_checked_not_sent_retry_queued
-> duplicate_send_approved_queued
-> external_send_cancelled
```

Actions:

1. `Mark sent with link`
   - User provides Telegram message link or provider message id if available.
   - Best repair because it restores `ExternalMessageLink`.

2. `Mark sent without link`
   - User confirms they see the message in Telegram, but no provider message id is available.
   - Delivery status becomes manually sent.
   - Reply-to routing for that exact outbound message remains unavailable.

3. `I checked Telegram, retry`
   - User asserts the message is not visible in Telegram.
   - App creates a new outbox attempt and records the assertion.
   - Still not mathematically safe, but it is an explicit human decision.

4. `Send duplicate anyway`
   - User accepts possible duplicate.
   - App creates a new outbox item with `duplicateOfOutboxId`.
   - Must not be the default action.

5. `Keep local only`
   - App cancels external send.
   - Local history remains, Telegram status becomes cancelled.

## UI Copy Requirements

The UI should not say "failed" when the truth is unknown.

Good status:

```text
Maybe sent. Check Telegram before retrying.
```

Good action labels:

```text
Mark sent with link
Mark sent without link
I checked Telegram, retry
Send duplicate anyway
Keep local only
```

Bad action labels:

```text
Retry
Resend
Failed
Try again
```

Why:

```text
Plain "Retry" hides duplicate risk.
Plain "Failed" may be false.
```

## Provider Link Consequences

`marked_sent_linked`:

```text
delivery status: sent
provider message id: known
ExternalMessageLink: restored
future Telegram reply-to routing: supported
```

`marked_sent_unlinked`:

```text
delivery status: manually sent
provider message id: unknown
ExternalMessageLink: not restored
future Telegram reply-to that exact message: may fall back to team topic lead route
```

`duplicate_send_approved_queued`:

```text
delivery status: sending duplicate
new outbox item references duplicateOfOutboxId
original unknown stays preserved for audit
```

`external_send_cancelled`:

```text
delivery status: local only
provider outbox terminal
no future provider send from this item
```

## Multi-Part Messages

Long replies are split into provider parts.

Rule:

```text
If any part becomes send_unknown, stop all later unsent parts.
```

Manual resolution per part:

- If unknown part is marked sent with link, later parts may continue and can reply to that message id if desired.
- If unknown part is marked sent without link, later parts may continue in the same topic, but should not claim reply-chain continuity.
- If user chooses duplicate anyway, create duplicate replacement for that part and continue only after it is sent.
- If user keeps local only, later parts should also remain local-only unless user explicitly splits and sends a new message.

## Backend Support Boundary

Support and backend operators must not need message plaintext to resolve this.

Backend support-visible metadata:

```text
requestId
accountBindingId
routeId
providerSendAttemptId
state
timestamps
telegram error code
receipt present or missing
payload size bucket
HMAC payload digest
```

Not visible in backend logs/support tools:

- message text
- captions
- files
- raw Telegram JSON
- bot token
- desktop relay token

If support needs to help, the desktop UI should show the user their local plaintext. Backend support should work from ids and states only.

## Top 3 Repair Options

1. Local manual resolution queue with explicit actions.
   🎯 9   🛡️ 9   🧠 6   Approx 1200-2800 LOC.
   Recommended. It is honest, avoids automatic duplicates, and keeps privacy boundaries clear.

2. Conservative cancel-only unknown handling.
   🎯 8   🛡️ 10   🧠 4   Approx 600-1300 LOC.
   Very safe against duplicates, but frustrating because users cannot repair from inside the app.

3. Auto-retry with a duplicate warning marker in message text.
   🎯 4   🛡️ 5   🧠 5   Approx 700-1600 LOC.
   Rejected. It pollutes user-visible Telegram messages and still can duplicate.

## Required Tests

- Unknown with backend result cache present auto-recovers to sent.
- Unknown without backend result cache creates manual resolution item.
- Manual `Mark sent with link` restores `ExternalMessageLink`.
- Manual `Mark sent without link` does not create fake provider id.
- Manual `I checked Telegram, retry` creates new attempt with user assertion record.
- Manual `Send duplicate anyway` creates new attempt with `duplicateOfOutboxId`.
- Manual `Keep local only` terminally blocks provider send.
- Plain `Retry` action does not exist for unknown states.
- Multi-part unknown pauses later parts.
- Multi-part linked repair can continue later parts.
- Multi-part unlinked repair continues only without reply-chain claim.
- Support export contains ids/states only and no plaintext canary.

## Updated Confidence

The technical contract is now clearer:

```text
send_unknown is not a provider-send state.
It is a manual-resolution state.
```

Remaining uncertainty is mostly product polish:

- exact final copy
- whether we require Telegram message link for "Mark sent"
- how much repair UI ships in MVP
- whether multi-part messages should be deferred until after MVP

## Recommendation

Ship MVP with:

```text
send_unknown -> manual_resolution_required
actions:
  Mark sent without link
  I checked Telegram, retry
  Send duplicate anyway
  Keep local only
```

Add `Mark sent with link` when provider message link parsing is implemented.

This is enough to avoid silent duplicates while giving users a path out of uncertainty.
