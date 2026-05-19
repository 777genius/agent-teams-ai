# Messenger Connectors - Uncertainty Pass 56

Date: 2026-05-01
Scope: Telegram reply-challenge repair command pipeline, classifier order, token security, and cleanup

## Question

If `Link by Telegram reply` is the safest way to repair `send_unknown`, how do we make sure the repair command itself does not become a normal message to the lead/team?

Short answer:

```text
Repair commands must be a pre-routing control plane.
They must be consumed before route/team delivery.
They must never enter lead stdin, teammate inbox, or normal conversation history.
```

## Fresh Source Check

Official Bot API facts:

- `Message.reply_to_message` is available for replies in the same chat and message thread.
- Message entities include `bot_command`, e.g. `/start@jobs_bot`.
- `deleteMessage` can delete incoming messages in private chats, with limits.
- A message can generally be deleted only if it was sent less than 48 hours ago, with special cases.

Sources:

- https://core.telegram.org/bots/api#message
- https://core.telegram.org/bots/api#messageentity
- https://core.telegram.org/bots/api#deleteMessage

## Main Finding

The repair command has to be parsed before:

- team topic route resolution
- reply-to teammate route resolution
- unknown-topic setup/help handling
- normal message persistence
- runtime delivery

Classifier order:

```text
1. provider admission and sender identity gate
2. connector repair command classifier
3. connector setup/control command classifier
4. callback/probe handler
5. normal topic/team route resolver
6. lead/teammate delivery
```

Why:

```text
If /sent <code> reaches lead stdin, the lead may respond to a repair token as if it were user intent.
If /sent <code> reaches teammate inbox, it can create a bogus teammate action.
If /sent <code> is stored as normal conversation text, privacy and UX degrade.
```

## Repair Token Shape

Use a random, one-time, short-lived token.

Recommended:

```text
token entropy: at least 128 bits
display form: base64url, 22 chars or similar
stored form: HMAC/SHA-256 digest, not raw token
ttl: 15 minutes default, 60 minutes maximum
scope: accountBindingId + routeId + outboxId + outboxAttemptId + expected chat/thread
```

Do not encode plaintext, team names, message text, or provider payload into the token.

The token is not a security boundary by itself. The handler must also verify:

- connected Telegram user id
- account binding
- chat id
- `message_thread_id` when topic mode is active
- outbox state is still `manual_resolution_required`
- `reply_to_message.message_id > 0`
- replied message is not already linked to a different local outbound row

## Command Parsing

Accepted commands:

```text
/sent <code>
/sent@<bot_username> <code>
```

Rules:

- Command must be the first token.
- If Telegram `entities` include `bot_command`, the command entity must start at UTF-16 offset `0`.
- If a bot username suffix is present, it must match the connected bot username.
- Code must match the expected base64url token format.
- Extra text after the token should be ignored only if it is whitespace or a known client artifact.
- Commands embedded later in text are ignored and routed normally.

Why support both text and entity parsing:

```text
Telegram gives bot_command entities, but repair must be robust to client differences and copied text.
Entity parsing prevents false positives; exact first-token parsing helps if entities are missing.
```

## Consumption Semantics

Repair command states:

```text
observed
-> accepted_linked
-> rejected_invalid_token
-> rejected_wrong_sender
-> rejected_wrong_thread
-> rejected_missing_reply
-> rejected_conflict
-> expired
```

Accepted command side effects:

```text
create ExternalMessageLink
mark outbox resolution marked_sent_linked
record repair audit row
emit messenger:changed
best-effort delete Telegram command message
```

Rejected command side effects:

```text
do not route to lead/team
record redacted reason
optionally send a short control reply in Telegram
```

Important:

```text
Even invalid /sent commands are consumed by the connector control plane if they match the command shape.
They must not be forwarded as normal team messages.
```

## Cleanup

After accepted repair:

```text
deleteMessage(chat_id, command_message_id)
```

This is best-effort only.

Rules:

- Delete after local repair state is committed.
- If delete fails, keep the repair state linked.
- Do not log command text or token.
- In private chats, Bot API supports deleting incoming messages, but still respect provider errors.
- In forum/supergroup route containers, deletion may require admin rights and should not be required.

Why delete:

- Reduces topic clutter.
- Reduces token visibility after use.
- Prevents future users from thinking `/sent <code>` is an instruction to the team.

Why best-effort:

- Delete restrictions depend on chat type, age, permissions and provider behavior.
- Repair correctness must not depend on cleanup.

## Control Replies

For invalid repair commands, prefer quiet handling in MVP.

Allowed provider-visible replies:

```text
Repair code expired.
Reply to the message you want to link, then send the code again.
This repair code does not match this topic.
```

Do not include:

- local file paths
- internal outbox ids
- token hashes
- message text
- stack traces

Recommendation:

```text
Show rich diagnostics in desktop UI.
Keep Telegram control replies short and generic.
```

## Top 3 Repair Command Pipeline Options

1. Pre-routing repair command control plane.
   🎯 9   🛡️ 10   🧠 6   Approx 900-1800 LOC.
   Recommended. Prevents repair tokens from reaching lead/team and restores provider links safely.

2. Normal route first, then intercept in lead/team layer.
   🎯 4   🛡️ 4   🧠 4   Approx 400-900 LOC.
   Rejected. Too easy to leak repair tokens into lead stdin or teammate inbox.

3. UI-only manual link without Telegram command.
   🎯 6   🛡️ 7   🧠 3   Approx 300-700 LOC.
   Simpler, but cannot reliably restore provider `message_id` for private-topic mode.

## Tests Needed

- `/sent <code>` reply in expected thread links the provider message.
- `/sent@bot_username <code>` is accepted for the current bot.
- `/sent@other_bot <code>` is rejected and consumed.
- Repair command not at offset zero is not treated as repair.
- Repair command without `reply_to_message` is rejected and consumed.
- Repair command with `external_reply` only is rejected and consumed.
- Wrong sender is rejected and consumed.
- Wrong chat is rejected and consumed.
- Wrong topic thread is rejected and consumed.
- Expired token is rejected and consumed.
- Reused token with same provider message id is idempotent.
- Reused token with different provider message id is conflict.
- Accepted repair command never writes to lead stdin.
- Rejected repair command never writes to lead stdin.
- Accepted repair command is deleted after commit when provider allows it.
- Delete failure does not roll back link repair.
- Logs contain no raw token.
- Support export contains token digest/reason only, not raw code.

## Updated Confidence

This pass increases confidence in `Link by Telegram reply` because the hard part is not the Bot API field. The hard part is classifier ownership.

```text
reply_to_message.message_id is useful only if the repair command is consumed before normal routing.
```

Remaining uncertainty:

- exact UX for quiet vs provider-visible invalid-code replies
- whether private-topic clients make "reply to this message" obvious enough
- whether command deletion behaves the same in private bot-chat topics as normal private chats
- exact token TTL that balances safety and user convenience

## Recommendation

Ship the repair command as a feature-owned control plane:

```text
TelegramRepairCommandClassifier
TelegramRepairTokenStore
LinkByTelegramReplyUseCase
TelegramRepairCleanupPort
```

Do this before normal route resolution and before any lead/team delivery code can see the command.
