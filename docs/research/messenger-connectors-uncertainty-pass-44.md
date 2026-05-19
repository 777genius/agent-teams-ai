# Messenger Connectors - Uncertainty Pass 44

Date: 2026-04-30
Scope: private-chat topic capability contract, topic lifecycle repair, grammY support, and feature-local durable store boundary

## 1. Bottom Line

Private-chat topics remain the best default Telegram UX, but the implementation must treat them as a gated provider capability, not as a guaranteed always-on primitive.

Updated rule:

```text
Private-chat topics are default only after getMe and live probe prove the bot account is configured for private topic mode.
```

The safest route:

```text
getMe.has_topics_enabled === true
createForumTopic(private chat, team name) succeeds
sendMessage(chat_id, message_thread_id, probe button) succeeds
callback or inbound message confirms same chat_id + message_thread_id
then route becomes active
```

Important correction from this pass:

```text
Do not rely on closeForumTopic or reopenForumTopic for private-chat topics.
Current Bot API docs describe close/reopen for forum supergroups only.
For private-chat topic repair, use disable route, delete/recreate when safe, or fallback selector mode.
```

## 2. Official Source Facts

### 2.1 Private topic chronology

Bot API 9.3 on December 31, 2025 added private-chat topic support:

- `User.has_topics_enabled` returned by `getMe`.
- `Message.message_thread_id` and `Message.is_topic_message` for private chats with forum topic mode enabled.
- `message_thread_id` parameter for many send/copy/forward methods in private chats with topics.
- `message_thread_id` for `sendChatAction` in private chats.
- `message_thread_id` support in private chats for `editForumTopic`, `deleteForumTopic`, and `unpinAllForumTopicMessages`.

Bot API 9.4 on February 9, 2026 added:

- `createForumTopic` in private chats.
- BotFather Mini App setting to prevent users from creating and deleting topics in private chats.
- `User.allows_users_to_create_topics` returned by `getMe`.

Bot API 9.6 on April 3, 2026 added Managed Bots, but they are unrelated to private-chat topic support.

### 2.2 `getMe` fields are the capability source

`User` includes these fields returned only in `getMe`:

```text
has_topics_enabled
allows_users_to_create_topics
can_manage_bots
```

Implication:

```text
Topic preflight starts with getMe.
Do not infer private topic support from successful bot token validation alone.
```

### 2.3 `createForumTopic` returns durable route identity

`createForumTopic` can create a topic in a forum supergroup chat or a private chat with a user.

It returns `ForumTopic`.

`ForumTopic` contains:

```text
message_thread_id
name
icon_color
icon_custom_emoji_id
is_name_implicit
```

Implication:

```text
message_thread_id returned by createForumTopic is the provider route identity candidate.
Topic name is display state only.
```

### 2.4 `sendMessage` supports private topic routing

`sendMessage` returns the sent `Message` and supports:

```text
chat_id
message_thread_id
direct_messages_topic_id
text
reply_parameters
```

The docs distinguish:

```text
message_thread_id:
  target message thread/topic of a forum;
  for forum supergroups and private chats of bots with forum topic mode enabled

direct_messages_topic_id:
  direct messages chat topic;
  required if message is sent to a direct messages chat
```

MVP uses:

```text
message_thread_id
```

MVP does not use:

```text
direct_messages_topic_id
```

Reason:

```text
direct_messages_topic_id belongs to channel direct messages topics, not normal private bot-chat team topics.
```

### 2.5 Private topic management support is asymmetric

Supported for private topics by docs/changelog:

```text
createForumTopic
editForumTopic
deleteForumTopic
unpinAllForumTopicMessages
sendMessage with message_thread_id
sendChatAction with message_thread_id
```

Do not assume for private topics:

```text
closeForumTopic
reopenForumTopic
closeGeneralForumTopic
reopenGeneralForumTopic
hideGeneralForumTopic
unhideGeneralForumTopic
```

Reason:

```text
Current Bot API method descriptions for close/reopen/general topic actions are supergroup-focused.
```

Product implication:

```text
Private topic repair should not say "closed" unless an update proves it.
Use disabled, tombstoned, deleted, recreated, setup_required, or repair_required.
```

## 3. grammY Support Check

Latest npm versions checked 2026-04-30:

```text
grammy 1.42.0
@grammyjs/types 3.26.0
```

Local package inspection confirms:

- `grammy` exposes `api.createForumTopic`.
- `grammy` context has `createForumTopic`.
- `@grammyjs/types` includes `message_thread_id`.
- `@grammyjs/types` includes `direct_messages_topic_id`.
- `@grammyjs/types` includes `has_topics_enabled`.
- `@grammyjs/types` includes `allows_users_to_create_topics`.

Official Claude Telegram channel plugin:

```text
does not mention message_thread_id
does not mention createForumTopic
does not implement team topics
```

Decision:

```text
Use grammY latest stable for Telegram API ergonomics.
Do not fork official Claude Telegram channel plugin as the Agent Teams implementation.
Steal security patterns from it, not its product model.
```

Recommended package choice:

🎯 8   🛡️ 8   🧠 4   Approx `700-1600` changed LOC

```text
grammy 1.42.0 with @grammyjs/types 3.26.0, plus our own provider outbox and topic capability policy.
```

Rejected:

🎯 4   🛡️ 5   🧠 4   Approx `1200-2600` changed LOC

```text
Fork official Claude Telegram channel plugin.
```

Reason:

```text
It is one-session channel bridge code and currently has no topic routing.
```

## 4. Private-Chat Topic Capability State Machine

Recommended account-level state:

```text
unknown
-> token_validated
-> topic_mode_missing
-> topic_mode_ready
-> topic_mode_ready_user_topics_allowed
-> topic_mode_broken
```

Transitions:

```text
unknown -> token_validated:
  getMe succeeds

token_validated -> topic_mode_missing:
  has_topics_enabled !== true

token_validated -> topic_mode_ready:
  has_topics_enabled === true
  allows_users_to_create_topics !== true

token_validated -> topic_mode_ready_user_topics_allowed:
  has_topics_enabled === true
  allows_users_to_create_topics === true

any -> topic_mode_broken:
  previously active account loses topic capability or repeated probes fail
```

Policy:

```text
topic_mode_ready:
  can provision team topics

topic_mode_ready_user_topics_allowed:
  can provision team topics but unknown topic volume is expected
  show warning and keep unknown-topic handling strict

topic_mode_missing:
  do not provision topics
  use private selector fallback or setup_required
```

Top 3 capability policies:

1. Hard gate topics on `has_topics_enabled`, warn on `allows_users_to_create_topics` - 🎯 9   🛡️ 9   🧠 5, approx `700-1500` LOC.
   Best MVP. Strong safety without blocking every own-bot user who forgot the secondary hardening setting.

2. Hard gate topics on both `has_topics_enabled === true` and `allows_users_to_create_topics !== true` - 🎯 8   🛡️ 10   🧠 5, approx `700-1500` LOC.
   Safest route identity environment, but may create more setup friction.

3. Allow topics without getMe capability gate and rely on create/send failures - 🎯 3   🛡️ 4   🧠 3, approx `300-800` LOC.
   Too noisy. Users see broken topic setup after the wizard said connected.

## 5. Per-Team Topic Route Lifecycle

Recommended route-level state:

```text
unprovisioned
-> create_in_flight
-> created_unverified
-> probe_send_in_flight
-> probe_sent
-> user_confirmed
-> active
```

Failure states:

```text
setup_required
repair_required
tombstoned
disabled
ambiguous
```

Activation rule:

```text
active requires:
  topic account capability ok
  createForumTopic result persisted
  probe send result persisted
  user confirmation callback or inbound message with same chat_id + message_thread_id
```

Why user confirmation matters:

```text
createForumTopic + sendMessage proves the Bot API accepted the topic.
It does not prove the user's client shows the topic clearly enough for routing UX.
```

Minimum viable confirmation:

```text
Send probe message into topic with inline button:
  "Connect this team"

CallbackQuery includes message object for a bot-sent button message.
Message object can include message_thread_id.
Correlate callback by provider message id and expected thread.
```

If callback shape is missing `message_thread_id` in a real client:

```text
fallback to provider message id link from the probe send result
or require the user to send a short text inside the topic
```

Do not use:

```text
createForumTopic success alone
sendMessage success alone
topic title
last selected team in UI
plain private DM outside topic
```

## 6. Unknown Topic Policy

Unknown private topics can happen if:

- `allows_users_to_create_topics === true`.
- User manually creates a topic.
- User deletes and recreates a topic with same name.
- Old route binding was tombstoned but Telegram still has historical topic messages.
- Backend/desktop lost a provision result and later receives an inbound thread.

Policy:

```text
Unknown message_thread_id never routes to lead.
Unknown topic receives setup/help only.
```

Potential actions:

```text
if message is command:
  handle setup/control command

if message is normal text:
  send short notice:
    "This topic is not connected to an Agent Teams team. Use /teams or connect it in the desktop app."

if thread matches tombstone:
  send short repair notice or stay silent if cooldown active
```

Top 3 unknown-topic policies:

1. Strict setup-only unknown topic handling - 🎯 9   🛡️ 9   🧠 4, approx `400-900` LOC.
   Best. Prevents wrong-team delivery.

2. Offer "connect this topic to team" with local desktop approval - 🎯 7   🛡️ 8   🧠 7, approx `1200-2600` LOC.
   Useful later, but not MVP because remote chat must not mutate access or route policy directly.

3. Infer team from topic title - 🎯 2   🛡️ 2   🧠 2, approx `150-400` LOC.
   Reject. Topic title is mutable and not identity.

## 7. Private Topic Repair Policy

Detected failures:

```text
sendMessage returns topic/thread error
editForumTopic/deleteForumTopic returns not found or permission error
probe callback never arrives before timeout
inbound thread belongs to tombstone
getMe loses has_topics_enabled
```

Repair actions:

```text
soft disable route:
  stop delivering runtime turns to this route
  show repair_required in desktop
  optionally post one notice if provider send still works

delete/recreate:
  only after user/local approval
  create new routeGeneration
  tombstone old message_thread_id

fallback selector:
  keep Telegram connection usable without topic route
  user chooses team with /teams and inline buttons
```

Do not:

```text
blindly create a new topic on every send failure
delete a topic automatically on team delete
assume deletion sends a reliable inbound update
keep sending to old topic after a tombstone
```

Top 3 repair strategies:

1. Tombstone and require local repair action - 🎯 8   🛡️ 9   🧠 6, approx `900-1800` LOC.
   Best MVP. Avoids accidental topic deletion or duplicate topic spam.

2. Auto recreate once on terminal topic failure - 🎯 6   🛡️ 6   🧠 5, approx `700-1400` LOC.
   Tempting, but may create confusing duplicate topics and wrong history.

3. Keep old route and retry later - 🎯 3   🛡️ 4   🧠 2, approx `200-600` LOC.
   Bad. It hides broken routes and can lose user messages.

## 8. Fallback Selector Mode

Fallback is mandatory because private-topic UX is still the live-client risk.

Fallback route:

```text
private DM with our bot
/teams
inline keyboard project/team selector
selected team stored as short-lived provider conversation session
inbound normal message routes only if an active selection exists
otherwise ask user to pick team
```

Do not:

```text
route generic private DM to last active team forever
```

Reason:

```text
That creates wrong-team delivery after the user forgets context.
```

Recommended selection lifetime:

```text
15-60 minutes for flat selector mode
explicit "change team" control
clear status message showing active team
```

Top 3 fallback policies:

1. Short-lived selected-team session - 🎯 8   🛡️ 8   🧠 5, approx `900-1800` LOC.
   Good fallback if topics are unavailable.

2. Require `/team <name>` prefix on every message - 🎯 7   🛡️ 9   🧠 4, approx `500-1200` LOC.
   Very reliable but worse UX.

3. Permanent last-team sticky route - 🎯 5   🛡️ 4   🧠 3, approx `300-800` LOC.
   Too easy to send sensitive work to wrong team.

## 9. Durable Store Boundary

The repo already has a strong `VersionedJsonStore` implementation under:

```text
src/main/services/team/opencode/store/VersionedJsonStore.ts
```

It provides:

- schema envelope;
- atomic write;
- file lock;
- validation;
- future schema detection;
- quarantine for invalid JSON/data.

But messenger-connectors should not deep-import OpenCode internals.

Top 3 store options:

1. Extract `VersionedJsonStore` to shared main infrastructure and use it from both OpenCode and messenger connectors - 🎯 8   🛡️ 9   🧠 5, approx `300-900` changed LOC.
   Best long-term. Avoids duplicated storage semantics and keeps feature slice clean.

2. Copy a feature-local `VersionedJsonStore` into messenger-connectors infrastructure - 🎯 7   🛡️ 8   🧠 4, approx `250-700` changed LOC.
   Acceptable MVP if extraction risk is too high, but creates maintenance duplication.

3. Use ad-hoc JSON files with atomicWrite only - 🎯 5   🛡️ 5   🧠 2, approx `150-500` changed LOC.
   Reject for this feature. Route/outbox/turn ledgers need validation, locks, and quarantine.

Recommendation:

```text
Extract or duplicate a small VersionedJsonStore abstraction before building messenger stores.
Do not import from src/main/services/team/opencode/store.
```

## 10. Updated Live Fixture Plan

Add a live Telegram topic harness, opt-in only:

Required env:

```text
TELEGRAM_TEST_BOT_TOKEN
TELEGRAM_TEST_USER_CHAT_ID
```

Test flow:

```text
1. getMe
2. assert has_topics_enabled
3. record allows_users_to_create_topics
4. createForumTopic(chat_id=user, name=Agent Teams Probe <timestamp>)
5. persist returned message_thread_id
6. sendMessage(chat_id, message_thread_id, inline button)
7. user taps button
8. capture callback_query shape
9. user sends text in topic
10. capture message shape
11. editForumTopic to add suffix
12. sendMessage again
13. optionally deleteForumTopic with explicit cleanup flag
14. try sendMessage to deleted thread and record error description
```

Client matrix:

```text
Telegram Desktop
Telegram iOS
Telegram Android
Telegram Web
```

Pass criteria:

```text
Topic appears clearly enough for a user to choose the right team.
User can send text inside topic.
Inbound message has chat_id + message_thread_id.
Bot reply with same message_thread_id lands inside same topic.
Callback query can be correlated to the probe topic.
Deleted topic failure is detectable.
```

Do not block unit tests on live Telegram.

Unit fixtures should cover:

- getMe with `has_topics_enabled=false`;
- getMe with user topic creation allowed;
- createForumTopic success;
- createForumTopic failure;
- send probe success;
- callback missing `message_thread_id` but matching probe message id;
- inbound message in known topic;
- inbound message in unknown topic;
- inbound message in tombstoned topic;
- sendMessage bad topic error;
- deleteForumTopic success;
- closeForumTopic unavailable or unsupported in private topic mode.

## 11. Updated Implementation Delta

Add before topic provisioning:

```text
TelegramBotAccountCapabilityProbe
TelegramTopicModePolicy
TelegramPrivateTopicLifecyclePolicy
TelegramRouteContainerSelector
TelegramUnknownTopicPolicy
TelegramTopicLiveProbeHarness
```

Core tests:

```text
topic mode missing blocks private topic route activation
allows_users_to_create_topics true creates warning, not automatic failure
unknown topic never routes to runtime
tombstoned topic never routes to runtime
private topic close/reopen are not required operations
selector fallback requires explicit active selection
```

Adapter tests:

```text
grammy getMe maps topic fields into provider capability snapshot
createForumTopic maps ForumTopic.message_thread_id into route binding candidate
sendMessage maps returned Message.message_id and message_thread_id into provider receipt
callback probe confirmation matches provider message id and thread when present
```

## 12. Updated Decisions

Add these:

```text
Private-chat topics require getMe capability gate.
has_topics_enabled=false blocks topic provisioning.
allows_users_to_create_topics=true is warning or stricter setup policy, not route identity.
Private-topic activation needs create result, send probe, and user-visible confirmation.
Unknown topic never routes to lead.
Close/reopen are not private-topic MVP operations.
Fallback selector mode is mandatory.
grammy 1.42.0 is compatible with private topic fields and createForumTopic.
Messenger stores need VersionedJsonStore semantics without deep-importing OpenCode internals.
```

## 13. Remaining Low-Confidence Items

1. Exact Telegram client UX for private topics - 🎯 6   🛡️ 8   🧠 6.
   Bot API support is strong; client clarity still needs live matrix.

2. CallbackQuery shape inside private bot-chat topics - 🎯 7   🛡️ 8   🧠 5.
   Expected to work because callback has a Message, but fixture must prove `message_thread_id` presence or alternate probe-message correlation.

3. Error descriptions for deleted private topics - 🎯 6   🛡️ 8   🧠 4.
   Need real provider responses to classify terminal vs ambiguous.

4. BotFather Mini App setup friction for own-bot users - 🎯 6   🛡️ 7   🧠 5.
   Need UX copy and screenshots or at least tested instructions.

5. Whether to hard-block on `allows_users_to_create_topics=true` - 🎯 7   🛡️ 8   🧠 5.
   Safer to warn for MVP and optionally add stricter "recommended hardening" mode.

## 14. Source Links

- Telegram Bot API changelog: https://core.telegram.org/bots/api-changelog
- Telegram Bot API `User`: https://core.telegram.org/bots/api#user
- Telegram Bot API `Message`: https://core.telegram.org/bots/api#message
- Telegram Bot API `ForumTopic`: https://core.telegram.org/bots/api#forumtopic
- Telegram Bot API `sendMessage`: https://core.telegram.org/bots/api#sendmessage
- Telegram Bot API `createForumTopic`: https://core.telegram.org/bots/api#createforumtopic
- Telegram Bot API `editForumTopic`: https://core.telegram.org/bots/api#editforumtopic
- Telegram Bot API `deleteForumTopic`: https://core.telegram.org/bots/api#deleteforumtopic
- Telegram Bot API `unpinAllForumTopicMessages`: https://core.telegram.org/bots/api#unpinallforumtopicmessages
- Telegram Bot Features - Managed Bots: https://core.telegram.org/bots/features#managed-bots
- grammY npm: https://www.npmjs.com/package/grammy
- @grammyjs/types npm: https://www.npmjs.com/package/@grammyjs/types
