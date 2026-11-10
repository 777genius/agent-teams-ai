# Messenger Connectors - Uncertainty Pass 35

Date: 2026-04-29
Scope: conversation history, Telegram topic projection, teammate-visible messages, backfill policy, canonical local store, and anti-duplication rules

## Executive Delta

The next weakest area is:

```text
local app messages
-> canonical messenger conversation history
-> Telegram topic projection
-> provider message links
-> reply-to routing
```

This looks like a UX problem, but it is actually a data model problem.

If we simply mirror the existing app feed into Telegram, we risk:

```text
1. Sending internal lead thoughts or slash command output to Telegram.
2. Mixing unrelated teammate replies from inboxes/user.json into the wrong topic.
3. Duplicating the same answer because the local UI feed dedupes differently from provider delivery.
4. Losing reply-to routing because local messages have no provider message link.
5. Creating a Telegram topic that looks like history, but is missing context from before connection.
6. Backfilling old history and accidentally exposing private/internal messages.
```

The safest rule:

```text
Telegram topic is a projection, not the source of truth.
```

Canonical history must be a new provider-neutral store:

```text
MessengerConversationStore
  accepted inbound provider messages
  external-safe local replies
  provider delivery links
  route/team/member references
  projection state
```

The existing `TeamMessageFeedService` is useful as an input, but it is not safe to use as the Telegram projection source directly.

## Source Facts Rechecked

Telegram official facts checked on 2026-04-29:

- Bot API exposes update delivery through `getUpdates` or webhooks. Updates are stored on Telegram servers until the bot receives them, but not longer than 24 hours.
- `Update.update_id` helps ignore repeated updates or restore order if webhook updates arrive out of order.
- `Message.message_id` is unique inside a chat. In some scheduled-message cases it can be `0` and unusable until actually sent.
- `Message.message_thread_id` identifies a message thread or forum topic for supergroups and private chats.
- `createForumTopic` can create a topic in a forum supergroup or a private chat with a user. It returns a `ForumTopic`.
- `editForumTopic` can change topic name/icon in a forum supergroup or private chat with a user.
- `copyMessages` supports `message_thread_id`, copies 1-100 known messages, and returns `MessageId[]`.
- `sendMessage` and media methods return the sent `Message` on success. This returned provider message id is required for future reply-to routing.
- `sendChatAction` supports `message_thread_id` and lasts 5 seconds or less. Telegram recommends it only when a response will take noticeable time.
- `sendMessageDraft` can stream a partial message to a user while it is being generated, with optional `message_thread_id`.
- `editMessageText` can edit messages, but it is primarily for changing existing message history and has 48-hour limits for certain business messages not sent by the bot.
- `deleteMessage` has important limits, including a 48-hour deletion window for normal messages and service-message exceptions.
- Telegram FAQ says bots can see messages sent to them, and group privacy mode changes what group messages they can see. Treat bots as third-party participants.

Sources:

- https://core.telegram.org/bots/api#getting-updates
- https://core.telegram.org/bots/api#update
- https://core.telegram.org/bots/api#message
- https://core.telegram.org/bots/api#createforumtopic
- https://core.telegram.org/bots/api#editforumtopic
- https://core.telegram.org/bots/api#copymessages
- https://core.telegram.org/bots/api#sendmessage
- https://core.telegram.org/bots/api#sendchataction
- https://core.telegram.org/bots/api#sendmessagedraft
- https://core.telegram.org/bots/api#editmessagetext
- https://core.telegram.org/bots/api#deletemessage
- https://telegram.org/faq

Inference from the Bot API docs:

```text
The Bot API is update-driven and method-driven.
It does not document a general "read arbitrary private chat history" method for bots.
Therefore Agent Teams must persist the history it needs at acceptance/projection time.
```

Local code facts checked:

- `TeamInboxReader` merges all `inboxes/*.json`, assigns `to` from the filename when absent, and creates deterministic message ids for rows without `messageId`.
- `TeamSentMessagesStore` keeps only the newest 200 messages in `sentMessages.json`. This is a UI/local persistence cap, not a long-term external conversation history.
- `TeamMessageFeedService` merges inbox messages, lead session messages, and sent messages, then dedupes, links passive summaries, attaches lead session ids, and annotates slash command responses.
- `TeamMessageFeedService` is optimized for UI display, not for provider delivery or privacy policy.
- `InboxMessage.source` already has multiple categories: `inbox`, `lead_session`, `lead_process`, `runtime_delivery`, `user_sent`, `system_notification`, `cross_team`, `cross_team_sent`.
- Existing `conversationId` and `replyToConversationId` are used for cross-team routing and can inspire messenger conversation identity, but they are not enough by themselves for Telegram provider links.
- `inboxes/user.json` can contain teammate replies to the user without stable provider thread context.

Implication:

```text
Messenger history must not be derived lazily from the renderer feed.
It must be committed as a conversation ledger when an external route is involved.
```

## Top 3 History Models

### 1. Canonical MessengerConversationStore plus Telegram projection ledger

🎯 9   🛡️ 9   🧠 7   Approx change size: 4000-9000 LOC

Shape:

```text
provider inbound committed locally
-> MessengerConversationStore append inbound
-> local delivery to lead/team
-> safe local replies appended to same conversation
-> TelegramProjectionLedger sends only eligible projection events
-> provider message ids stored as ProviderMessageLink
```

Why this is best:

- Telegram topic is a view of an external conversation, not the data source.
- Existing UI feed remains untouched for local app semantics.
- Provider delivery idempotency and reply-to mapping have a durable home.
- Future WhatsApp/Discord adapters can reuse the same core model.
- Privacy policy can be enforced before a row becomes externally projectable.

Weaknesses:

- More code.
- Needs migration/UI integration to show messenger conversations.
- Requires careful linking from existing team replies to the correct conversation.

Verdict:

```text
Use this.
```

### 2. Reuse existing TeamMessageFeedService as canonical history

🎯 5   🛡️ 4   🧠 3   Approx change size: 900-2200 LOC

Shape:

```text
watch TeamMessageFeedService
filter messages
send eligible messages to Telegram topic
store provider links separately
```

Why it is tempting:

- Much less new architecture.
- UI already displays this feed.
- Existing refresh/invalidation paths exist.

Why it is risky:

- Feed is display-oriented and merges many sources.
- It can annotate slash command responses.
- It dedupes and links passive summaries for UI purposes.
- It includes local-only concepts that should never leave the app by default.
- It has no long-term guarantee because `sentMessages.json` caps at 200 rows.

Verdict:

```text
Do not use as provider source of truth.
Can be an input to a projection gate only.
```

### 3. Telegram topic as the canonical history

🎯 4   🛡️ 5   🧠 5   Approx change size: 1800-4500 LOC

Shape:

```text
send everything important to Telegram
use Telegram topic message ids as history
local app reads/links only provider ids
```

Why it is attractive:

- User sees history in Telegram.
- Less local history UI work.

Why it fails:

- Bot API does not provide a general documented way to read arbitrary private chat history later.
- If delivery to Telegram is ambiguous, local source of truth is unclear.
- If user deletes messages or blocks bot, local product history degrades.
- Provider-specific semantics leak into core.
- WhatsApp/Discord will not match exactly.

Verdict:

```text
Reject for core architecture.
Telegram is projection only.
```

## Recommended Canonical Model

Use two related ledgers:

```text
MessengerConversationStore
  what happened in the external-user conversation

MessengerProviderProjectionLedger
  what was attempted/sent/linked in Telegram
```

Conversation row:

```ts
interface MessengerConversationMessage {
  id: string;
  conversationId: string;
  routeId: string;
  bindingId: string;
  teamId: string;
  direction: 'inbound_from_user' | 'outbound_to_user' | 'internal_note';
  author: {
    kind: 'external_user' | 'team_member' | 'team_lead' | 'system';
    memberId?: string;
    displayName: string;
  };
  text: string;
  createdAt: string;
  externalVisibility:
    | 'projectable'
    | 'local_only'
    | 'blocked_by_policy'
    | 'requires_manual_approval';
  source: {
    kind:
      | 'telegram_update'
      | 'team_inbox'
      | 'lead_session'
      | 'runtime_delivery'
      | 'manual_ui'
      | 'system';
    localMessageId?: string;
    providerUpdateId?: string;
    providerMessageId?: string;
    leadSessionId?: string;
  };
  replyTo?: {
    conversationMessageId?: string;
    providerMessageLink?: ProviderMessageLink;
    localMessageId?: string;
  };
  policy: {
    sanitized: boolean;
    strippedInternalBlocks: boolean;
    reasonCodes: string[];
  };
}
```

Projection row:

```ts
interface MessengerProviderProjectionRecord {
  id: string;
  conversationMessageId: string;
  provider: 'telegram';
  routeId: string;
  providerTarget: {
    chatIdHash: string;
    messageThreadId: string;
  };
  status:
    | 'pending'
    | 'sending'
    | 'sent'
    | 'ambiguous'
    | 'failed_retryable'
    | 'failed_terminal'
    | 'suppressed';
  payloadHash: string;
  providerMessageLink?: ProviderMessageLink;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}
```

Important:

```text
The conversation store can contain local-only rows.
The projection ledger can only contain rows that passed external visibility policy.
```

## What Counts As Conversation History

For Telegram user-facing history, include:

```text
1. User inbound messages accepted from Telegram.
2. Lead replies explicitly addressed to user.
3. Teammate replies explicitly addressed to user.
4. User manual messages from local UI that are intentionally sent to the team under this route.
5. Short system status messages that are explicitly external-facing, for example "desktop offline".
```

Do not include by default:

```text
lead thoughts
tool summaries
slash command outputs
task status notifications
cross-team internal messages
teammate-to-teammate chat
permission_request JSON
idle heartbeats
bootstrap check-ins
raw XML/agent blocks
attachments until media policy is implemented
```

This must be enforced before a message is appended as `projectable`.

## How To Handle Teammate Messages To User

The user asked for this:

```text
Messages from teammates to the user should appear in Telegram,
with each teammate clearly signed.
```

Recommended rule:

```text
Any known team member message with to == "user" can be appended to the conversation
only if it is linked to an active messenger route/conversation.
```

Rendering:

```text
[Frontend] Alice
I found the failing test. The callback resolves before token refresh.
```

```text
[QA] Mark
Reproduced on the latest build. Only happens after session restore.
```

Why prefix instead of separate bots:

- One bot per team member is much harder to manage.
- Multiple bots do not solve core routing.
- Prefix keeps the topic readable.
- It works across providers later.

Routing requirement:

```text
Do not send every message to user globally.
Send only messages whose conversationId or relay link ties them to the active messenger conversation.
```

## Conversation Identity

Use one active user-facing conversation per team route in MVP:

```text
conversationId = routeId + currentConversationSeq
```

MVP can start with:

```text
one open conversation per team topic
```

Later:

```text
multiple conversations per team topic with task/thread labels
```

Why not one conversation per message:

- Too noisy.
- Hard for the lead to maintain context.
- Telegram topic already groups by team.

Why not only one global conversation for all teams:

- Reply routing becomes ambiguous.
- User needs team-level separation.
- Topics per team become mostly cosmetic.

## Backfill Policy

Backfill is risky because old local history may contain private/internal context.

Top 3 backfill options:

### A. No automatic backfill, send a compact connection marker

🎯 9   🛡️ 9   🧠 3   Approx change size: 500-1200 LOC

On topic creation:

```text
Connected to Agent Teams.
Team: Frontend
New messages will appear here.
```

Optional local-only UI shows older app history, but Telegram starts clean.

Verdict:

```text
Use for MVP.
```

### B. User-approved summary backfill

🎯 8   🛡️ 8   🧠 6   Approx change size: 1800-4000 LOC

Desktop prepares a summary:

```text
Recent context:
- Alice is debugging auth callback tests.
- Mark is checking session restore.
- Open question: should refresh happen before redirect?
```

User explicitly approves before sending.

Verdict:

```text
Good Phase 2.
```

### C. Raw transcript backfill

🎯 4   🛡️ 3   🧠 5   Approx change size: 1600-3600 LOC

Desktop sends last N messages from local feed into Telegram.

Problems:

- High privacy leak risk.
- Rate-limit/noise risk.
- Duplicates provider projection.
- Old messages may lack clean source/route links.
- Telegram message timestamps become send time, not original time.

Verdict:

```text
Reject by default.
Only allow export/manual paste workflows later.
```

## History Display In Telegram

Telegram topic should show:

```text
inbound user message
team reply with member prefix
short status markers
optional typing/draft/progress indicator
```

It should not try to reproduce the full local app timeline.

Recommended topic message examples:

```text
You
Can you check why login redirects loop?
```

```text
[Lead] Agent Teams
I routed this to Frontend. Alice is checking the auth callback.
```

```text
[Frontend] Alice
Found the loop. The callback reads a stale refresh token after restore.
```

```text
[System]
Desktop went offline. Open Agent Teams and resend if this still matters.
```

Avoid:

```text
tool call summaries
stdout chunks
agent chain-of-thought style text
raw task board mutations
every idle/status heartbeat
```

## Progress Indicators

Top 3 options:

### 1. `sendChatAction(typing)` heartbeat while a route-linked answer is pending

🎯 8   🛡️ 8   🧠 4   Approx change size: 700-1500 LOC

Pros:

- Official method.
- Supports `message_thread_id`.
- Lasts 5 seconds or less, so it naturally expires.
- Does not create message history clutter.

Cons:

- Needs throttling.
- Can imply active work even if the lead is blocked.

Verdict:

```text
Use carefully after inbound commit, while local delivery is pending or agent turn is active.
```

### 2. `sendMessageDraft`

🎯 6   🛡️ 6   🧠 7   Approx change size: 1200-3000 LOC

Pros:

- New Bot API method for partial generated messages.
- Supports `message_thread_id`.
- Could feel impressive.

Cons:

- Draft lifecycle/id semantics need real-world testing.
- It might leak partial agent output before safety/projection filtering.
- Harder to reconcile if final answer is suppressed.

Verdict:

```text
Do not use in MVP.
Only consider for final-answer generation after projection gate is mature.
```

### 3. Explicit status messages like "Alice is working"

🎯 7   🛡️ 6   🧠 3   Approx change size: 500-1200 LOC

Pros:

- Simple.
- Durable and visible.

Cons:

- Adds clutter.
- Can become spammy.
- Hard to keep accurate.

Verdict:

```text
Use only for major state changes, not continuous progress.
```

## Reply-To Routing

Incoming Telegram reply should route by priority:

```text
1. reply_to_message.message_id maps to ProviderMessageLink
2. message_thread_id maps to team route
3. slash command selects member or action
4. fallback to lead
```

Provider message link:

```ts
interface ProviderMessageLink {
  provider: 'telegram';
  routeId: string;
  providerChatIdHash: string;
  providerMessageThreadId: string;
  providerMessageId: string;
  conversationMessageId: string;
  authorKind: 'external_user' | 'team_member' | 'team_lead' | 'system';
  authorMemberId?: string;
  sentAt: string;
}
```

Examples:

```text
User replies to Alice message
-> route to team topic
-> include reply target "Alice" in lead/team prompt
-> if direct teammate reply mode is enabled, deliver to Alice inbox
```

```text
User sends a new message in team topic without reply
-> route to lead by default
```

MVP decision:

```text
Do not DM arbitrary teammate automatically from reply-to.
Route to lead with reply context first.
```

Why:

- Lead can coordinate.
- Teammate may be offline or mid-turn.
- Direct teammate routing can be added after route policy is proven.

## Commands In Topic

Keep commands minimal in MVP:

```text
/teams
/status
/help
/disconnect
```

Do not overload the topic with rich command grammar early.

Team selection:

```text
Primary selection is topic.
Commands are fallback and diagnostics.
```

If message arrives outside a topic:

```text
show active teams
ask user to pick a topic
do not infer from recent activity unless exactly one team is active
```

## Projection State Machine

```text
local_message_seen
  -> policy_checked
  -> conversation_appended
  -> projection_pending
  -> provider_sending
  -> provider_sent
  -> linked
```

Failure states:

```text
suppressed_by_policy
requires_manual_approval
provider_ambiguous
provider_failed_retryable
provider_failed_terminal
route_disabled
topic_needs_repair
```

Important invariant:

```text
Provider projection cannot start before the message is appended to MessengerConversationStore.
```

This ensures Telegram never has a message that the local conversation store cannot explain.

## Duplicate Prevention

Use three layers:

```text
1. Conversation idempotency key
2. Projection payload hash
3. Provider message link
```

Conversation idempotency:

```text
source.kind + source.localMessageId/providerUpdateId + routeId
```

Projection idempotency:

```text
conversationMessageId + provider + routeId + payloadHash
```

Provider link:

```text
stored only after sendMessage returns Message
```

If Telegram send times out:

```text
mark projection ambiguous
do not retry automatically with the same text unless policy accepts duplicate risk
surface "delivery uncertain" in local UI
```

This matches earlier outbound delivery research.

## Edit And Delete Policy

Do not use Telegram edit/delete as the normal sync mechanism.

Reasons:

- `deleteMessage` has a 48-hour limit and service-message exceptions.
- `editMessageText` has constraints and can return different shapes.
- Edits are provider-specific and hard to reconcile across adapters.

MVP:

```text
append-only Telegram topic
append-only local conversation ledger
corrections are new messages
```

Later:

```text
support explicit "correct last bot message" for bot-authored messages only
```

## Storage And Retention

Do not rely on:

```text
sentMessages.json cap of 200
inboxes/user.json as long-term canonical external history
Telegram topic as recoverable history
```

Use:

```text
getAppDataPath()/messenger-conversations/
  bindings/
  routes/
  conversations/
  projections/
```

Retention tiers:

```text
MVP:
  keep text conversation rows locally until user deletes route/binding

Later:
  per-route retention setting
  export/delete controls
  encrypted local store option
  encrypted backend queue option
```

## UI Implications

Desktop should show:

```text
Connected Telegram account
team topics/routes
last projected message status
delivery uncertain warnings
local-only vs sent-to-Telegram marker
reconnect/repair action
```

Message row badges:

```text
local only
sent to Telegram
delivery uncertain
blocked by policy
needs approval
```

This matters because the local app feed and Telegram topic will not always match exactly by design.

## Clean Architecture Placement

Core/domain:

```text
ConversationMessage
ConversationPolicy
ProjectionEligibility
ProviderMessageLink
ProjectionStateMachine
BackfillPolicy
```

Core/application:

```text
AppendInboundProviderMessageUseCase
AppendLocalReplyUseCase
EvaluateProjectionUseCase
ProjectConversationMessageUseCase
ReconcileProjectionUseCase
BuildBackfillPreviewUseCase
```

Ports:

```text
MessengerConversationStore
MessengerProjectionLedger
MessengerProviderGateway
TeamMessageSource
ExternalVisibilityPolicy
```

Adapters:

```text
TeamMessageFeedInputAdapter
TelegramProjectionAdapter
FileConversationStore
FileProjectionLedger
```

Important dependency rule:

```text
TeamMessageFeedInputAdapter may depend on existing team services.
Core policy must not depend on TeamMessageFeedService.
```

## Edge Cases To Test

History and projection:

- Topic created after team already has a long local message history.
- No automatic raw backfill occurs.
- User-approved summary backfill sends only approved summary.
- `sentMessages.json` drops old rows, but MessengerConversationStore keeps route conversation history.
- Same local message appears in both inbox and sent messages, only one conversation row is created.
- Same conversation row is not projected twice.

Teammate messages:

- Alice sends `to=user` in a route-linked conversation, Telegram gets `[Alice]`.
- Alice sends `to=user` outside a route-linked conversation, Telegram gets nothing.
- Alice sends teammate-internal message, Telegram gets nothing.
- Lead sends generic thought with no `to=user`, Telegram gets nothing.
- Slash command result is visible in UI, Telegram gets nothing by default.

Reply routing:

- User replies to Alice's Telegram message, provider link maps to Alice context.
- User replies to system offline notice, route remains lead fallback.
- User writes in topic without reply, route goes to lead.
- User writes outside topic with multiple teams connected, bot asks to choose topic.
- Unknown provider message id does not crash routing.

Provider behavior:

- `sendMessage` success stores provider message link.
- `sendMessage` timeout marks ambiguous and does not auto-duplicate.
- `deleteMessage` failure does not corrupt local conversation.
- `editForumTopic` failure does not reroute by title.
- Topic repair creates new topic and marks old projection state historical.

Privacy:

- Internal blocks stripped before projectable rows.
- Policy blocks `permission_request` JSON.
- Policy blocks tool stdout/stderr unless manually approved.
- Backfill preview redacts secrets and requires explicit approval.

## Decision Update

Add this to the implementation plan:

```text
MessengerConversationStore is mandatory for MVP.
Telegram topic is provider projection only.
No raw automatic history backfill.
One topic per team route.
One open conversation per team topic in MVP.
Teammate messages to user are projected only when route-linked and external-safe.
```

Recommended MVP behavior:

```text
Connect Telegram
-> create one topic per selected team
-> send a short connection marker
-> start projecting new inbound/outbound external-safe messages
-> show local projection status in desktop
```

Main remaining uncertainty:

```text
Should reply-to a teammate message route directly to that teammate,
or always go through lead with reply context?
```

My current recommendation:

🎯 8   🛡️ 8   🧠 5   Approx change size: +800-1800 LOC

```text
MVP routes all Telegram inbound through lead,
but includes reply-to teammate context in the prompt.
Add direct teammate routing later as an explicit per-team setting.
```

Reason:

```text
It preserves coordination, avoids surprising teammate interruptions,
and still lets the lead tell Alice "the user replied to your message".
```
