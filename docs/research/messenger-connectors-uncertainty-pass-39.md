# Messenger Connectors - Uncertainty Pass 39

Date: 2026-04-29
Status: deeper pass on the weakest remaining Telegram topic routing area

## Scope

This pass focuses on the riskiest chain:

```text
Telegram topic
-> team route
-> lead or teammate target
-> durable local message
-> runtime reply
-> Telegram reply
```

The API facts are now fairly clear. The real risk is state ownership:

```text
Can we prove that a message_thread_id belongs to the intended team route,
survive crashes and repairs,
and never deliver an unknown or stale topic into the wrong team?
```

Updated conclusion:

```text
Topic route activation must be stateful.
Topic title is UI only.
message_thread_id is the external route identity.
Old thread ids need tombstones and route generations.
Unknown topics and messages without message_thread_id are control/setup traffic, not lead traffic.
```

## Sources Rechecked

Official Telegram sources checked on 2026-04-29:

- Bot API changelog: https://core.telegram.org/bots/api-changelog
- Bot API `Message`: https://core.telegram.org/bots/api#message
- Bot API `sendMessage`: https://core.telegram.org/bots/api#sendmessage
- Bot API `createForumTopic`: https://core.telegram.org/bots/api#createforumtopic
- Bot API `editForumTopic`: https://core.telegram.org/bots/api#editforumtopic
- Bot API `deleteForumTopic`: https://core.telegram.org/bots/api#deleteforumtopic
- Bot API `closeForumTopic`: https://core.telegram.org/bots/api#closeforumtopic
- Bot API `reopenForumTopic`: https://core.telegram.org/bots/api#reopenforumtopic
- TDLib `createForumTopic`: https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1create_forum_topic.html
- Telegram API forum docs: https://core.telegram.org/api/forum

Important source deltas:

- Bot API 9.3 added private-chat topic fields: `has_topics_enabled`, `message_thread_id`, `is_topic_message`, and private-chat `message_thread_id` send support.
- Bot API 9.4 allowed bots to create topics in private chats through `createForumTopic` and added `allows_users_to_create_topics`.
- Bot API 9.6 added Managed Bots, but Managed Bots are not required for private-chat topics.
- `sendMessage` returns the sent `Message`, supports `message_thread_id`, and limits text to 1-4096 characters after entities parsing.
- `createForumTopic` and `editForumTopic` explicitly mention private chats with a user.
- `deleteForumTopic` and `unpinAllForumTopicMessages` explicitly mention private chats with a user.
- `closeForumTopic` and `reopenForumTopic` are still worded for forum supergroup chats, so private-chat close/reopen must not be a core dependency.
- Bot API `Message` lists `forum_topic_created`, `forum_topic_edited`, `forum_topic_closed`, and `forum_topic_reopened`, but no clear `forum_topic_deleted` service field.
- TDLib also describes topic creation for "a chat with a bot with topics", which supports the private-chat topic interpretation.
- Telegram API forum docs describe non-General forum topic ids as tied to the topic-create service message. For us, this reinforces that the external id is provider state, not a local title.

## 1. Most Important Correction

Do not model the Telegram team route as:

```text
teamId -> topicName
```

Do not model it only as:

```text
teamId -> message_thread_id
```

Model it as a provider route binding with generation:

```text
provider
accountBindingId
botUserId
privateChatId
messageThreadId
routeId
routeGeneration
teamId
status
proofLevel
```

Why generation matters:

- Topic can be deleted.
- Topic can be recreated for the same team.
- Topic title can be edited by us or maybe by the user depending on BotFather settings.
- Old Telegram messages can still be replied to by the user.
- If an old thread id later appears, it must not silently bind to the new route.

## 2. Route Binding Shape

Suggested core-domain record:

```ts
type ProviderConversationRouteBinding = {
  routeId: string;
  generation: number;
  provider: "telegram";
  accountBindingId: string;
  providerBotUserId: string;
  externalChatId: string;
  externalThreadId: string;
  localTeamId: string;
  localTeamNameSnapshot: string;
  status:
    | "draft"
    | "provisioning"
    | "topic_created_unverified"
    | "probe_pending"
    | "active"
    | "repair_required"
    | "archived"
    | "tombstoned";
  proofLevel: "none" | "medium_send_probe" | "strong_inbound_thread";
  provisionAttemptId: string;
  createdProviderMessageId?: string;
  lastProbeProviderMessageId?: string;
  lastKnownTitle?: string;
  userCreatedTopicsAllowedAtProof: boolean | null;
  createdAt: string;
  updatedAt: string;
  tombstonedAt?: string;
  tombstoneReason?: string;
};
```

Provider-neutral aliases:

```text
externalChatId = Telegram chat_id
externalThreadId = Telegram message_thread_id
externalMessageId = Telegram message_id
```

Telegram-specific DTOs stay in adapter/output or infrastructure. Core should not need the name `message_thread_id`.

## 3. Activation State Machine

Route activation must not be a boolean. Recommended state machine:

```text
draft
-> capability_checking
-> provisioning
-> topic_created_unverified
-> probe_pending
-> active

topic_created_unverified
-> probe_failed
-> repair_required

probe_pending
-> proof_expired
-> repair_required

active
-> send_failed_thread_missing
-> repair_required

active
-> user_disconnect
-> archived

repair_required
-> reprovisioning
-> topic_created_unverified

repair_required
-> user_archive
-> tombstoned
```

Activation rule:

```text
active requires:
  capability check OK
  create/provision result persisted
  send probe persisted
  account-level topic proof still valid or inbound proof from the same thread
```

What is not enough:

- `getMe.has_topics_enabled=true` alone.
- `createForumTopic` success alone.
- Topic title matching team name.
- User replying to some message without same-thread `reply_to_message`.

## 4. Proof Levels

Use explicit proof levels:

```text
none:
  no routeable proof

medium_send_probe:
  sendMessage into the created thread succeeded
  returned provider Message was persisted
  account-level topic confirmation is still valid

strong_inbound_thread:
  inbound update from the user contains the expected chat_id + message_thread_id
  route generation is active
```

Recommended default:

```text
Official shared bot:
  one-time account-level topic confirmation
  then medium proof per team route

Own private bot:
  strong proof during setup if topic behavior was never confirmed
  medium proof later while recent account proof is valid
```

Top 3 activation options:

1. Account-level topic confirmation plus per-team send probe - 🎯 8   🛡️ 9   🧠 5, approx `900-1800` changed LOC.
   - Recommended.
   - One user tap proves topic UX for this account and bot.
   - Each team still gets a provider send probe.
   - Low friction for many teams.

2. Per-team user confirmation - 🎯 8   🛡️ 10   🧠 7, approx `1200-2600` changed LOC.
   - Strongest proof.
   - Too annoying when a user has many teams.
   - Good fallback only for suspicious repairs.

3. API-only create plus send - 🎯 6   🛡️ 6   🧠 3, approx `300-800` changed LOC.
   - Simple.
   - Does not prove the user can see or understand topics in their client.
   - Too weak for MVP default unless we accept more support risk.

Recommendation:

```text
Use option 1.
Escalate to option 2 only after repair loops or suspicious route drift.
```

## 5. Provisioning Ledger

The second hard problem is topic creation idempotency. Bot API topic creation does not expose an idempotency key.

Recommended local workflow:

```text
1. Create durable ProvisionTopicAttempt with routeId + generation + requestId.
2. Call provider createForumTopic through adapter.
3. Persist returned message_thread_id immediately.
4. Send probe message to that thread.
5. Persist returned provider message id.
6. Activate only after proof policy passes.
```

Crash matrix:

```text
crash before createForumTopic:
  retry same local attempt

crash after createForumTopic success before local persist:
  route is ambiguous
  the topic may exist, but Bot API has no list-topics recovery method
  user may see an orphan topic

crash after local persist before probe:
  send probe on resume

crash after probe send before probe result persist:
  outbound ambiguity
  do not blindly retry if provider might have sent

crash after active persisted before UI refresh:
  safe
  UI catches up from durable route registry
```

Official shared bot nuance:

```text
Desktop cannot call createForumTopic directly for the official bot because it does not have the official token.
Backend should call createForumTopic with a desktop-supplied provisionRequestId.
Backend may cache the provider result by requestId as metadata, without message plaintext.
Desktop must persist the returned thread id and ACK the provisioning result.
If ACK is missing, provisioning is ambiguous, not silently retried as a fresh create.
```

This cache can contain:

```text
provisionRequestId
accountBindingId
privateChatId
messageThreadId
provider result timestamp
routeId/generation metadata
status
HMAC digest of requested title if needed
```

It should not contain:

```text
raw Telegram update JSON
message text
team prompt text
runtime messages
unredacted logs
```

Topic names are a separate privacy surface. In official bot mode, Telegram necessarily sees the topic name, and our backend transiently sees it if it creates the topic. Best MVP policy:

```text
Use user-visible team/project names only if the UI says they are sent to Telegram.
Do not persist topic names on backend unless required.
If backend needs a comparison key, store HMAC(topicName), not the raw title.
```

Top 3 provisioning ownership options:

1. Desktop-owned route registry plus backend official-bot provision result cache - 🎯 8   🛡️ 9   🧠 6, approx `1200-2600` changed LOC.
   - Recommended.
   - Keeps team route truth local.
   - Handles lost provider responses better than pure local state.
   - Backend stores metadata needed for official bot operations, not durable plaintext.

2. Backend-owned route registry for official bot - 🎯 6   🛡️ 7   🧠 6, approx `1400-3000` changed LOC.
   - Easier server dispatch.
   - Worse privacy story because backend learns team route structure.
   - Makes own-bot and official-bot modes diverge more.

3. No provision result cache, retry create on timeout - 🎯 5   🛡️ 5   🧠 3, approx `300-900` changed LOC.
   - Simple.
   - Can create duplicate topics.
   - Support pain will show up immediately after crashes or network drops.

Recommendation:

```text
Use option 1.
```

## 6. Tombstones And Repair

Never delete the old route row when a topic is replaced. Create a tombstone:

```ts
type ProviderRouteTombstone = {
  routeId: string;
  generation: number;
  provider: "telegram";
  accountBindingId: string;
  externalChatId: string;
  externalThreadId: string;
  localTeamId: string;
  tombstonedAt: string;
  reason:
    | "topic_deleted"
    | "topic_recreated"
    | "team_archived"
    | "account_disconnected"
    | "provider_repair";
  replacementRouteId?: string;
  replacementGeneration?: number;
};
```

Routing rule:

```text
If inbound message_thread_id matches a tombstone:
  do not deliver to the team
  send a reconnect/archived notice if allowed
  show a local repair event
```

Why:

- Old Telegram messages can stay visible.
- User can reply to an old bot message after route repair.
- Without tombstones, the adapter can only see "unknown thread" and may ask the wrong question.

Top 3 repair strategies:

1. Tombstone old route, create new generation, send optional reconnect notice - 🎯 8   🛡️ 9   🧠 6, approx `900-1800` changed LOC.
   - Recommended.
   - Preserves history and prevents old-thread delivery.
   - Gives clean audit trail.

2. Reuse same thread after a successful send probe if only title drift is detected - 🎯 7   🛡️ 8   🧠 5, approx `600-1400` changed LOC.
   - Good for rename/title-only drift.
   - Requires careful error classification.
   - Should not be used after delete/closed failures.

3. Delete and recreate silently - 🎯 4   🛡️ 4   🧠 5, approx `500-1100` changed LOC.
   - Reject for MVP.
   - Deleting a topic deletes messages.
   - Silent recreation creates duplicate or missing user history.

Recommendation:

```text
Use option 1 for deleted/missing thread.
Use option 2 only for title drift where send probe still succeeds.
Do not use option 3 as automatic behavior.
```

## 7. Unknown Topic And No-Thread Policy

Threaded topic mode must be strict:

```text
known active message_thread_id:
  route to team

known active message_thread_id + reply_to_message linked to teammate:
  route to teammate

known active message_thread_id + no teammate reply link:
  route to lead

tombstoned message_thread_id:
  do not deliver
  show archived/reconnect notice

unknown message_thread_id:
  do not deliver
  show setup/help or ask user to choose team

missing message_thread_id:
  control plane only
  handle /teams, /connect, /status, help, pairing

external_reply:
  do not route to teammate
  only same-chat same-thread reply_to_message plus ExternalMessageLink can target teammate
```

Top 3 unknown-topic policies:

1. Treat as control/setup, never route to lead automatically - 🎯 9   🛡️ 9   🧠 4, approx `500-1000` changed LOC.
   - Recommended.
   - Prevents wrong-team delivery.
   - Easy to explain in UI.

2. Route unknown topics to lead with warning - 🎯 4   🛡️ 4   🧠 2, approx `200-500` changed LOC.
   - Reject.
   - Fast, but it can leak user text into the wrong team.

3. Auto-create a team route from topic title - 🎯 3   🛡️ 3   🧠 6, approx `800-1800` changed LOC.
   - Reject.
   - Title is not identity.
   - User-created topics become a route injection vector.

Recommendation:

```text
Use option 1.
```

## 8. User-Created Topics

`allows_users_to_create_topics=true` is not fatal, but it increases unknown-topic events.

Official bot recommendation:

```text
has_topics_enabled = true
allows_users_to_create_topics = false
```

Own-bot recommendation:

```text
If has_topics_enabled=false:
  do not activate topic mode
  offer setup_required or flat_menu

If allows_users_to_create_topics=true:
  show warning
  continue only after user accepts the weaker operational model
```

Do not try to "clean up" user-created topics automatically. There is no safe reason to delete user history in MVP.

## 9. Flat Menu Fallback Still Needs Route Safety

Flat menu mode is the fallback for own-bot users who cannot enable topics. It should not share the same routing rules as topic mode.

Rules:

```text
reply to a known bot message:
  route by ExternalMessageLink

normal text with active team selection lease:
  route to selected team lead

normal text without active team selection lease:
  ask user to choose a team

unknown reply target:
  ask user to choose a team
```

Lease:

```ts
type FlatMenuSelectionLease = {
  accountBindingId: string;
  externalChatId: string;
  selectedTeamId: string;
  routeId: string;
  selectedAt: string;
  expiresAt: string;
};
```

Recommended TTL:

```text
15 minutes for normal text.
Replies to known provider messages bypass the lease.
```

Do not use a long-lived "current team" without visible selection, because a normal private bot chat visually mixes all teams.

## 10. Teammate Messages In One Team Topic

One topic per team still works for multiple teammates if projection is disciplined.

Outbound teammate-to-user policy:

```text
Only send a teammate message to Telegram when:
  message belongs to the same team route
  message is marked external-safe
  sender identity is safe to show
  ExternalMessageLink or runtime turn context proves it belongs to this external conversation
```

Rendering recommendation:

```text
[Alex] Done. I updated the API call and left a note in the diff.
```

Do not create a topic per teammate in MVP.

Top 3 teammate display options:

1. Same team topic with a short sender prefix - 🎯 8   🛡️ 8   🧠 4, approx `500-1200` changed LOC.
   - Recommended.
   - User sees all team work in one place.
   - Keeps topic count bounded.

2. Same team topic, no sender prefix, rely only on bot text context - 🎯 5   🛡️ 5   🧠 2, approx `200-500` changed LOC.
   - Too confusing once multiple teammates reply.

3. One topic per teammate inside each team - 🎯 4   🛡️ 5   🧠 8, approx `2500-6000` changed LOC.
   - Too many topics.
   - Harder reply routing.
   - Worse mobile UX.

Recommendation:

```text
Use option 1.
```

## 11. Bot API Objects We Must Not Confuse

`message_thread_id` is for forum/private bot topics.

`direct_messages_topic_id` is for direct messages chat topics, such as channel direct messages.

Our MVP should use:

```text
message_thread_id
```

Our MVP should not use:

```text
direct_messages_topic_id
```

This should be an adapter-level type distinction so a later WhatsApp/Discord connector cannot accidentally inherit Telegram-specific semantics.

## 12. Domain Policies And Ports

Per `docs/FEATURE_ARCHITECTURE_STANDARD.md`, keep these as domain/application policies:

```text
core/domain:
  TopicRouteActivationPolicy
  TopicRouteRepairPolicy
  InboundRouteDecisionPolicy
  ReplyTargetPolicy
  FlatMenuSelectionPolicy

core/application:
  ProvisionProviderConversationRouteUseCase
  ActivateProviderConversationRouteUseCase
  RepairProviderConversationRouteUseCase
  HandleProviderInboundMessageUseCase
  ProjectLocalReplyToProviderUseCase
```

Ports:

```ts
type ProviderTopicProvisionPort = {
  createTopic(input: CreateProviderTopicInput): Promise<CreateProviderTopicResult>;
  sendProbe(input: SendProviderTopicProbeInput): Promise<ProviderSentMessage>;
  editTopic(input: EditProviderTopicInput): Promise<ProviderTopicMutationResult>;
  deleteTopic(input: DeleteProviderTopicInput): Promise<ProviderTopicMutationResult>;
};

type ProviderRouteBindingRepository = {
  reserveProvisionAttempt(input: ReserveProvisionAttemptInput): Promise<ProvisionAttempt>;
  saveTopicCreated(input: SaveTopicCreatedInput): Promise<void>;
  saveProbeResult(input: SaveProbeResultInput): Promise<void>;
  activateRoute(input: ActivateRouteInput): Promise<void>;
  tombstoneRoute(input: TombstoneRouteInput): Promise<void>;
  findActiveByExternalThread(input: FindByExternalThreadInput): Promise<RouteBinding | null>;
  findTombstoneByExternalThread(input: FindByExternalThreadInput): Promise<RouteTombstone | null>;
};
```

Adapter placement:

```text
main/adapters/output/telegram:
  maps Telegram Bot API fields to provider-neutral inputs/results

main/infrastructure:
  stores route bindings, provisioning attempts, provider result cache

main/adapters/input:
  receives official relay events or own-bot polling updates

renderer:
  shows connection, route status, repair prompts, and health
```

SOLID mapping:

- SRP: route activation, repair, reply targeting, and Telegram transport are separate classes.
- OCP: adding WhatsApp/Discord later adds adapters and provider capability records, not edits to Telegram policy.
- ISP: topic provisioning port is separate from message send port.
- DIP: domain depends on provider-neutral ports, not on Bot API clients.

## 13. Required Tests For This Risk

Add before full Telegram E2E:

```text
TelegramTopicRouteActivationPolicy.test.ts:
  has_topics_enabled true alone does not activate
  createForumTopic success alone does not activate
  send probe plus account proof activates
  strong inbound thread proof activates
  expired account proof blocks medium activation

TelegramTopicProvisioningLedger.test.ts:
  reserve before create is retryable
  create success before persist becomes ambiguous
  persisted thread without probe resumes probe
  provision ACK missing in official mode is ambiguous
  duplicate provision request returns cached result if available

TelegramTopicRouteRepairPolicy.test.ts:
  tombstoned thread never routes to team
  deleted thread creates repair_required
  title drift with successful send probe stays active
  deleteForumTopic is never automatic disconnect

TelegramInboundTopicRoutingPolicy.test.ts:
  known active thread routes to team
  known active thread plus linked reply routes to teammate
  unknown thread asks for setup/help
  missing thread is control plane
  external_reply does not route to teammate

FlatMenuSelectionPolicy.test.ts:
  selected lease routes normal text
  expired lease asks user to choose team
  reply link bypasses lease
  unknown reply target does not infer route
```

## 14. Updated Lowest-Confidence Map

1. Live Telegram clients and private topics.
   🎯 7   🛡️ 8   🧠 5
   - Need real fixture capture across Telegram Desktop, iOS/Android, and web.
   - Especially callback/query update shapes inside private topics.

2. Topic creation crash after provider success before local persist.
   🎯 7   🛡️ 8   🧠 7
   - Official bot can reduce this with backend result cache.
   - Own-bot local mode still needs a local ambiguous state and repair UI.

3. Deleted topic detection.
   🎯 7   🛡️ 8   🧠 5
   - Bot API does not expose a clear deletion service field.
   - Need classify send failures and tombstone defensively.

4. Topic title privacy in official bot mode.
   🎯 8   🛡️ 8   🧠 4
   - Telegram sees titles anyway.
   - Backend should not persist raw titles unless the product intentionally accepts that metadata.

5. Teammate projection policy.
   🎯 7   🛡️ 8   🧠 6
   - Same topic with sender prefix is the current best answer.
   - Needs external-safe guard before sending.

## Final Recommendation

Implement Telegram topic routing as a durable route registry, not as a UI convenience.

MVP shape:

```text
official shared bot:
  hard-gate on private-topic capability
  one topic per team
  one-time account topic confirmation
  per-team send probe
  no plaintext backend queue
  backend provision result cache for official topic creation

own bot:
  local token
  local polling
  same topic route registry
  setup_required or flat_menu fallback if topic mode is disabled

all modes:
  route generations
  tombstones
  strict unknown-thread policy
  teammate prefix in same team topic
```

This is more code, but it removes the most dangerous class of bug: wrong-team delivery after topic drift, deletion, or ambiguous provisioning.
