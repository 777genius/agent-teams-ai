# Messenger Connectors - Uncertainty Pass 45

Date: 2026-04-30
Scope: provider event identity, reply-link routing, edits/deletes, callback probes, and provider-neutral route identity

## 1. Bottom Line

The weakest implementation area is now the identity and reply-link contract.

Safe rule:

```text
Never route to a teammate from text, topic title, sender name, quote text, latest feed row, or timestamp alone.
Only route to a teammate when a provider reply reference resolves through ExternalMessageLink.
```

For Telegram MVP:

```text
message_thread_id chooses the team.
reply_to_message.message_id can choose a teammate only after link lookup.
external_reply never chooses a teammate in MVP.
callback_query can confirm setup only through signed callback data and stored probe message metadata.
```

For future providers:

```text
Discord message_reference can choose a teammate only after link lookup.
WhatsApp context.message_id can choose a teammate only after link lookup.
Every provider adapter maps into the same core ReplyReference model.
```

Most important design decision:

```text
ExternalMessageLink is the only cross-boundary proof that a remote reply targets a local member or local turn.
ProviderConversationRouteBinding chooses team scope.
ExternalMessageLink chooses reply target.
MessengerRuntimeTurnLedger chooses local runtime ownership.
ProviderOutbox chooses provider send ownership.
```

## 2. Official Source Facts

### 2.1 Telegram update identity

Official Bot API facts:

- Updates are delivered by either `getUpdates` or webhook, not both.
- Incoming updates are stored on Telegram servers until received, but not longer than 24 hours.
- `Update.update_id` is unique and sequential enough to ignore repeated updates or restore sequence.
- If no new update appears for at least a week, the next update id may become random instead of continuing the old sequence.
- A single `Update` has at most one optional payload field.

Implication:

```text
ProcessedProviderUpdate key = provider + accountBindingId + botUserId + update_id
```

But:

```text
update_id is an ingestion id.
It is not provider message identity.
It is not route identity.
It is not retry id for outbound sends.
```

### 2.2 Telegram message identity

Official Bot API `Message` facts:

- `message_id` is unique inside the chat.
- In specific scheduled cases `message_id` can be `0`, and the message is unusable until sent.
- `message_thread_id` identifies the message thread or forum topic for supergroups and private chats.
- `is_topic_message` is true when the message is sent to a topic in a forum supergroup or private chat with the bot.
- `reply_to_message` exists only for replies in the same chat and message thread.
- `reply_to_message` is not recursively expanded.
- `external_reply` may point to another chat or forum topic.

Implication:

```text
ProviderMessageKey =
  telegram + accountBindingId + botUserId + chat_id + message_thread_id? + message_id
```

`message_id=0` policy:

```text
Do not create ExternalMessageLink for message_id=0.
Do not use it as a reply target.
Process as provider-visible status or ignore depending on update kind.
```

### 2.3 Telegram reply send identity

Official `ReplyParameters` facts:

- `message_id` points to the message being replied to in the current chat or in `chat_id`.
- `allow_sending_without_reply` lets the message send even if the reply target is missing, but it is always false for replies in another chat or forum topic.
- `quote` must exactly match the original message substring or send fails.

MVP policy:

```text
Use reply_parameters.message_id only for same provider conversation.
Do not set ReplyParameters.chat_id for cross-chat replies in MVP.
Do not set quote in MVP.
If reply target fails, retry once without reply_parameters but keep chat_id and message_thread_id.
Record degraded delivery.
```

### 2.4 Telegram callback query limits

Official `CallbackQuery` facts:

- If the button was attached to a bot-sent message, `message` can be present.
- If the button came from inline mode, `inline_message_id` can be present.
- `message` is `MaybeInaccessibleMessage`.
- `data` is not proof by itself, because the message that originated the query can contain no callback buttons with this data.
- Clients show progress until `answerCallbackQuery` is called.

Safe setup confirmation:

```text
callback data contains a signed nonce and provisionRequestId
from.id matches allowed Telegram user id
pending probe record exists and is unexpired
callback message id matches stored probe provider message id when available
if callback message is inaccessible, accept only as user-confirmed probe tap, not as fresh route identity
route activation still depends on stored createForumTopic + sendMessage result
answerCallbackQuery is always called
```

Top callback policies:

1. Signed callback data plus stored probe message correlation - 🎯 9   🛡️ 9   🧠 5, approx `500-1100` LOC.
   Best default. Does not rely on fragile visible text or topic title.

2. Rely on `callback_query.message.message_thread_id` when present - 🎯 6   🛡️ 7   🧠 3, approx `250-650` LOC.
   Useful extra proof, but not enough because `message` can be inaccessible.

3. Activate route from callback `data` alone - 🎯 3   🛡️ 4   🧠 2, approx `150-350` LOC.
   Too spoofable if callback data leaks or stale buttons survive.

## 3. Provider-Neutral Identity Contract

### 3.1 Four identities must stay separate

```text
ProviderUpdateKey:
  idempotency for inbound transport admission

ProviderConversationKey:
  durable external conversation or route container

ProviderMessageKey:
  durable external message identity

ProviderReplyReference:
  provider-specific pointer from a new inbound message to an older provider message
```

Do not collapse them.

Bad collapse examples:

```text
update_id as message id
topic title as route id
chat_id alone as team route
reply quoted text as teammate target
message_id without chat_id
message_id without accountBindingId
```

### 3.2 Core models

Recommended pure domain models:

```ts
type ProviderKind = "telegram" | "discord" | "whatsapp";

interface ProviderUpdateKey {
  provider: ProviderKind;
  accountBindingId: string;
  botOrAppId: string;
  updateId: string;
}

interface ProviderConversationKey {
  provider: ProviderKind;
  accountBindingId: string;
  botOrAppId: string;
  containerId: string;
  threadId: string | null;
}

interface ProviderMessageKey {
  provider: ProviderKind;
  accountBindingId: string;
  botOrAppId: string;
  containerId: string;
  threadId: string | null;
  messageId: string;
}

interface ProviderReplyReference {
  provider: ProviderKind;
  sameConversation: boolean;
  referencedMessageKey: ProviderMessageKey | null;
  rawKind:
    | "telegram_reply_to_message"
    | "telegram_external_reply"
    | "discord_message_reference"
    | "discord_forward_reference"
    | "whatsapp_context_message"
    | "none";
}
```

Important:

```text
ProviderReplyReference does not decide target.
It only points at a ProviderMessageKey candidate.
ExternalMessageLink lookup decides target.
```

### 3.3 Route binding vs message link

Route binding:

```text
ProviderConversationRouteBinding
  providerConversationKey -> teamName + routeGeneration + routeState
```

Message link:

```text
ExternalMessageLink
  providerMessageKey -> internalMessageId + teamName + visibleOwner + routeTarget + visibilityState
```

This split is non-negotiable.

Reason:

```text
The team topic selects the team.
The reply target message selects the member only if it links to that member.
```

## 4. Provider Matrix

### 4.1 Telegram

Conversation key:

```text
telegram + accountBindingId + botUserId + chat_id + message_thread_id?
```

Team route:

```text
private topic mode:
  message_thread_id routes to team

selector mode:
  chat_id + active selection routes to team
```

Reply reference:

```text
reply_to_message in same chat/thread -> eligible for ExternalMessageLink lookup
external_reply -> not eligible for teammate route in MVP
quote -> display only
```

Inbound identity:

```text
update_id for processing idempotency
chat_id + message_thread_id + message_id for message identity
from.id for sender identity gate
```

Outbound identity:

```text
sendMessage response message_id is required before link is complete
network timeout after send is ambiguous
```

### 4.2 Discord future adapter

Official Discord facts:

- A message has `id`, `channel_id`, `author`, `content`, optional `message_reference`, and optional `referenced_message`.
- `MESSAGE_CONTENT` is a privileged intent.
- Without message content intent, guild message `content`, `embeds`, `attachments`, and `components` can be empty, with exceptions for DMs, app-sent messages, mentions, and context menu targets.
- Threads are channel-like objects. A thread has its own `id` and `parent_id`.
- Public thread and starter message can share ids in some creation paths.
- Replies use `message_reference`.
- Discord forwards also use `message_reference`, but with a different reference type and snapshot semantics.

Implication:

```text
Discord is not "Telegram topics with another name".
In Discord, a thread is closer to a channel id than to Telegram message_thread_id.
```

Future Discord keys:

```text
ProviderConversationKey =
  discord + accountBindingId + applicationId + channel_id + null

If channel is a thread:
  containerId = thread channel_id
  threadId = null
  parent channel id is display/metadata
```

Future Discord route options:

1. One private thread/channel per team in a configured server - 🎯 7   🛡️ 8   🧠 7, approx `2500-5200` LOC.
   Strong route identity, but user setup is heavier.

2. DM with selector mode - 🎯 7   🛡️ 7   🧠 5, approx `1500-3200` LOC.
   Easier setup, weaker multitasking UX.

3. One Discord bot per team - 🎯 4   🛡️ 6   🧠 8, approx `3500-7000` LOC.
   Too much token and ownership complexity.

### 4.3 WhatsApp future adapter

Official Meta Graph message-send facts from the live reference:

- Send endpoint is `POST /{Version}/{Phone-Number-ID}/messages`.
- Request includes `recipient_type`, `to`, `type`, and optional `context`.
- `MessageContext.message_id` is the id of the message being replied to.
- Successful response includes a `messages` array with `id`.

Implication:

```text
WhatsApp can support reply-link correlation.
WhatsApp does not provide a native team-topic container equivalent for normal consumer chat UX.
```

Future WhatsApp route options:

1. One contact chat plus selector mode - 🎯 8   🛡️ 7   🧠 5, approx `2200-4500` LOC.
   Most realistic for user convenience.

2. One phone number per team - 🎯 3   🛡️ 6   🧠 9, approx `6000-12000` LOC.
   Bad for cost, setup, compliance, and user mental model.

3. Ignore WhatsApp until Telegram is stable - 🎯 9   🛡️ 9   🧠 1, approx `0-200` LOC.
   Best MVP sequencing. Keep core provider-neutral so this is not a rewrite.

## 5. Edits And Deletes

### 5.1 Telegram edits

Telegram emits `edited_message` when a known message was edited.

MVP policy:

```text
If provider message is not yet delivered to runtime:
  update normalized inbound body and audit edit

If provider message is delivered or awaiting reply:
  append a local correction row linked to original turn
  do not mutate already delivered prompt text silently

If provider message already has provider reply sent:
  store edit event for history
  do not auto-send a correction unless user explicitly sends another message
```

Reason:

```text
Mutating a prompt after a lead or teammate already saw it can invalidate reply proof.
```

### 5.2 Telegram deletes

Normal bot chats do not give a simple universal "message deleted" update for every user-deleted message.

MVP policy:

```text
Do not depend on delete updates.
If a reply target is deleted and Telegram rejects reply_parameters:
  retry without reply_parameters
  keep same chat_id + message_thread_id
  mark degraded delivery
```

### 5.3 Discord edits/deletes

Discord has `MESSAGE_UPDATE` and `MESSAGE_DELETE` events through gateway intents.

MVP future policy:

```text
MESSAGE_UPDATE can be partial.
Patch local provider message only before runtime delivery.
After runtime delivery, append correction.
MESSAGE_DELETE tombstones provider message link but does not delete internal history.
```

### 5.4 WhatsApp edits/deletes

Do not design MVP around inbound edit/delete support for WhatsApp.

Policy:

```text
Treat inbound WhatsApp messages as immutable for routing.
Use status webhooks for outbound state only.
```

## 6. Local App Contract Findings

### 6.1 Good existing primitives

`TeamInboxWriter`:

- generates a `messageId` when missing;
- persists `relayOfMessageId`;
- persists `conversationId`;
- persists `replyToConversationId`;
- uses file locks and verifies the write.

`TeamInboxReader`:

- preserves `relayOfMessageId`;
- preserves `conversationId`;
- creates deterministic legacy ids for rows without `messageId`.

`TeamSentMessagesStore`:

- preserves `relayOfMessageId`;
- preserves `conversationId`;
- preserves `replyToConversationId`.

`OpenCodePromptDeliveryLedger`:

- already models reply proof using `relayOfMessageId`;
- has useful states for visible reply observation.

### 6.2 Local gaps that matter for messenger projection

Current `TeamDataService.sendMessage()`:

```text
accepts relayOfMessageId in SendMessageRequest
does not pass relayOfMessageId into controller.messages.sendMessage()
```

Impact:

```text
Manual/UI messages cannot be trusted for Telegram auto-projection until this is fixed.
```

Current `InboxMessage.source` union:

```text
does not include external_messenger_inbound
does not include external_messenger_outbound
does not include external_messenger_status
```

Impact:

```text
Connector messages would be forced into vague existing source values.
That makes loop prevention and visibility policy weaker.
```

Current `TeamMessageFeedService`:

```text
dedupes
caches
links passive user reply summaries by timing/text
mixes inbox, lead session text, and sent messages
```

Impact:

```text
It is useful UI projection.
It must not be the provider projection source.
```

Current `sentMessages.json`:

```text
capped at 200 rows
not a complete external message link store
```

Impact:

```text
Do not store ExternalMessageLink only in sentMessages.json.
```

## 7. Reply Routing Algorithm

Recommended pure core algorithm:

```text
1. Normalize update into ProviderInboundEvent.
2. Verify sender identity before route resolution.
3. Resolve ProviderConversationKey.
4. Look up ProviderConversationRouteBinding.
5. If no active binding, return setup/help/control decision.
6. Build ProviderReplyReference.
7. If reply reference is same-conversation and has ProviderMessageKey:
     look up ExternalMessageLink.
8. If link exists and target is external-replyable:
     route to link target.
9. If link missing:
     route to lead with missing_reply_link context.
10. If no reply reference:
     route to lead for the team.
11. Persist route decision before any runtime delivery.
```

Forbidden shortcuts:

```text
route to teammate by Telegram topic title
route to teammate by quoted text
route to teammate by visible prefix like "[Alice]"
route to teammate by last teammate who spoke
route to teammate by newest TeamMessageFeedService row
route to teammate by timestamp proximity alone
```

## 8. ExternalMessageLink States

Recommended link states:

```text
pending_provider_send
provider_sent
provider_send_unknown
provider_message_unavailable
internal_message_deleted
route_tombstoned
```

Recommended fields:

```ts
interface ExternalMessageLinkRecord {
  id: string;
  providerMessageKey: ProviderMessageKey;
  internalMessageId: string;
  internalStore:
    | "messenger_conversation"
    | "team_inbox"
    | "team_sent_messages"
    | "lead_transcript"
    | "runtime_delivery";
  teamName: string;
  routeId: string;
  routeGeneration: number;
  visibleOwnerKind: "lead" | "teammate" | "user" | "system";
  visibleOwnerName: string | null;
  externalReplyable: boolean;
  externalSafe: boolean;
  linkState:
    | "pending_provider_send"
    | "provider_sent"
    | "provider_send_unknown"
    | "provider_message_unavailable"
    | "internal_message_deleted"
    | "route_tombstoned";
  payloadHash: string;
  createdAt: string;
  updatedAt: string;
}
```

`externalReplyable=false` examples:

```text
status messages
setup/help messages
internal lead notes
tool summaries
task-only updates
messages from tombstoned routes
provider send unknown
```

## 9. Loop Prevention

Loop risk:

```text
Telegram inbound -> local inbox row -> UI feed observer sees row -> provider outbox sends it back to Telegram
```

Hard rule:

```text
Provider-originated inbound rows are never provider-outbound candidates.
Only runtime-visible replies with exact relayOfMessageId or explicit ProviderMessageLink can enqueue provider outbox.
```

Required fields:

```text
originKind = provider_inbound | provider_outbound | local_user | local_runtime | local_system
externalProjectionState = never | candidate | ready | sent | degraded | ambiguous
```

Current `InboxMessage.source` is not enough for this. Messenger needs feature-owned conversation/outbox rows.

## 10. Test Matrix

Pure domain tests:

```text
telegram normal topic message routes to lead
telegram reply_to linked teammate message routes to teammate
telegram reply_to linked lead message routes to lead
telegram external_reply never routes to teammate
telegram unknown message_thread_id returns setup/help
telegram missing message_thread_id in topic mode returns setup/help
telegram callback with signed nonce confirms probe
telegram callback with stale nonce rejected
telegram callback with inaccessible message uses stored probe metadata only
telegram message_id zero creates no link
discord reply message_reference linked teammate routes to teammate
discord forward message_reference never routes to teammate
whatsapp context.message_id linked teammate routes to teammate
whatsapp no context routes to selected team lead or setup
missing ExternalMessageLink routes to lead with context
tombstoned route does not deliver
provider inbound row never enqueues outbox
provider outbox ambiguous does not retry blindly
edited inbound before runtime patches local normalized message
edited inbound after runtime appends correction
deleted provider message tombstones link only
```

Fixture tests:

```text
Telegram raw update fixtures:
  message
  edited_message
  callback_query with message
  callback_query with inaccessible message
  reply_to_message
  external_reply
  topic service messages

Discord raw event fixtures:
  MESSAGE_CREATE in DM
  MESSAGE_CREATE in guild channel without content intent
  MESSAGE_CREATE in thread
  MESSAGE_UPDATE partial
  MESSAGE_DELETE
  reply vs forward message_reference

WhatsApp raw webhook fixtures:
  inbound text
  inbound reply with context
  outbound status
  multi-entry webhook body
```

## 11. Implementation Options

1. Strict link-table routing in provider-neutral core - 🎯 9   🛡️ 10   🧠 6, approx `1400-3000` LOC.
   This is the recommended path. More code, but it makes wrong-recipient sends much harder.

2. Telegram-specialized routing first, then abstract later - 🎯 7   🛡️ 7   🧠 4, approx `900-1800` LOC.
   Faster for Telegram, but likely creates rewrite pressure for Discord and WhatsApp.

3. Feed-based inference with newest row and sender prefixes - 🎯 3   🛡️ 3   🧠 2, approx `300-800` LOC.
   Reject. It is easy to implement but unsafe for multi-team and multi-teammate routing.

## 12. Updated Decisions

- Provider update id and provider message id are separate.
- Route binding chooses team.
- ExternalMessageLink chooses reply target.
- Reply text and quote text are display only.
- Telegram `external_reply` is not teammate-routeable in MVP.
- Telegram `callback_query.data` is not proof without signed nonce and stored probe record.
- Discord future adapter should treat thread id as channel id, not as Telegram-style thread id.
- WhatsApp future adapter should use selector mode, not fake team topics.
- Provider-originated inbound rows must never be provider-outbound candidates.
- Edits after runtime delivery append correction instead of mutating delivered prompt.
- Deleted/unavailable provider messages tombstone links but do not delete internal history.

## 13. Remaining Lowest-Confidence Points

1. Telegram callback in private bot-chat topic across clients - 🎯 7   🛡️ 8   🧠 5.
   Need fixture proving when `callback_query.message.message_thread_id` exists and when message becomes inaccessible.

2. Telegram private-topic deleted-thread error text - 🎯 6   🛡️ 8   🧠 4.
   Need live provider responses to classify terminal vs ambiguous.

3. Discord bot UX for Agent Teams - 🎯 6   🛡️ 7   🧠 7.
   Need product decision whether Discord is DM selector mode or configured guild/thread mode.

4. WhatsApp practicality - 🎯 7   🛡️ 7   🧠 8.
   Official API is heavier and lacks team topics. Keep as future adapter, not MVP.

5. Local UI source taxonomy - 🎯 8   🛡️ 9   🧠 4.
   Need concrete source values or feature-owned projection rows before implementation.

## 14. Source Links

- Telegram Bot API `Update`: https://core.telegram.org/bots/api#update
- Telegram Bot API `Message`: https://core.telegram.org/bots/api#message
- Telegram Bot API `ReplyParameters`: https://core.telegram.org/bots/api#replyparameters
- Telegram Bot API `CallbackQuery`: https://core.telegram.org/bots/api#callbackquery
- Discord Message Resource: https://docs.discord.com/developers/resources/message
- Discord Gateway Intents: https://docs.discord.com/developers/events/gateway
- Discord Threads: https://docs.discord.com/developers/topics/threads
- Meta WhatsApp Cloud API message send reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
