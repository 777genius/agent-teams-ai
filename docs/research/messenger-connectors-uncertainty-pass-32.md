# Messenger Connectors - Uncertainty Pass 32

Date: 2026-04-29
Scope: agent reply capture, outbound Telegram delivery, message visibility policy, duplicate prevention, and provider delivery ambiguity

## Executive Delta

The next lowest-confidence boundary is the final leg:

```text
agent/team message
-> local app feed
-> outbound eligibility decision
-> Telegram sendMessage
-> provider message id
-> future reply-to route
```

This is where two severe bugs can happen:

```text
1. Privacy leak:
   internal thoughts, tool summaries, teammate protocol XML, retry prompts, or slash output
   get sent to Telegram as if they were user-facing replies.

2. Duplicate provider send:
   Telegram receives a sendMessage request, but our process times out before seeing the result.
   Automatic retry can send the same user-visible reply twice.
```

The fix is a dedicated outbound projection layer:

```text
MessengerOutboundProjectionGate
  decides if a local message is eligible for external provider delivery

MessengerProviderDeliveryLedger
  records provider send intent, in-flight state, success, ambiguity, and terminal failure

ProviderMessageLink
  records Telegram message id after success so reply-to routing works later
```

Do not use the renderer feed or `sentMessages.json` as the outbound provider queue. They are useful inputs, but not the delivery protocol.

## Source Facts Rechecked

Telegram official facts checked on 2026-04-29:

- Bot API methods return a JSON object with `ok`; successful calls put the method result in `result`.
- `sendMessage` sends text and returns the sent `Message` on success.
- `sendMessage` supports `message_thread_id` for forum/private-chat topics.
- `sendMessage` supports `reply_parameters` for replying to a specific message.
- When using webhook inline responses to call Bot API methods, Telegram says it is not possible to know whether the method succeeded or to get its result.
- `ResponseParameters.retry_after` tells how many seconds to wait after flood control.
- Telegram FAQ recommends avoiding more than one message per second in a single chat; otherwise 429 errors can happen.
- Telegram FAQ says bots should not rely on webhook inline response if they need to know the result of the method.
- Bot API docs and FAQ do not expose a client-supplied idempotency key for `sendMessage`.

Sources:

- https://core.telegram.org/bots/api#making-requests
- https://core.telegram.org/bots/api#making-requests-when-getting-updates
- https://core.telegram.org/bots/api#sendmessage
- https://core.telegram.org/bots/api#replyparameters
- https://core.telegram.org/bots/api#responseparameters
- https://core.telegram.org/bots/faq

Local code facts:

- `TeamSentMessagesStore` persists `sentMessages.json`, but it caps history at 200 messages and is optimized as a local UI/persistence store, not a provider delivery ledger.
- `TeamSentMessagesStore` preserves message fields such as `from`, `to`, `source`, `leadSessionId`, `conversationId`, and `replyToConversationId`.
- `TeamDataService.extractLeadSessionTextsFromJsonl` creates lead-session text rows with `source: 'lead_session'` and usually no `to`.
- `leadSessionMessageExtractor` creates slash command result rows with `source: 'lead_session'` and `messageKind: 'slash_command_result'`.
- `TeamProvisioningService` captures native `SendMessage` tool calls. `recipient === 'user'` is persisted to `sentMessages.json`; other recipients are persisted to inbox.
- `relayLeadInboxMessages` captures plain lead output for inbox relay, strips agent-only blocks, then persists a `lead_process` message to user.
- `stripAgentBlocks` removes `info_for_agent`, legacy agent blocks, and OpenCode runtime delivery blocks.
- `inboxNoise` detects internal JSON noise and teammate-message XML protocol artifacts.
- `RuntimeDeliveryService` already has strong local idempotency ideas: journal begin, payload hash conflict detection, destination verification, committed state, failed retryable state, and reconciler.
- Existing runtime delivery works for local destinations because it can verify local files/stores. Telegram provider sends are different because success may be unknowable after network timeout.

Implication:

```text
The current app has good ingredients,
but messenger outbound needs a separate provider delivery ledger
with stricter "external visibility" rules than the UI feed.
```

## 1. Outbound Eligibility Is A Security Boundary

The local feed contains multiple categories:

```text
user_sent
lead_process
lead_session
runtime_delivery
inbox
system_notification
cross_team
cross_team_sent
slash_command_result
tool summaries
command output
internal protocol blocks
noise JSON
```

Only a small subset should be allowed to leave the app through Telegram.

Minimal provider-send eligibility:

```text
message.to == "user"
message.from is a known active team member or lead
message.source is user-visible by policy
message.text remains non-empty after sanitization
message is linked to a provider route or an explicit publish action
message has not already been sent to that provider route
route is active
topic is active
outbound policy allows this member/source/kind
```

Hard excludes:

```text
message.from == "user"
message.from == "system"
message.to != "user"
messageKind == "slash_command" unless explicitly mirrored as a user command echo
messageKind == "slash_command_result" unless explicitly requested
isInboxNoiseMessage(text)
isThoughtProtocolNoise(text)
stripAgentBlocks(text) is empty
only teammate-message XML blocks
tool-only rows with no human answer
debug diagnostics
runtime retry prompt text
permission_request JSON
```

The important rule:

```text
If a message is visible in the local app, that does not automatically mean it is safe to send to Telegram.
```

## 2. What Counts As A User-Facing Agent Reply

For the Telegram topic product, user-facing means:

```text
Lead or teammate intentionally answered the external user.
```

Good candidates:

- `SendMessage(to="user")` captured from lead or teammate runtime.
- Runtime delivery envelope whose destination is `user_sent_messages`.
- A visible reply proof with `relayOfMessageId` linked to a messenger inbound turn.
- A manual user action in our UI like "send this to Telegram".

Risky candidates:

- Lead session thoughts without `to`.
- Plain assistant text captured from stdout during a relay batch.
- Slash command output.
- Task/comment notifications.
- Cross-team internal coordination.
- Teammate-to-teammate messages.

Recommended MVP:

```text
Auto-send to Telegram only messages that have an explicit destination to external user.
Do not auto-send generic lead thoughts.
```

This means:

```text
lead_process with to=user -> eligible if linked to route
runtime delivery to user -> eligible if linked to route
lead_session without to -> not eligible
slash_command_result -> not eligible by default
cross_team_sent -> not eligible unless to=user and explicit external link exists
```

## 3. User Wants Teammate Messages Too

The user's desired behavior:

```text
Messages from other teammates to the user should appear in Telegram too,
signed by each teammate.
```

This is real and understandable. The safe model:

```text
If any team member sends a message to "user" in a route-linked conversation,
send it into the team topic with a member prefix.
```

Example Telegram rendering:

```text
[Frontend] Alice
I found the failing test. The auth callback returns before token refresh completes.
```

```text
[Frontend] Lead
Alice is checking the failing test. I will update you when she has a patch.
```

Do not send teammate-internal chatter:

```text
Alice -> Lead: "Can you clarify the expected API?"
Lead -> Bob: "Please review Alice's patch"
Bob -> Alice: "Approved"
```

unless the destination is explicitly `user`.

Therefore the outbound projection should key off destination, not role:

```text
to=user + route link + eligible source -> send to Telegram
to=lead/teammate/cross-team -> do not send
```

## 4. Route Link Requirement

Do not send every `to=user` message to Telegram. The user may have multiple channels:

```text
local UI only
Telegram official bot
Telegram own bot
future WhatsApp
future Discord
```

Outbound needs an explicit route link:

```ts
type MessengerOutboundContext =
  | {
      kind: 'reply_to_provider_turn';
      routeId: string;
      inboundProviderMessageKey: string;
      internalInboundMessageId: string;
    }
  | {
      kind: 'manual_publish';
      routeId: string;
      requestedBy: 'user';
      localMessageId: string;
    };
```

For auto-send MVP, require `reply_to_provider_turn`.

Manual publish can come later. Without route link, local app replies remain local app replies.

## 5. Provider Delivery Is Not Local Delivery

Existing `RuntimeDeliveryService` can retry local destinations because it can verify them:

```text
write deterministic local message id
verify file/store contains destination message id
mark committed
```

Telegram is different:

```text
POST sendMessage
network timeout before response
unknown whether Telegram created the message
no Bot API client idempotency key
cannot verify by deterministic local id
```

Therefore provider delivery states need an ambiguity state:

```ts
type MessengerProviderDeliveryStatus =
  | 'pending'
  | 'send_in_flight'
  | 'sent'
  | 'send_ambiguous'
  | 'rate_limited'
  | 'failed_retryable_before_send'
  | 'failed_terminal'
  | 'cancelled';
```

Critical rule:

```text
Never automatically retry send_in_flight after a transport timeout
unless the provider adapter can prove the previous attempt did not reach Telegram.
```

Most HTTP timeout cases cannot prove that.

## 6. Provider Delivery Ledger

Suggested ledger:

```ts
type MessengerProviderDeliveryRecord = {
  idempotencyKey: string;
  provider: 'telegram';
  botScope: 'official' | 'own_bot';
  routeId: string;
  providerChatIdHash: string;
  providerMessageThreadId: number | null;
  internalMessageId: string;
  internalPayloadHash: string;
  visibilityDecisionId: string;
  status: MessengerProviderDeliveryStatus;
  providerMessageId: number | null;
  replyToProviderMessageId: number | null;
  attempts: number;
  nextAttemptAt: string | null;
  ambiguousSince: string | null;
  lastErrorCode: string | null;
  lastErrorMessageRedacted: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
};
```

Idempotency key should be deterministic:

```text
sha256(provider + routeId + internalMessageId + normalizedTextHash + deliveryKind)
```

Payload hash prevents accidental reuse:

```text
same idempotencyKey + different payloadHash -> conflict, terminal
```

When `sent`:

```text
create ProviderMessageLink:
  providerMessageId -> internalMessageId
```

When `send_ambiguous`:

```text
do not create ProviderMessageLink
show warning in connector status
allow manual "send again anyway" or "mark as sent" if future support flow exists
```

## 7. Send State Machine

Safe provider send state machine:

```text
pending
-> send_in_flight
-> sent

pending
-> failed_retryable_before_send
-> pending

send_in_flight
-> rate_limited
-> pending at retry_after

send_in_flight
-> send_ambiguous

send_in_flight
-> failed_terminal
```

Retryable before-send examples:

- route temporarily locked;
- local rate limiter says wait;
- backend/desktop connection unavailable before calling Telegram;
- provider adapter rejected validation before network send.

Ambiguous examples:

- request body was handed to HTTP client and connection timed out;
- process crashed after starting `sendMessage`;
- backend sent inline webhook response with method payload and needs the provider result;
- connection reset after partial response;
- app received malformed response after Telegram may have accepted request.

Terminal examples:

- blocked by user;
- chat not found;
- topic missing and repair is required;
- message text empty after sanitization;
- payload too long and split policy disabled;
- route disabled;
- payload hash conflict.

## 8. Do Not Use Inline Webhook Response For Outbound Replies

Telegram allows calling a Bot API method by returning it in the webhook response. This is tempting for fast replies.

Do not use it for messenger outbound replies.

Reason:

```text
Telegram says we cannot know if the inline method succeeded or get its result.
Without the returned Message, we cannot store providerMessageId.
Without providerMessageId, reply-to teammate routing becomes weaker.
```

Use normal Bot API calls for outbound messages:

```text
POST /bot<TOKEN>/sendMessage
await result
persist provider message id
then mark sent
```

Inline webhook response is acceptable only for non-critical throwaway notices where no future reply routing is needed.

## 9. Rate Limiting

Telegram FAQ warns to avoid more than one message per second in a single chat.

For one-topic-per-team inside one private chat, the chat-level limiter matters more than topic-level limiter:

```text
same Telegram private chat
many team topics
many team replies
one chat-level provider limit
```

Add provider route limiter:

```text
global bot limiter
per chat limiter
per route/topic limiter
```

MVP values:

```text
per chat: 1 message per second steady
per route/topic: 1 message per second steady
burst: small queue, for example 3 messages
queue overflow: collapse or mark delayed
```

Avoid splitting a single long answer into many Telegram messages unless necessary. If splitting is needed because text exceeds Telegram limit, send chunks under one ledger group and be careful:

```text
part 1 sent
part 2 ambiguous
part 3 pending
```

Multi-part provider delivery needs a group ledger, so MVP should keep replies concise and reject/trim with clear policy before adding splitting.

## 10. Text Sanitization And Formatting

Outbound text pipeline:

```text
raw local message
strip agent-only blocks
strip teammate protocol blocks if present
reject JSON noise
normalize whitespace
prefix with team/member context
enforce max length
send plain text or Telegram entities
```

Avoid parse modes in MVP:

```text
send plain text
do not use MarkdownV2 until escaping is proven
```

Reason:

- model output can contain arbitrary punctuation;
- MarkdownV2 escaping is brittle;
- malformed formatting can fail provider send;
- provider failure after partial route logic increases ambiguity.

Use explicit Telegram entities later if rich formatting is necessary.

## 11. Reply-To Mapping

When sending a provider reply, use `reply_parameters` if we are replying to a known inbound provider message:

```text
reply_to_provider_message_id = inbound Telegram message id
message_thread_id = team topic id
```

But do not depend only on Telegram reply UI.

Also store:

```text
ProviderMessageLink(providerMessageId -> internalMessageId)
```

Then future user replies can route:

```text
reply_to_message.message_id
-> ProviderMessageLink
-> internal from member
-> route to that teammate
```

If provider send succeeds but link persistence fails:

```text
send was externally visible
do not retry send
mark provider link missing
schedule repair if possible
```

This should become `sent_link_missing`, or `sent` with diagnostics. It is not a send failure.

## 12. Local Store Is Not Enough

`sentMessages.json` is capped at 200 rows. This is fine for a UI feed but not for provider reply-to history.

Provider message links need their own retention policy:

```text
keep links for active route history window
minimum 90 days or until route deletion by user
prune only with route-level retention
never prune solely because local sentMessages hit 200 rows
```

If links are pruned:

- future replies to old Telegram messages route to lead;
- UI should show "old reply target not available";
- do not guess teammate from display prefix.

## 13. Deletion And Edits

MVP can ignore edits and deletions mostly, but not silently:

Inbound Telegram edited messages:

- do not mutate already delivered internal turns in MVP;
- create an edit event or ignore with diagnostics;
- if edited before desktop acceptance, process latest only if ingress design supports it.

Outbound local message edits:

- do not edit Telegram messages in MVP;
- send corrections as new messages only on explicit action.

Telegram delete:

- if provider message deleted, later reply-to links may break;
- keep link but mark stale when detected by send/reply errors.

This avoids complicated bidirectional sync in v1.

## 14. Failure Matrix

Critical cases:

- Local lead thought appears with no `to`.
  - Do not send.
- Lead uses `SendMessage(to="user")` answering a Telegram-origin message.
  - Eligible, send to that route.
- Teammate uses `SendMessage(to="user")` answering a Telegram-origin message.
  - Eligible, send to same team topic with teammate prefix.
- Teammate sends to lead.
  - Not eligible.
- Message contains only `<info_for_agent>`.
  - Strip to empty, not eligible.
- Message contains teammate XML blocks.
  - Strip/block by protocol-noise policy.
- Slash command output row appears.
  - Not eligible by default.
- Provider route disabled after local reply was generated.
  - Mark terminal or cancelled, do not send.
- Topic route repair-required.
  - Do not fallback to general chat.
- Telegram returns 429 with retry_after.
  - Mark rate_limited, schedule retry after given time.
- HTTP timeout after request sent.
  - Mark send_ambiguous, do not auto-retry.
- HTTP timeout before request body leaves process.
  - If adapter can prove no send, mark failed_retryable_before_send.
- Telegram returns success but local link write fails.
  - Do not retry provider send, repair link.
- Duplicate local message event.
  - Ledger idempotency key returns existing provider status.
- Same idempotency key with different text.
  - Payload conflict, terminal.
- App restarts with `send_in_flight`.
  - Convert to send_ambiguous unless adapter has proof.
- Provider message link pruned.
  - Future reply falls back to lead with stale target metadata.

## 15. Top 3 Options

### Option 1 - Strict outbound projection gate + provider delivery ledger

🎯 9   🛡️ 9   🧠 7

Approx changed LOC: 2500-5500.

What it means:

- build `MessengerOutboundProjectionGate`;
- build `MessengerProviderDeliveryLedger`;
- auto-send only explicit `to=user` replies linked to a provider route;
- use Telegram normal API calls, not inline webhook response, for routable replies;
- mark network unknowns as `send_ambiguous`, not retryable;
- store `ProviderMessageLink` after success.

Why this is best:

- prevents internal-message leakage;
- avoids unsafe Telegram duplicates;
- supports teammate messages to user;
- gives reply-to routing a durable provider message id;
- matches the feature architecture standard.

Risk:

- more code;
- some ambiguous sends need user-visible diagnostics;
- initial behavior may feel conservative.

### Option 2 - Reuse `sentMessages.json` as outbound queue with simple dedupe

🎯 5   🛡️ 5   🧠 4

Approx changed LOC: 800-1800.

What it means:

- watch `sentMessages.json`;
- send any new `to=user` message to Telegram;
- store last sent internal message ids.

Why it is tempting:

- quick demo;
- current system already writes user-directed lead messages there;
- easy to observe from renderer.

Why it is risky:

- `sentMessages.json` is capped at 200;
- it is not route-specific;
- not all `to=user` messages should go to Telegram;
- provider send ambiguity is not represented;
- reply-to provider ids need another store anyway.

### Option 3 - Send all visible feed messages with broad filters

🎯 3   🛡️ 3   🧠 3

Approx changed LOC: 500-1400.

What it means:

- use `MessagesPanel`/feed projection;
- filter obvious noise;
- push visible items to Telegram.

Why it is bad:

- visibility in app is not external eligibility;
- feed contains lead thoughts, slash results, diagnostics, and UI-specific projections;
- dedupe is feed-oriented, not provider-send oriented;
- provider reply-to routing remains fragile.

This should not be used beyond a throwaway prototype.

## 16. Decision Update

Recommended model:

```text
Inbound Telegram turn creates route-linked internal message.
Agent/team responses become local messages as today.
MessengerOutboundProjectionGate observes durable local messages.
Only explicit user-directed, route-linked replies become provider send intents.
MessengerProviderDeliveryLedger handles Telegram send state.
ProviderMessageLink stores successful Telegram message ids.
Future reply-to routing uses ProviderMessageLink.
```

Minimal eligibility formula:

```text
eligible =
  route.active
  && message.to == "user"
  && message.from is active member
  && origin/reply context links message to provider route
  && message not already delivered to provider
  && sanitized text non-empty
  && message kind/source allowed by policy
```

Important product behavior:

```text
Teammate messages to user are sent to Telegram.
Teammate messages to lead or other teammates are not sent.
Lead thoughts without explicit to=user are not sent.
```

## 17. Tests To Write First

Domain tests:

- `to=user` lead reply linked to provider route is eligible.
- `to=user` teammate reply linked to provider route is eligible.
- `to=user` local-only reply without route link is not eligible.
- `to=lead` teammate message is not eligible.
- lead session thought without `to` is not eligible.
- slash command result is not eligible by default.
- agent-only block strips to empty and is not eligible.
- JSON noise is not eligible.
- provider route disabled blocks eligibility.
- same internal message maps to same provider idempotency key.
- same idempotency key with changed payload is conflict.

Provider ledger tests:

- pending -> send_in_flight -> sent creates provider link.
- pre-send validation failure is retryable.
- 429 response stores retry_after and schedules retry.
- HTTP timeout after request started becomes send_ambiguous.
- restart with send_in_flight becomes send_ambiguous.
- duplicate local event returns existing sent/ambiguous state.
- success with provider link write failure does not retry provider send.

Adapter tests:

- Telegram send uses `message_thread_id`.
- Telegram send uses `reply_parameters` when inbound provider message id is known.
- Telegram send does not use webhook inline response for routable replies.
- long text is rejected or handled by explicit split policy.
- parse mode is omitted in MVP.

Renderer tests:

- connector status shows ambiguous provider sends.
- ambiguous send has manual resolution affordance.
- user can see why a local reply was not sent to Telegram.
- teammate prefix renders in Telegram projection preview.

## 18. Remaining Low-Confidence Areas

Still worth deeper research next:

- exact local event source for teammate `SendMessage(to="user")` across all supported runtimes, not just OpenCode;
- whether legacy Claude lead-session plain text should ever auto-send to Telegram or always require explicit SendMessage;
- how to migrate old `sentMessages.json` rows into provider delivery state without accidental sends;
- how to model manual "send again anyway" for `send_ambiguous` without hiding duplicate risk;
- whether `sendMessageDraft` can safely show typing/progress in a topic without confusing delivery state;
- exact Telegram error taxonomy for deleted private topic, blocked bot, and migrated chats in Bot API responses;
- retention policy for `ProviderMessageLink` under privacy delete/export requirements.

