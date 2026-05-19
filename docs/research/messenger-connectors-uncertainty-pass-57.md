# Messenger Connectors - Uncertainty Pass 57

Date: 2026-05-01
Scope: Telegram repair command cleanup, `deleteMessage` assumptions, private-topic behavior and idempotent cleanup state

## Question

Can the app rely on deleting `/sent <code>` repair commands in Telegram private bot-chat topics?

Short answer:

```text
Do not make deletion part of correctness.
Do make deletion a best-effort cleanup task after local repair commit.
The repair token must be safe even if Telegram never deletes the command.
```

## Fresh Source Check

Official Bot API facts:

- `Message.message_id` is a unique message identifier inside the chat.
- `Message.message_thread_id` is optional and can exist for supergroups and private chats.
- `Message.is_topic_message` can be true in a forum supergroup or a private chat with the bot.
- `Message.reply_to_message` is available for replies in the same chat and message thread.
- `deleteMessage` takes `chat_id` and `message_id`, not `message_thread_id`.
- `deleteMessage` explicitly says bots can delete incoming messages in private chats.
- `deleteMessage` has age, service-message, permissions and chat-type limitations.
- `deleteMessages` can delete 1-100 messages and uses the same limitations as `deleteMessage`.

Sources:

- https://core.telegram.org/bots/api#message
- https://core.telegram.org/bots/api#deletemessage
- https://core.telegram.org/bots/api#deletemessages

## Main Finding

Private-topic deletion is a strong inference, not a product guarantee.

Why the inference is strong:

```text
message_id is unique inside chat
private-topic identity is message_thread_id
deleteMessage uses chat_id + message_id only
bots can delete incoming messages in private chats
private bot-chat topics are still private chats with topic metadata
```

Why it still needs a fixture:

```text
Bot API delete limitations do not spell out private bot-chat topic cleanup as a separate case.
Telegram clients can surface private topics differently.
Provider errors are runtime facts, not type-level facts.
```

So the design should say:

```text
Deletion is expected to work for fresh repair commands in private bot-chat topics.
Deletion failure is non-fatal and never rolls back a restored ExternalMessageLink.
```

## Cleanup Is Not Security

The security boundary is:

- one-time token
- short TTL
- digest-only local storage
- sender identity gate
- chat and thread scope
- outbox attempt scope
- consumed-token state

The security boundary is not:

- Telegram deleting the command
- user not seeing the command
- Telegram clients hiding the command quickly

If `/sent <code>` remains visible in Telegram:

- a consumed token cannot be reused
- an expired token cannot be used
- the token does not reveal message text, team name, local path, or provider payload
- the desktop UI can still show that cleanup failed

## Correct Cleanup Sequence

Accepted repair command sequence:

```text
1. classify repair command before normal routing
2. verify sender, chat, thread, token and reply_to_message
3. open MessengerUnitOfWork
4. create or confirm ExternalMessageLink
5. consume repair token
6. mark outbox repair as marked_sent_linked
7. insert RepairCommandCleanupTask
8. commit local state
9. emit messenger:changed
10. run cleanup task with deleteMessage
```

Important:

```text
deleteMessage happens after local commit.
deleteMessage failure does not undo local link repair.
```

Rejected repair command sequence:

```text
1. classify repair command before normal routing
2. verify sender, chat and thread as far as possible
3. reject with redacted reason
4. consume command from normal routing
5. optionally insert cleanup task if the message is safe to delete
6. optionally send generic control reply
```

## Cleanup Task Model

Add a local metadata-only task:

```text
RepairCommandCleanupTask {
  cleanupTaskId
  provider
  accountBindingId
  routeId?
  providerChatId
  providerMessageId
  providerThreadId?
  commandKind
  commandOutcome
  status
  attempts
  nextAttemptAt
  lastErrorClass?
  createdAt
  updatedAt
}
```

Do not store:

- raw command text
- raw repair token
- message text
- teammate/lead message body
- Telegram payload JSON

Allowed status values:

```text
pending
in_flight
succeeded
skipped_already_absent
failed_retryable
failed_terminal
expired_no_longer_attempted
```

## Error Classification

Treat cleanup errors as metadata-only diagnostics.

Recommended classifier:

```text
success -> succeeded
message not found -> skipped_already_absent
message can't be deleted -> failed_terminal
message too old -> failed_terminal
not enough rights -> failed_terminal
rate limited -> failed_retryable with retry_after
5xx/network -> failed_retryable with backoff
unknown 4xx -> failed_terminal with redacted code
unknown transport -> failed_retryable with capped attempts
```

Do not show raw provider error text in a support bundle unless it is redacted and checked for content leakage.

## `deleteMessage` vs `deleteMessages`

Top cleanup API options:

1. Immediate single-message cleanup with `deleteMessage`.
   🎯 9   🛡️ 9   🧠 3   Approx 200-450 LOC.
   Recommended for MVP. Simple state, clear per-command outcome, easy test matrix.

2. Batch cleanup sweeper with `deleteMessages`.
   🎯 8   🛡️ 8   🧠 5   Approx 350-700 LOC.
   Good later if many cleanup tasks accumulate. Useful because Telegram can delete 1-100 messages per call and skip not-found messages.

3. No provider cleanup, only local token invalidation.
   🎯 7   🛡️ 7   🧠 1   Approx 50-150 LOC.
   Acceptable fallback, but topic clutter and user confusion are worse.

Recommendation:

```text
Ship option 1 first.
Keep the cleanup task shape compatible with option 2.
Do not block repair correctness on either option.
```

## When To Delete Rejected Commands

Delete only when it is safe:

```text
bound user + bound private chat + known command shape -> cleanup allowed
wrong token but right chat/thread/user -> cleanup allowed
expired token but right chat/thread/user -> cleanup allowed
missing reply but right chat/thread/user -> cleanup allowed
wrong sender -> do not delete unless route container policy explicitly allows moderation
forum/supergroup -> delete only if bot has required rights and route policy enables cleanup
unknown chat -> do not delete
```

Reason:

```text
In private bot-chat topics, cleanup is personal UX.
In groups or forum supergroups, cleanup can become moderation.
```

## Race Conditions

### User deletes the command before cleanup

Outcome:

```text
deleteMessage may fail with not-found.
Mark cleanup as skipped_already_absent.
Keep repaired link.
```

### Cleanup succeeds before UI observes the repair

Outcome:

```text
Safe. UI should be driven by local state, not by Telegram command visibility.
```

### Telegram retries the same update after cleanup

Outcome:

```text
Idempotency must be keyed by provider update id and command message id.
The consumed token prevents double repair.
The second cleanup sees already succeeded or skipped.
```

### Two devices try to repair the same outbox item

MVP should have one desktop relay owner per account binding. Still:

```text
ExternalMessageLink uniqueness must reject conflicting provider message ids.
Same provider message id is idempotent.
Different provider message id becomes rejected_conflict.
```

### Cleanup task crashes after local commit

Outcome:

```text
Recovery scanner finds pending cleanup tasks and retries.
No lead/team routing is affected.
```

## Fixture Needed

The live fixture should verify:

- private bot-chat topic message contains `is_topic_message=true`
- command message has `message_thread_id`
- command message can be deleted with only `chat_id + message_id`
- deleting command does not delete the repaired target message
- deleting command works after accepted repair
- deleting command works after rejected expired-token repair
- deletion failure is observed and classified without rollback
- Telegram Desktop, iOS, Android and Web show acceptable behavior after deletion

Minimum pass threshold before claiming private-topic cleanup works:

```text
Bot API returns True for fresh incoming command deletion in private-topic mode.
At least Telegram Desktop and one mobile client remove or hide the command without corrupting the topic.
```

## Updated Confidence

This pass increases confidence in best-effort cleanup.

```text
Before: 🎯 6   🛡️ 8   🧠 4
After:  🎯 8   🛡️ 9   🧠 4
```

The confidence is not 10 because we still need live private-topic fixture results.

## Recommendation

Implement cleanup as a post-commit adapter concern:

```text
TelegramRepairCleanupPort
RepairCommandCleanupTaskRepository
DeleteTelegramCommandMessageUseCase
TelegramCleanupErrorClassifier
```

Keep cleanup out of:

- route resolution
- lead stdin delivery
- `ExternalMessageLink` correctness
- repair-token security

This keeps the feature stable even if Telegram refuses to delete a command in a specific client or chat type.
