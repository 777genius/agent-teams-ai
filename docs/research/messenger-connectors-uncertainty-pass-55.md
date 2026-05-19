# Messenger Connectors - Uncertainty Pass 55

Date: 2026-05-01
Scope: `Mark sent with link`, Telegram message-link feasibility, private-chat topics, and a safer sent-confirmation repair flow

## Question

Can a user repair `send_unknown` by pasting a Telegram message link, and can we restore the exact provider `message_id` for future reply routing?

Short answer:

```text
For forum supergroups/channels, pasted Telegram message links can be useful.
For default private bot-chat topics, pasted message links are not a safe MVP dependency.
Use a Telegram reply challenge as the primary linked repair flow.
```

## Fresh Source Check

Official Telegram deep link docs say message links are for specific messages in public or private groups and channels.

Private message links use:

```text
t.me/c/<channel>/<id>
t.me/c/<channel>/<thread_id>/<id>
tg://privatepost?channel=<channel>&post=<id>
```

The `channel` parameter is described as "Channel or supergroup ID".

The same docs also say IDs in Telegram links use MTProto format, not Bot API format.

Bot API `Message.reply_to_message` is present for replies in the same chat and message thread.

Sources:

- https://core.telegram.org/api/links#message-links
- https://core.telegram.org/bots/api#message

## Key Finding

Private-chat topics with bots are supported by Bot API for message delivery, but Telegram message-link docs do not clearly define copy/paste links for messages in a private bot chat topic.

Therefore:

```text
Do not make pasted Telegram link the primary Mark sent with link path in MVP.
```

It may work in some clients or modes, but it is not a reliable product contract until a live fixture proves it across clients.

## Better Repair Flow: Reply Challenge

Instead of asking the user to paste a link, ask the user to reply in Telegram to the maybe-sent message with a signed repair code.

Flow:

```text
send_unknown created
-> desktop creates repair token
-> UI shows: reply to the Telegram message with /sent <code>
-> user replies to the maybe-sent Telegram message
-> backend/desktop receives Telegram update
-> repair handler verifies token, sender, route, chat and thread
-> handler reads update.message.reply_to_message.message_id
-> create ExternalMessageLink for the local outbound row
-> mark resolution as marked_sent_linked
```

Why this is stronger:

- It works from the normal Bot API update path.
- It does not depend on Telegram client copy-link behavior.
- It works in the same chat and thread because `reply_to_message` is explicit provider metadata.
- It restores the exact provider `message_id`.
- It naturally proves the user sees the message.

## Routing Requirement

The repair command must be handled before normal team routing.

Classifier order:

```text
1. connector repair command with signed token
2. connector setup/control commands
3. normal route/topic/team message
```

If the repair command is treated as a normal inbound team message, the lead may see internal repair text. That must be impossible.

## Security Checks

Accept reply-challenge repair only if:

- repair token exists and is not expired
- repair token belongs to the same account binding
- sender is the connected Telegram user
- route is still the same route or route generation is compatible
- update is in the expected chat
- update is in the expected `message_thread_id` when topic mode is active
- `reply_to_message.message_id` exists and is greater than zero
- the replied-to provider message is not already linked to a conflicting local message
- state is still `manual_resolution_required`

Reject if:

- update contains only `external_reply`
- command is not a reply
- token is stale
- token was already consumed by a different provider message id
- reply target is in a different topic/thread
- same token resolves to a different provider message id after being linked

## Pasted Link Parser Scope

Pasted link parsing can still exist, but with a narrow scope:

Allowed in MVP:

```text
forum_supergroup route container
public username message link where username maps to the known chat
private t.me/c link where converted id maps to the known supergroup/channel
```

Not allowed in MVP:

```text
private bot chat topic
unknown t.me/c id
raw message_id without chat/thread proof
links whose chat id cannot be matched to the route binding
```

Important:

```text
A message_id alone is never enough.
Provider message identity is accountBindingId + botUserId + chat_id + message_thread_id + message_id.
```

## Top 3 Mark-Sent-With-Link Options

1. Telegram reply-challenge repair.
   🎯 8   🛡️ 9   🧠 6   Approx 900-2000 LOC.
   Recommended. Restores exact provider message id without relying on copy-link support in private bot chats.

2. Pasted Telegram link parser for forum supergroup and public/private channel links only.
   🎯 6   🛡️ 7   🧠 5   Approx 600-1500 LOC.
   Useful fallback for advanced/forum route containers, but not enough for default private-topic mode.

3. Manual message id entry.
   🎯 3   🛡️ 4   🧠 2   Approx 200-500 LOC.
   Rejected for normal users. Too easy to link the wrong message without chat/thread proof.

## UI Update

Change the repair action labels:

MVP primary:

```text
Link by Telegram reply
Mark sent without link
I checked Telegram, retry
Send duplicate anyway
Keep local only
```

Advanced/future:

```text
Paste Telegram message link
```

Do not show "Paste Telegram message link" as the default for private-topic mode until fixtures prove it works.

## Tests Needed

- Reply challenge with valid token and `reply_to_message.message_id` creates `marked_sent_linked`.
- Reply challenge is handled before normal team routing.
- Reply challenge without `reply_to_message` is rejected.
- Reply challenge with `external_reply` only is rejected.
- Reply challenge in wrong thread is rejected.
- Reply challenge from wrong Telegram user is rejected.
- Reply challenge stale token is rejected.
- Reply challenge duplicate same provider message id is idempotent.
- Reply challenge duplicate different provider message id becomes conflict.
- Pasted public link accepted only when username maps to known route chat.
- Pasted `t.me/c` link accepted only when converted id maps to known supergroup/channel.
- Pasted private bot-chat link is not accepted in MVP.
- Raw message id alone is rejected.

## Updated Confidence

This lowers risk in the `send_unknown` repair story:

```text
Mark sent with link should mean Link by Telegram reply in MVP.
```

Remaining uncertainty:

- exact Telegram client UX for replying to a maybe-sent bot message inside private topics
- whether all clients expose reply gesture clearly in private-chat topics
- whether pasted links from private bot chats work in any useful shape
- whether we should auto-delete or ignore the repair command message after processing

## Recommendation

Implement:

```text
Link by Telegram reply
```

before implementing pasted message-link parsing.

Keep pasted link parsing limited to route containers where Telegram's official link syntax clearly applies, mainly public/private supergroups, channels, and forum supergroups.
