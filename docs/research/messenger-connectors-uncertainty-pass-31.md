# Messenger Connectors - Uncertainty Pass 31

Date: 2026-04-29
Scope: Telegram private-chat topics, one-topic-per-team topology, reply-to teammate routing, topic registry recoverability, and local inbox alignment

## Executive Delta

The next lowest-confidence area is not whether Telegram supports topics. It does.

The weak point is whether topics can be used as a stable product navigation layer without losing routing correctness:

```text
Telegram private topic id
-> app team route
-> lead or teammate recipient
-> durable local message
-> agent reply
-> Telegram message in the same topic
-> user replies to a concrete teammate message
```

The correct approach is:

```text
One Telegram topic per team.
Route the topic to the team.
Route the recipient inside the team by reply-to message ledger, explicit command, or UI buttons.
Default no-reply messages to the lead.
Never create one bot or one topic per teammate as the default.
```

⚠️ Main new finding: Telegram Bot API exposes create/edit/delete topic operations, but I do not see a Bot API method for listing all private-chat topics and recovering their ids. That means our app must treat topic ids as durable provider state and store them locally/backend-side from creation time. If the registry is lost, topic recovery is weak and may require creating replacement topics.

## Source Facts Rechecked

Telegram official facts checked on 2026-04-29:

- Bot API 9.3, dated December 31, 2025, added private-chat topic mode support.
- Bot API 9.3 added `User.has_topics_enabled`, `Message.message_thread_id`, and `Message.is_topic_message` support for private chats with topic mode enabled.
- Bot API 9.3 added `message_thread_id` support in private chats for `sendMessage`, media methods, `sendMediaGroup`, `copyMessage`, `forwardMessage`, `sendChatAction`, and topic-management methods.
- Bot API 9.4, dated February 9, 2026, allowed bots to create topics in private chats with `createForumTopic`.
- Bot API 9.4 added a BotFather setting that can prevent users from creating and deleting topics in private chats.
- `User.has_topics_enabled` is returned by `getMe` and means the bot has forum topic mode enabled in private chats.
- `User.allows_users_to_create_topics` is returned by `getMe` and indicates whether users may create/delete topics in private chats.
- `createForumTopic` can create a topic in a forum supergroup chat or a private chat with a user.
- `editForumTopic`, `deleteForumTopic`, and `unpinAllForumTopicMessages` support private chats with a user.
- `sendMessage.message_thread_id` routes a message to a forum/private-chat topic.
- Incoming `Message` includes optional `message_thread_id`, `is_topic_message`, `reply_to_message`, `media_group_id`, and text/media fields.
- `ReplyParameters` lets a bot reply to a specific message id in the current chat or a specified chat.
- `direct_messages_topic_id` is for channel direct messages chats and should not be confused with forum/private-chat `message_thread_id`.
- Telegram forum topics are conceptually message threads. Nested message threads inside topics are not supported.
- Telegram clients can have a "View as messages" setting for forums that shows messages from all topics in one stream. Treat this as a warning that visible topic grouping is a UX layer, not a routing authority.

Sources:

- https://core.telegram.org/bots/api-changelog
- https://core.telegram.org/bots/api#getme
- https://core.telegram.org/bots/api#user
- https://core.telegram.org/bots/api#message
- https://core.telegram.org/bots/api#sendmessage
- https://core.telegram.org/bots/api#replyparameters
- https://core.telegram.org/bots/api#createforumtopic
- https://core.telegram.org/bots/api#editforumtopic
- https://core.telegram.org/bots/api#deleteforumtopic
- https://core.telegram.org/api/forum

Local code facts:

- `InboxMessage` already has `from`, `to`, `messageId`, `relayOfMessageId`, `conversationId`, and `replyToConversationId`.
- `TeamDataService.sendMessage` passes `conversationId` and `replyToConversationId` into the message controller.
- `CrossTeamService` already uses `conversationId` and `replyToConversationId` for cross-team threads.
- OpenCode runtime delivery writes direct replies to either `user_sent_messages` or `member_inbox`.
- `MessagesFilterPopover` already derives participants from message `from` and `to`.
- `MessagesPanel` pending reply logic already treats `from=user -> to=member` and `from=member -> to=user` as meaningful route signals.
- Current message model is string-name based, not stable-id based. Prior passes already identified stable route identity as a required feature layer.

Implication:

```text
The app can represent the desired conversation shape,
but messenger connectors need a provider-neutral route registry
and provider message link ledger before Telegram topics are safe.
```

## 1. Topic Is Team Scope, Not Recipient Scope

One topic should map to one team:

```text
chatId + messageThreadId -> teamRouteId
```

Recipient should be resolved inside that team:

```text
incoming message in team topic
-> if it replies to a known bot message from teammate X, route to teammate X
-> else if it contains explicit recipient command/control, route to that recipient
-> else route to lead
```

Do not use topic title to route.

Topic title is display state:

```text
"Frontend - Acme"
"API - Acme"
"API - Acme (archived)"
```

Route identity must be persisted as:

```ts
type MessengerTeamTopicRoute = {
  routeId: string;
  provider: 'telegram';
  botScope: 'official' | 'own_bot';
  botId: string;
  telegramChatIdHash: string;
  telegramChatIdEncrypted?: string;
  telegramMessageThreadId: number;
  teamId: string;
  teamGeneration: number;
  projectId: string | null;
  projectGeneration: number | null;
  displayTitle: string;
  status:
    | 'active'
    | 'create_pending'
    | 'create_ambiguous'
    | 'renaming'
    | 'renamed'
    | 'delete_seen'
    | 'replaced'
    | 'disabled'
    | 'error';
  createdAt: string;
  updatedAt: string;
};
```

For official shared bot, backend needs this route registry. For own-bot local mode, desktop can own it locally.

## 2. The Recoverability Problem

Creation is straightforward:

```text
user starts bot
desktop/backend knows Telegram chat id
app creates topic for a team
Telegram returns ForumTopic
app stores message_thread_id
```

The low-confidence part is recovery:

```text
What if our route registry is lost?
What if topic creation succeeded but the process crashed before storing topic id?
What if user deletes or renames a topic?
What if app creates a duplicate topic after a timeout?
```

I do not see a Bot API method equivalent to "list my private-chat topics". Telegram's MTProto API has forum topic listing for forums, but Bot API docs expose topic creation/edit/delete operations and no simple list method. We should not build a core invariant on being able to reconstruct topic state from Telegram later.

Therefore:

```text
Topic registry is authoritative local/backend product state.
Telegram is an external projection.
```

Creation must use a two-phase state:

```text
create_pending -> active
create_pending -> create_ambiguous
create_ambiguous -> replaced
```

If creation response is lost:

- do not keep retrying blindly;
- show diagnostics in app;
- allow "Create replacement topic";
- optionally send a message in the general/default bot chat asking the user to pick the right topic if we can design a safe verification flow later.

## 3. User Topic Deletion And BotFather Settings

Bot API 9.4 added a setting to prevent users from creating and deleting topics in private chats.

Recommended official bot configuration:

```text
Private chat topics enabled.
Users cannot create/delete topics.
Bot manages team topics.
```

Why:

- fewer orphan routes;
- fewer topic id invalidation bugs;
- fewer accidental duplicates;
- cleaner support story.

But the app must still handle deletion or invalid topic errors:

```text
sendMessage(chatId, message_thread_id) fails
-> mark topic route as error or delete_seen
-> do not fallback silently to general chat
-> create replacement topic only behind an explicit repair flow
```

Silent fallback to general chat is dangerous because the user may read a message outside the intended team context.

## 4. Reply-To Teammate Routing

The desired product behavior:

```text
User opens team topic.
Bot posts messages from lead and teammates.
User replies to a concrete message.
App routes the reply to that concrete teammate.
```

This is viable if we store provider message links:

```ts
type ProviderMessageLink = {
  provider: 'telegram';
  routeId: string;
  providerChatIdHash: string;
  providerMessageThreadId: number;
  providerMessageId: number;
  internalMessageId: string;
  internalTeamId: string;
  internalFromMemberId: string;
  internalToMemberId: string | null;
  direction: 'telegram_to_app' | 'app_to_telegram';
  createdAt: string;
};
```

Incoming reply resolution:

```text
if update.message.reply_to_message.message_id exists:
  lookup ProviderMessageLink by chatId + messageThreadId + reply_to_message.message_id
  if found and linked internal message came from teammate:
    route to that teammate
  if found and linked internal message came from lead:
    route to lead
  if found and linked internal message came from user:
    route to lead or use explicit reply target from that internal row
else:
  use explicit recipient control or default to lead
```

Important edge case:

```text
Telegram topics cannot have nested message threads.
Reply-to is only a pointer to a message, not a durable sub-thread per teammate.
```

Therefore, reply-to should be a routing hint, not the entire conversation model.

## 5. Explicit Recipient Controls

Reply-to is natural but insufficient.

Users will send plain messages into a topic without replying. For those messages, the app needs a deterministic default and optional controls:

```text
Default:
  message without reply -> team lead

Explicit route:
  /to teammate-name message
  or inline button "Reply to Alice"
  or short command menu
```

Do not rely on Telegram mentions for routing:

- teammate names may not be Telegram users;
- agents are not Telegram accounts;
- inline mention semantics depend on Telegram user privacy and previous contact conditions;
- local app member names can change.

Suggested official MVP:

```text
No global "active recipient" state at first.
Use reply-to for specific teammate replies.
Use /to for explicit direct messages.
Default to lead.
```

This is less magical but safer than hidden mutable state.

## 6. Message Text Format In Telegram

Because client topic grouping can be changed by the user and messages can appear in flattened views, every bot message should carry lightweight context.

Example:

```text
[Frontend] Alice
I pushed the fix and need review on the auth callback.
```

For lead:

```text
[Frontend] Lead
I will ask Alice to check the failing test.
```

For user-sent routed message acknowledgements:

```text
[Frontend] to Alice
Forwarded.
```

Rules:

- include team label in the first line;
- include member display name for agent replies;
- keep prefixes short;
- do not include internal ids;
- do not rely only on topic title;
- avoid markdown complexity unless using explicit Telegram entities.

This makes flattened Telegram views survivable.

## 7. Topic Lifecycle State Machine

Suggested route lifecycle:

```text
not_created
-> create_pending
-> active
-> renaming
-> active
-> disabled

create_pending
-> create_ambiguous
-> replaced

active
-> send_failed_topic_missing
-> repair_required
-> replacement_pending
-> active

active
-> archived
-> disabled
```

Do not delete topics automatically when a team is archived.

Recommended archive behavior:

- rename topic to include a compact archived marker;
- send one final "team archived" message;
- stop routing new user messages or route them to lead with a clear archived response;
- keep local route state for historical provider links.

Deletion destroys user-visible history in Telegram and makes provider message links harder to explain.

## 8. Rename And Duplicate Teams

Current app still relies heavily on `teamName`, while prior research recommended stable team ids and route generations.

Telegram topic routing should not follow only team name.

If team is renamed:

```text
teamId stays stable
topic route stays stable
displayTitle is updated
editForumTopic is best-effort
message prefix changes after local commit
```

If two projects have same team name:

```text
topic title must include a compact project discriminator
routeId must include project/team stable ids
```

Example topic title:

```text
Frontend - acme-web
Frontend - mobile-app
```

Title length is capped, so the full identity must be in the registry, not in Telegram title.

## 9. Topic Creation Timing

Three possible creation timings:

### Lazy create on first outbound/inbound use

Pros:

- fewer unused topics;
- less setup friction.

Cons:

- first message may be slower;
- creation failure blocks communication at the worst moment;
- ambiguous creation state can happen during a real user message.

### Eager create during connect wizard

Pros:

- setup verifies topic capability early;
- failures are visible before real traffic;
- topic registry is ready.

Cons:

- creates topics for teams user may never use;
- can clutter Telegram.

### Hybrid

Recommended:

```text
Create a topic for selected/active teams during connect wizard.
Lazy-create for other teams when user enables them.
```

This matches "minimum user actions" without creating too many topics.

## 10. Route Ambiguity Cases

Inbound ambiguity cases:

- message has no `message_thread_id`;
- message has a thread id not in registry;
- message has a known thread id but route is disabled;
- message replies to a provider message id not in ledger;
- reply target maps to a deleted/renamed teammate;
- reply target maps to an old team generation;
- user uses `/to` for an unknown teammate;
- topic title was manually changed;
- duplicate topic exists for the same team;
- user forwards/copies messages between topics;
- media group spans a topic but parts arrive separately;
- update contains `direct_messages_topic` from channel direct messages, not private chat topic;
- bot receives a message outside private chat if added to a group.

Resolution policy:

```text
Unknown topic -> do not deliver to agent, send repair/unknown-topic notice.
Known topic + unknown reply target -> route to lead with quoted context.
Known topic + stale teammate -> route to lead and mention stale target in internal metadata.
No topic id -> onboarding/default command handling only.
```

Never guess a team by topic title.

## 11. Local UI Implications

The current Messages panel can already show participant flows from `from` and `to`. For messenger connectors, add a feature-local projection rather than rewriting the existing panel first:

```ts
type MessengerConversationProjection = {
  routeId: string;
  teamId: string;
  provider: 'telegram';
  providerTopicTitle: string;
  messages: Array<{
    internalMessageId: string;
    providerMessageId?: number;
    fromMemberId: string;
    toMemberId?: string;
    replyToInternalMessageId?: string;
    direction: 'inbound' | 'outbound';
    deliveryState: 'pending' | 'sent' | 'failed' | 'ambiguous';
  }>;
};
```

The renderer can keep using participant filters, but messenger-specific state should live in `src/features/messenger-connectors/renderer`:

```text
messenger feature hook
-> maps route/thread state into view model
-> existing MessagesPanel can show the durable local messages
-> optional connector status panel shows Telegram topic health
```

Do not put Telegram concepts directly into shared `InboxMessage` unless they are provider-neutral.

Provider-specific fields belong in a feature table/store:

```text
provider_message_links
provider_route_registry
provider_delivery_ledger
```

## 12. Architecture Fit

This feature clearly qualifies for the canonical feature architecture:

```text
src/features/messenger-connectors/
  contracts/
  core/
    domain/
      route.ts
      topic.ts
      recipient-resolution.ts
      provider-message-link.ts
    application/
      ports.ts
      connect-messenger.ts
      receive-provider-update.ts
      send-provider-reply.ts
      repair-topic-route.ts
  main/
    composition/
    adapters/
      input/
        ipc/
        telegram-webhook/
        desktop-relay/
      output/
        telegram/
        team-messages/
        local-store/
    infrastructure/
  preload/
  renderer/
```

Core domain invariants:

```text
1. Provider topic title never determines route identity.
2. Provider thread id maps to exactly one active team route per bot/chat.
3. Recipient resolution is deterministic and auditable.
4. Unknown topic never reaches an agent as a normal user message.
5. Every outbound Telegram message that can be replied to has a ProviderMessageLink.
6. Topic repair never silently changes the user's message destination.
```

## 13. Top 3 Options

### Option 1 - One topic per team, reply-to ledger, default to lead, `/to` escape hatch

🎯 8   🛡️ 9   🧠 6

Approx changed LOC: 2500-5500.

What it means:

- each team has one Telegram private topic;
- inbound messages in that topic route to the lead by default;
- replying to a known teammate message routes to that teammate;
- `/to teammate message` provides explicit routing;
- topic id and provider message links are stored durably;
- unknown/stale topics enter repair flow.

Why this is best:

- matches the user's selected model;
- avoids topic explosion;
- works with current `from`/`to` message model;
- scales to many teams better than per-teammate topics;
- keeps routing deterministic.

Risk:

- users must learn reply-to or `/to` for teammate-specific messages;
- if provider message link ledger is missing, teammate routing falls back to lead;
- requires solid route registry.

### Option 2 - One topic per team with mutable active recipient controls

🎯 6   🛡️ 7   🧠 7

Approx changed LOC: 3500-7000.

What it means:

- each topic has controls such as "Active recipient: Alice";
- user taps inline buttons or commands to switch active recipient;
- plain messages route to current active recipient until changed.

Why it is tempting:

- fewer reply-to requirements;
- feels convenient on mobile;
- user can have a visible selected target.

Risk:

- hidden mutable state across desktop and phone is easy to misunderstand;
- two devices/users can change active recipient unexpectedly;
- stale controls can route messages incorrectly;
- callback handling and status messages add complexity.

This can be added later after Option 1, but I would not make it the first model.

### Option 3 - One topic per teammate or per internal conversation

🎯 4   🛡️ 6   🧠 8

Approx changed LOC: 4000-9000.

What it means:

- team lead has one topic;
- each teammate has a separate topic;
- or each conversation creates a topic.

Why it looks reliable:

- recipient is obvious from topic;
- fewer reply-to resolution rules.

Why it is worse:

- topic count explodes;
- Telegram UI becomes cluttered;
- team context fragments;
- archiving/renaming/recovering many topics is painful;
- cross-team/project grouping becomes harder;
- user wanted one team context, not dozens of technical threads.

Use only for a future "power mode" if users explicitly ask for per-agent topics.

## 14. Decision Update

Recommended design:

```text
Default official bot:
  one private topic per team
  topic id maps to team route
  default route to lead
  reply-to route to teammate through ProviderMessageLink
  `/to` command as explicit escape hatch
  no mutable active recipient in MVP
```

Required build blocks before implementation:

```text
1. Stable TeamRoute identity independent of teamName.
2. MessengerTopicRegistry with route generations and repair states.
3. ProviderMessageLink ledger for every Telegram outbound message.
4. RecipientResolver pure domain service.
5. UnknownTopicPolicy that never sends unknown messages to agents.
6. TopicRepair use case.
7. Tests for duplicate, deleted, renamed, stale, and unknown topics.
```

The most important invariant:

```text
Telegram topic/thread id chooses team.
Provider reply-to message id chooses teammate.
Plain topic message chooses lead.
```

## 15. Tests To Write First

Domain tests:

- known topic + no reply -> lead;
- known topic + reply to lead message -> lead;
- known topic + reply to teammate message -> teammate;
- known topic + reply to user message -> lead;
- known topic + unknown reply message id -> lead with ambiguity metadata;
- unknown topic -> repair/notice, not agent delivery;
- disabled topic -> archived/disabled response, not agent delivery;
- duplicate topic route -> terminal config error;
- renamed team -> same route id, updated display title;
- deleted teammate -> lead fallback with stale target metadata;
- `/to Alice hello` -> Alice;
- `/to unknown hello` -> lead or error notice by policy;
- media group in known topic -> same team route for all parts.

Adapter tests:

- `createForumTopic` success persists `message_thread_id`;
- create response lost enters `create_ambiguous`;
- `sendMessage` includes correct `message_thread_id`;
- `sendMessage` failure for topic not found marks repair-required;
- inbound update stores provider message link before local delivery ACK;
- outbound provider message id is stored before considering Telegram delivery complete;
- duplicate webhook with same provider message id returns existing local route.

Renderer tests:

- connector status panel shows topic healthy/error/repair-required;
- message row prefix includes team/member context for Telegram projection;
- participant filters still work with messenger-originated messages;
- reply-to unavailable shows lead fallback reason.

## 16. Remaining Low-Confidence Areas

Still worth deeper research next:

- exact Telegram client UX for private-chat topics on mobile and desktop after Bot API 9.3/9.4;
- whether BotFather private topic settings can be configured programmatically or only manually;
- exact error codes returned when a private topic is deleted or disabled;
- whether Telegram private topics expose enough update events to detect user rename/delete promptly;
- how long topic titles can remain readable with many projects and similar team names;
- whether `sendMessageDraft` could improve "agent is typing" UX per team topic without creating noisy messages;
- how to migrate a user from official shared bot topics to own-bot topics without losing local route history.

