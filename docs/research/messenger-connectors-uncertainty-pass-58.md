# Messenger Connectors - Uncertainty Pass 58

Date: 2026-05-01
Scope: Telegram private-chat topics as the default route container, capability gates, fixture threshold and selector fallback

## Question

Are Telegram private-chat topics stable enough to be the default route container for Agent Teams?

Short answer:

```text
Yes as the preferred product direction.
No as an unconditional runtime default.
Use private-chat topics only behind a strict default gate.
Fallback to selector mode whenever proof is incomplete.
```

## Fresh Source Check

Official Bot API facts:

- Bot API 9.3 added private-chat topic support: `has_topics_enabled`, private-chat `message_thread_id`, `is_topic_message`, and sending into private-chat topics.
- Bot API 9.4 allowed bots to create topics in private chats using `createForumTopic`.
- Bot API 9.4 added `allows_users_to_create_topics`, and BotFather can prevent users from creating and deleting private-chat topics.
- Bot API 9.6 added Managed Bots, but Managed Bots are orthogonal to private-chat topic routing.
- `User.has_topics_enabled` and `User.allows_users_to_create_topics` are returned only in `getMe`.
- `ForumTopic.message_thread_id` is the provider topic identity returned after creation.
- `sendMessage.message_thread_id` targets a forum topic in supergroups and private chats of bots with forum topic mode enabled.
- `Message.message_thread_id` and `Message.is_topic_message` identify messages in private-chat topic mode.

Sources:

- https://core.telegram.org/bots/api-changelog
- https://core.telegram.org/bots/api#user
- https://core.telegram.org/bots/api#message
- https://core.telegram.org/bots/api#createforumtopic
- https://core.telegram.org/bots/api#forumtopic
- https://core.telegram.org/bots/api#sendmessage

## Main Finding

The API foundation is solid enough to design around private-chat topics.

The product risk is default activation.

Bad default gate:

```text
getMe.has_topics_enabled === true
```

This proves the bot has topic mode enabled. It does not prove:

- topic creation works for this account binding
- the returned `message_thread_id` was persisted
- sending into that thread works
- the user can see and reply inside the topic cleanly
- callback probes work when Telegram returns `MaybeInaccessibleMessage`
- Telegram clients show the topics UX consistently enough
- the user cannot create/delete confusing extra topics

Recommended default gate:

```text
privateTopicDefaultAllowed =
  token_valid &&
  getMe.has_topics_enabled === true &&
  officialBotAllowsUserTopicMutation === false &&
  accountCompatibilityEvidenceFresh === true &&
  teamRouteActivationProof === active
```

For own-bot mode, `allows_users_to_create_topics=true` should not make routing unsafe by itself, because unknown topics never route. But it lowers UX reliability.

Own-bot policy:

```text
has_topics_enabled=false -> selector mode
has_topics_enabled=true and allows_users_to_create_topics=false -> strict private-topic mode candidate
has_topics_enabled=true and allows_users_to_create_topics=true -> topic mode beta/warn or selector fallback
```

## Capability State Machine

Account capability:

```text
unknown
-> token_validated
-> topic_mode_missing
-> topic_mode_available_uncontrolled
-> topic_mode_available_controlled
-> topic_mode_fixture_blocked
-> topic_mode_default_allowed
-> topic_mode_broken
```

Meanings:

- `topic_mode_missing`: `has_topics_enabled` is missing or false.
- `topic_mode_available_uncontrolled`: topics exist, but users can create/delete topics.
- `topic_mode_available_controlled`: topics exist and user topic mutation is disabled.
- `topic_mode_fixture_blocked`: API supports topics, but global fixture matrix is stale or failed.
- `topic_mode_default_allowed`: account, global fixture and per-team activation proof all pass.
- `topic_mode_broken`: provider returned contradictions, repeated invalid-thread failures, or activation proof failed.

Route activation:

```text
draft
-> provisioning_requested
-> provider_topic_created
-> local_route_persisted
-> probe_message_sent
-> probe_confirmed
-> active
-> repair_required
-> tombstoned
```

`active` requires all of:

- persisted `ForumTopic.message_thread_id`
- persisted route generation
- persisted send probe provider `message_id`
- callback proof with signed nonce or inbound proof from the same thread
- read-back verification from `MessengerStateStore`

## Strict Gate vs User Convenience

Top 3 defaulting policies:

1. Strict private-topic gate with selector fallback.
   🎯 8   🛡️ 10   🧠 7   Approx 1500-3000 LOC.
   Recommended. Best balance: great UX when proven, safe fallback when proof is missing.

2. Soft gate on `has_topics_enabled` and repair failures later.
   🎯 6   🛡️ 7   🧠 4   Approx 700-1500 LOC.
   Faster, but it turns unknown client/provider behavior into user-facing confusion.

3. Selector mode default until private topics are proven for all users.
   🎯 9   🛡️ 8   🧠 3   Approx 500-1000 LOC.
   Very stable and simple, but weaker UX. Good emergency fallback and staged rollout baseline.

Recommendation:

```text
Ship selector mode as mandatory fallback.
Use strict private-topic gate for the default official bot rollout.
Expose own-bot private topics only when the wizard can verify the same proof chain.
```

## `allows_users_to_create_topics`

This field matters more than earlier passes implied.

It is not route identity. It is route-container entropy.

If true:

- user-created topics can appear
- user-deleted topics can create provider send failures
- topic list can become confusing
- unknown topics must never route
- route repair must be easier to find in desktop UI

If false:

- the bot can own topic topology
- one team maps to one bot-created topic
- unknown-topic cases are rarer
- route repair stays more predictable

Policy:

```text
Official shared bot: require allows_users_to_create_topics === false for private-topic default.
Own bot: warn if true and offer selector fallback or guided BotFather setup.
```

## Fixture Matrix

Minimum global fixture before private topics become broad default:

```text
Telegram Desktop latest stable
Telegram iOS latest stable
Telegram Android latest stable
Telegram Web latest stable
```

Fixture cases:

- create private topic through `createForumTopic`
- bot sends probe with `message_thread_id`
- user sees one topic per team
- user replies inside topic
- inbound update includes `message_thread_id` and `is_topic_message`
- callback probe works or safely falls back when message is inaccessible
- user cannot accidentally route from unknown topic
- topic rename does not change route identity
- topic deletion or invalid thread becomes `repair_required`
- repair can recreate a route generation without title-based recovery
- `/sent <code>` reply repair works inside the topic
- cleanup `deleteMessage` works or degrades cleanly

Fixture record should be sanitized:

```text
client
clientVersion
botApiDate
accountCapabilityShape
operation
expectedFieldsPresent
providerMethodResultShape
redactedErrorClass?
pass
checkedAt
expiresAt
```

Never store:

- bot token
- user message text
- screenshots with user content
- raw Telegram update JSON
- callback data raw nonce
- team names unless synthetic

Recommended freshness:

```text
stable release: fixture expires after 60 days or after Telegram Bot API topic-related changelog
beta/internal release: fixture expires after 14 days
```

## Topic Identity Rules

Canonical provider route identity:

```text
accountBindingId + botUserId + chat_id + message_thread_id + routeGeneration
```

Do not use:

- topic title
- topic list position
- last message text
- teammate name
- team name alone
- `message_thread_id` without `chat_id`

Why include `routeGeneration`:

```text
If a topic is deleted and recreated, Telegram may issue a new message_thread_id.
Old provider links remain historical.
New inbound messages must bind to the new generation only.
```

## Failure Handling

### `createForumTopic` succeeds but local persist fails

State:

```text
provision_unknown
```

Action:

```text
Do not create another topic blindly.
Ask user to repair, use selector fallback, or run controlled orphan cleanup.
```

### `sendMessage` to topic fails with invalid thread

State:

```text
repair_required
```

Action:

```text
Tombstone route generation.
Offer recreate topic or selector fallback.
Do not route by title.
```

### inbound topic id is unknown

State:

```text
unknown_topic_control
```

Action:

```text
Never send to lead.
Reply with setup/help or show desktop repair prompt.
```

### `allows_users_to_create_topics` flips after setup

State:

```text
capability_degraded
```

Action:

```text
Keep existing known routes active.
Block new private-topic provisioning until user fixes setting or accepts beta/warn mode.
```

### global fixture expires

State:

```text
fixture_stale
```

Action:

```text
Do not break existing active routes.
Do not provision new default private-topic routes until fixture is refreshed.
Selector fallback remains available.
```

## Implementation Components

Add:

```text
TelegramPrivateTopicDefaultGate
TelegramPrivateTopicCapabilityProbe
TelegramTopicCompatibilityEvidenceStore
TelegramRouteActivationProbe
TelegramUnknownTopicPolicy
TelegramTopicRepairUseCase
```

The gate should return:

```text
allowed
fallback_selector_required
advanced_beta_allowed
blocked_needs_botfather_setup
blocked_fixture_stale
blocked_activation_failed
```

Renderer should show only product-level states:

- topics ready
- setup needed
- using selector mode
- topic needs repair
- topic compatibility check stale

Do not show raw Telegram errors by default.

## Updated Confidence

This pass increases confidence in private topics as the target UX, but keeps default rollout guarded.

```text
Private topics as preferred design: 🎯 8   🛡️ 9   🧠 7
Private topics as unconditional default: 🎯 4   🛡️ 5   🧠 5
Strict gate plus selector fallback: 🎯 8   🛡️ 10   🧠 7
```

## Recommendation

Keep the product decision:

```text
Official shared bot + one topic per team + optional own bot.
```

But implement defaulting as:

```text
private topics when strict gate passes
selector mode when proof is incomplete
forum supergroup only as advanced fallback
```

This keeps the ideal UX without turning Telegram client variance into runtime bugs.
