# Messenger Connectors - Uncertainty Pass 36

Date: 2026-04-29
Scope: desktop runtime handoff, lead/team prompt correlation, visible reply capture, local turn ledger, restart recovery, and Telegram projection constraints

## Executive Delta

The next weakest boundary is inside the desktop app:

```text
MessengerConversationStore inbound row
-> local runtime delivery to lead/team
-> agent sees prompt
-> agent replies visibly
-> app proves the reply belongs to the same messenger turn
-> Telegram projection sends it
```

This is more fragile than it looks because the current app has several messaging paths:

```text
native lead stdin relay
native teammate inbox files
OpenCode runtime prompt delivery
MCP message_send
native SendMessage capture
plain assistant text capture
sentMessages.json UI history
TeamMessageFeedService display merge
```

The key risk:

```text
If messenger routing relies on "the next visible user-directed message",
it will eventually send the wrong reply or duplicate a reply.
```

Recommended rule:

```text
Every external inbound message must create a durable MessengerRuntimeTurn record.
Every external reply must be correlated back to that turn before Telegram projection.
Plain assistant text is not externally projectable by default.
```

## Source Facts Rechecked

Telegram official facts checked on 2026-04-29:

- `sendMessage` returns the sent `Message` on success.
- `sendMessage.text` is limited to 1-4096 characters after entities parsing.
- `sendMessage.message_thread_id` targets a forum/private-chat topic when topic mode is enabled.
- `sendMessage.reply_parameters` describes the provider message being replied to.
- `ReplyParameters.message_id` points to the message to reply to, and `quote` is limited to 0-1024 characters after entities parsing.
- `sendChatAction` is only a temporary status. Telegram says the status is set for 5 seconds or less and recommends using it only when a response takes noticeable time.
- `sendMessageDraft` can stream a partial message, but it also has the 1-4096 text limit and is not a final sent message.
- `ForceReply` makes Telegram clients open a reply UI and can help step-by-step flows, but it is a UI hint, not a durable routing guarantee.

Sources:

- https://core.telegram.org/bots/api#sendmessage
- https://core.telegram.org/bots/api#replyparameters
- https://core.telegram.org/bots/api#sendchataction
- https://core.telegram.org/bots/api#sendmessagedraft
- https://core.telegram.org/bots/api#forcereply

Implication:

```text
The app must store provider Message ids returned by sendMessage.
The app must split long outbound replies before Telegram send.
The app must not treat sendChatAction or sendMessageDraft as proof of delivery.
```

## Local Code Facts Checked

### Existing strong pieces

- `TeamInboxWriter.sendMessage()` writes inbox rows with `withFileLock`, `withInboxLock`, atomic write, and post-write `messageId` verification with retries.
- `TeamInboxReader` creates deterministic ids for inbox rows that lack `messageId`, then merges all inbox files.
- `TeamMessageFeedService` merges inbox, lead session, and sent messages, then dedupes and annotates display state.
- `TeamSentMessagesStore` persists user-directed lead messages, preserving `relayOfMessageId`, `conversationId`, and `replyToConversationId` when present.
- `agent-teams-controller` `messageStore` already persists `relayOfMessageId`, `conversationId`, and `replyToConversationId` flags.
- MCP `message_send` already exposes `relayOfMessageId`, `source`, `leadSessionId`, attachments, and task refs.
- OpenCode prompt delivery already has a mature ledger pattern:
  - `inboxMessageId`
  - `payloadHash`
  - attempts
  - accepted/responded/unanswered states
  - `visibleReplyMessageId`
  - `visibleReplyCorrelation`
  - retry scheduling
  - read-commit tracking
- `RuntimeDeliveryService` already demonstrates a good idempotency pattern:
  - begin journal
  - payload hash conflict detection
  - destination pre-verify
  - write
  - verify
  - mark committed
  - reconciler

### Existing weak pieces for messenger use

- `TeamSentMessagesStore` caps `sentMessages.json` at 200 rows, so it cannot be long-term messenger history.
- `TeamMessageFeedService` is a display projection and should not become the provider projection source.
- `relayLeadInboxMessages()` batches up to 10 lead inbox messages into one prompt. That is risky for messenger turns because reply correlation becomes ambiguous.
- `relayLeadInboxMessages()` captures plain lead text for 15 seconds with 800ms idle settling, strips agent blocks, and persists it as `lead_process` to user. That is acceptable for local UI, but too risky as default external Telegram output.
- `captureSendMessages()` suppresses duplicate assistant narration when it sees a visible message tool, which is good, but native and MCP paths differ.
- Native `SendMessage` prompt helpers describe canonical fields `to`, `summary`, `message`, while some capture/test paths still use `recipient` and `content`. This may be an intentional normalized stream shape, but it is a high-risk contract gap for messenger correlation.
- MCP `message_send` schema currently exposes `relayOfMessageId` but not `conversationId` or `replyToConversationId`, even though lower-level stores already persist them.

Implication:

```text
Messenger runtime handoff must not be a thin wrapper around relayLeadInboxMessages().
It needs a dedicated turn ledger and an explicit reply correlation contract.
```

## Top 3 Runtime Handoff Options

### 1. MessengerRuntimeTurnLedger plus existing visible reply tools

🎯 8   🛡️ 9   🧠 7   Approx change size: 5000-10000 LOC

Shape:

```text
inbound provider message
-> MessengerConversationStore append
-> MessengerRuntimeTurnLedger ensure pending turn
-> deliver one correlated prompt to lead/team
-> require visible reply through message_send or SendMessage
-> observe reply with relayOfMessageId/conversationId or active turn sidecar
-> append outbound conversation row
-> project to Telegram
```

Why this is best:

- Reuses the existing visible messaging concept instead of inventing a new UX path.
- Allows native teammates and OpenCode teammates to keep their existing runtime-specific channels.
- Keeps Telegram projection provider-neutral.
- Can use OpenCode delivery ledger patterns without coupling messenger core to OpenCode internals.
- Prevents plain assistant text from leaking to Telegram.

Required hardening:

- Extend MCP `message_send` schema with `conversationId` and `replyToConversationId`.
- For native `SendMessage`, either prove the real stream shape with tests or add a normalizer that accepts both `to/message` and `recipient/content`.
- Add active messenger turn sidecar to native lead capture so a `SendMessage(to="user")` during that turn can be correlated even if native tool schema cannot carry custom fields.
- Disable plain-text external projection for messenger turns.
- Deliver one messenger turn at a time per route, at least for MVP.

Verdict:

```text
Recommended MVP path.
```

### 2. Dedicated `messenger_reply` tool

🎯 7   🛡️ 9   🧠 8   Approx change size: 6500-12000 LOC

Shape:

```text
agent receives messenger prompt
agent must call messenger_reply({ conversationId, inboundMessageId, text })
app projects that reply to Telegram
```

Why it is attractive:

- Strongest explicit contract.
- Easy to validate: wrong route or missing turn id fails.
- Less ambiguity than generic `message_send`.

Weaknesses:

- Adds another visible messaging tool next to `message_send`, `SendMessage`, and `cross_team_send`.
- Model/tool confusion risk increases.
- Native Claude Code tool exposure may not be as straightforward as MCP-only paths.
- More implementation and prompt work before first usable release.

Verdict:

```text
Good fallback if existing visible message tools cannot be made reliable enough.
Do not start here unless native SendMessage metadata proves impossible.
```

### 3. Plain text capture and time-window inference

🎯 4   🛡️ 3   🧠 3   Approx change size: 1000-2500 LOC

Shape:

```text
deliver Telegram text to lead
capture next plain assistant text or next to=user message
send it back to Telegram
```

Why it is tempting:

- Fast to implement.
- Existing `relayLeadInboxMessages()` already captures plain lead text.

Why it is unsafe:

- Batches create ambiguous replies.
- Plain text may be internal coordination.
- Agent may send a task update and a user answer in the same turn.
- Restart can lose in-memory capture.
- Time-window correlation fails under concurrent local user messages.
- Duplicate retries can make the agent redo work.

Verdict:

```text
Reject for Telegram projection.
It can remain a local UI behavior, not an external provider behavior.
```

## Recommended Runtime Turn Model

```ts
interface MessengerRuntimeTurn {
  id: string;
  conversationId: string;
  routeId: string;
  teamId: string;
  bindingId: string;
  inboundConversationMessageId: string;
  inboundProviderUpdateId: string;
  inboundProviderMessageLink?: ProviderMessageLink;
  target: {
    kind: 'lead' | 'member';
    memberName: string;
    providerId?: string;
  };
  state:
    | 'pending_delivery'
    | 'delivering'
    | 'delivered_to_runtime'
    | 'reply_expected'
    | 'reply_observed'
    | 'reply_projected'
    | 'no_visible_reply'
    | 'failed_retryable'
    | 'failed_terminal'
    | 'cancelled';
  localInboxMessageId: string;
  payloadHash: string;
  promptHash: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  replyObservedAt?: string;
  projectedAt?: string;
  lastReason?: string;
}
```

Important fields:

- `inboundConversationMessageId` is the canonical messenger row.
- `localInboxMessageId` is the app/team delivery row, used as `relayOfMessageId`.
- `payloadHash` prevents a reused id from pointing to different text.
- `promptHash` helps detect prompt template changes during retry.
- `target.memberName` is resolved at delivery time, not inferred from Telegram topic title.

## Delivery State Machine

```text
pending_delivery
  -> delivering
  -> delivered_to_runtime
  -> reply_expected
  -> reply_observed
  -> reply_projected
```

Failure and side states:

```text
no_visible_reply
failed_retryable
failed_terminal
cancelled
```

Rules:

- `delivered_to_runtime` means the app delivered the prompt to the local runtime channel, not that the agent answered.
- `reply_observed` means a visible local reply was durably observed and correlated.
- `reply_projected` means Telegram projection succeeded and provider message links were stored.
- `no_visible_reply` is terminal for the turn only after retry/watchdog policy expires.

Do not collapse these into one "delivered" boolean.

## One Turn At A Time Per Route

MVP should use a per-route FIFO:

```text
routeId -> current MessengerRuntimeTurn -> queued inbound turns
```

Why:

- Existing lead relay can batch messages, but messenger reply correlation is easier and safer with one active external turn.
- Telegram users may send bursts. We can accept them locally, but deliver them to the lead one at a time.
- If the lead answers message A while message B is queued, projection is deterministic.

Top 3 burst policies:

### A. Per-route FIFO, one active runtime turn

🎯 9   🛡️ 9   🧠 5   Approx change size: 900-1800 LOC inside runtime ledger

Best for MVP. Slightly slower, much safer.

### B. Coalesce burst into one prompt with multiple provider messages

🎯 7   🛡️ 7   🧠 6   Approx change size: 1200-2400 LOC

Good later. Requires a multi-inbound turn model and reply summary rules.

### C. Parallel prompts to lead

🎯 4   🛡️ 3   🧠 4   Approx change size: 800-1600 LOC

Reject. Native lead has one stdin stream and the app cannot reliably match reply ownership.

## Prompt Contract

For a messenger inbound turn, the prompt must include:

```text
conversationId
inboundMessageId
route/team name
sender display snapshot
provider reply target
external visibility requirement
exact reply tool instructions
```

Recommended wording shape:

```text
You received a Telegram message for team "<team>".
This is an external user conversation.

Messenger conversationId: <conversationId>
Inbound messageId: <localInboxMessageId>

If you answer the Telegram user, use a visible message tool:
- OpenCode/MCP: agent-teams_message_send with to="user", from="<your name>", source="messenger_reply", relayOfMessageId="<localInboxMessageId>", conversationId="<conversationId>", replyToConversationId="<conversationId>".
- Native: SendMessage to="user" with a concise external-safe answer.

Do not answer this messenger turn only as plain assistant text.
Do not include tool output, internal reasoning, or teammate-only coordination.
If you delegate internally, still send a short external status to user.
```

Important:

```text
The plain assistant response can be useful in desktop UI,
but it is not sufficient for Telegram projection.
```

## Correlation Rules

Ranked correlation signals:

```text
1. Exact relayOfMessageId == turn.localInboxMessageId
2. Exact conversationId == turn.conversationId and replyToConversationId == turn.conversationId
3. Active native messenger turn sidecar and SendMessage(to="user") in the same assistant message
4. Manual review
```

Do not use by default:

```text
timestamp proximity only
same sender only
same route only
text similarity only
TeamMessageFeedService newest row
```

If a visible reply lacks correlation:

```text
store it as local-only or requires_manual_review
do not project to Telegram automatically
```

Exception for native MVP:

```text
If there is exactly one active native messenger turn,
and a native SendMessage(to="user") appears during that turn,
the sidecar may attach turn id and conversation id before persistence.
```

That exception must be tested heavily.

## Native SendMessage Contract Risk

Current code has a risky shape:

```text
Prompt helper says native SendMessage fields: to, summary, message.
Some stream capture paths/tests inspect: recipient, content.
```

Possible explanations:

```text
1. Claude Code stream-json normalizes SendMessage tool input to recipient/content.
2. Legacy tests still use old shape.
3. Capture path is partially stale.
```

Before implementation, resolve this with a narrow proof:

```text
Run or fixture-capture a real native SendMessage tool_use.
Add a unit fixture for the actual stream-json shape.
Add a normalizer:
  to = input.to ?? input.recipient
  text = input.message ?? input.content
  summary = input.summary
```

Recommended:

🎯 9   🛡️ 9   🧠 3   Approx change size: 120-300 LOC with tests

```text
Normalize both shapes at capture boundary,
but keep prompt wording canonical.
```

Reason:

```text
Messenger correlation cannot depend on an unproven native tool field name.
```

## MCP message_send Gap

Current MCP `message_send` schema exposes:

```text
relayOfMessageId
source
leadSessionId
attachments
taskRefs
```

Lower-level stores already support:

```text
conversationId
replyToConversationId
```

But the MCP tool schema does not expose those two fields today.

For messenger, add:

```ts
conversationId?: string;
replyToConversationId?: string;
```

Recommended:

🎯 9   🛡️ 9   🧠 3   Approx change size: 80-220 LOC with tests

```text
Expose existing store fields in MCP message_send.
Do not invent a new correlation field for the same concept.
```

## Lead Plain Text Capture Policy

Existing local behavior:

```text
relayLeadInboxMessages()
  sends a prompt to lead
  captures plain text for 15s
  strips agent blocks
  persists lead_process to user
```

Messenger policy should be stricter:

```text
Plain lead text from a messenger turn is never automatically projected to Telegram.
```

Acceptable uses:

- Show in desktop as local-only diagnostic.
- Use as a fallback summary in a manual approval UI.
- Treat as weak evidence that the lead noticed the prompt.

Not acceptable:

- Telegram sendMessage by default.
- Marking runtime turn `reply_observed`.

Why:

```text
The lead prompt contains internal instructions and may trigger coordination text.
External projection needs explicit user-directed intent.
```

## Teammate Reply Paths

### Native teammate

Native teammate reads inbox and writes reply to `inboxes/user.json` or target inbox.

Messenger requirement:

```text
The inbound row delivered to teammate must include relayOfMessageId and conversationId.
The teammate reply must preserve those fields or be sidecar-correlated by the runtime turn ledger.
```

### OpenCode teammate

OpenCode does not rely on watching native inbox files in the same way.

Useful existing pattern:

```text
OpenCode runtime prompt instructs message_send with relayOfMessageId.
OpenCodePromptDeliveryLedger validates visible reply proof.
```

Messenger should reuse the pattern:

```text
MessengerRuntimeTurnLedger can call a provider-specific runtime delivery port.
The port may use OpenCodePromptDeliveryLedger internally,
but messenger core only sees "prompt delivered" and "visible reply observed".
```

### Lead-first MVP

Recommended:

```text
Telegram inbound -> lead first
Lead can delegate to teammates
Teammate replies to user are projected only if route-linked
```

Do not send Telegram inbound directly to teammate based only on reply-to yet.

## Agent Reply Semantics

A messenger turn may end in several legitimate ways:

```text
visible answer to user
delegated with visible status
created task with visible status
asked clarification
blocked with visible status
no visible reply
internal-only action
```

Projection policy:

```text
visible answer/status/clarification -> project
internal-only action -> do not project, maybe retry asking for visible status
no visible reply -> watchdog retry, then local warning
```

Prompt policy:

```text
If you do anything that changes team state, tell the Telegram user briefly what happened.
```

This avoids a UX where the user sends a Telegram message and sees silence while the team quietly creates tasks.

## Watchdog And Retry Policy

Use a small messenger-specific watchdog:

```text
reply_expected for 20-45s
if no correlated visible reply:
  retry once with "do not repeat work, send visible status"
if still no reply:
  mark no_visible_reply
  optionally send Telegram status: "I passed this to the team, but no visible reply was produced yet."
```

Top 3 retry options:

### A. Retry visible-status request only, not original work

🎯 9   🛡️ 8   🧠 5   Approx change size: 900-1800 LOC

Recommended. It avoids duplicate work.

### B. Retry the full original inbound prompt

🎯 5   🛡️ 5   🧠 4   Approx change size: 600-1300 LOC

Risky. The agent may redo task creation or duplicate teammate messages.

### C. No retry, only local warning

🎯 7   🛡️ 7   🧠 3   Approx change size: 400-900 LOC

Simple but creates silent Telegram UX too often.

## Telegram Reply Projection Constraints

Before sending to Telegram:

```text
1. Sanitize text.
2. Ensure external visibility policy passed.
3. Split text into chunks under Telegram limits.
4. Use message_thread_id for the team topic.
5. Use reply_parameters for the first chunk when inbound provider message link exists.
6. Store provider message links for every sent chunk.
```

Chunking recommendation:

```text
target max chunk size: 3900 chars
hard max: 4096 chars after entities parsing
split by paragraphs first, then lines, then words, then hard code-point safe chunks
```

Formatting recommendation:

```text
MVP: plain text, no parse_mode.
```

Reason:

```text
Markdown/HTML escaping failures should not block core messaging.
Rich formatting can be added after delivery is reliable.
```

If reply is split:

```text
chunk 1 replies to the inbound provider message
chunk 2+ may reply to chunk 1 or be plain continuation in the same topic
projection ledger stores all provider message ids
```

## sendChatAction And Draft Policy

Use `sendChatAction(typing)` only as progress indicator:

```text
after local inbound commit
while runtime turn is reply_expected
throttle to <= every 4 seconds
stop when final reply projection starts
```

Do not use it as:

```text
delivery proof
online proof
agent response proof
```

Do not use `sendMessageDraft` in MVP:

```text
It can leak partial output before external visibility filtering.
It is not a final sent Message with provider message id.
It complicates retry and suppression.
```

## Local Store Placement

Use app-owned data:

```text
getAppDataPath()/messenger-runtime-turns/
getAppDataPath()/messenger-conversations/
getAppDataPath()/messenger-projections/
```

Do not store runtime turn ledger in:

```text
~/.claude/teams/<team>/inboxes
sentMessages.json
renderer state
```

Reason:

```text
Messenger delivery state is app integration state,
not a native agent inbox artifact.
```

## Clean Architecture Placement

Core/domain:

```text
MessengerRuntimeTurn
MessengerTurnStateMachine
MessengerReplyCorrelationPolicy
MessengerTextChunker
ExternalVisibilityPolicy
```

Core/application:

```text
DeliverMessengerInboundToRuntimeUseCase
ObserveLocalVisibleReplyUseCase
RetryMessengerTurnUseCase
CompleteMessengerTurnProjectionUseCase
RecoverMessengerTurnsUseCase
```

Ports:

```text
MessengerRuntimeTurnStore
MessengerConversationStore
MessengerProjectionLedger
TeamRuntimeDeliveryPort
TeamVisibleReplyObserver
MessengerProviderGateway
Clock
```

Adapters:

```text
NativeLeadRuntimeDeliveryAdapter
NativeTeammateInboxDeliveryAdapter
OpenCodeRuntimeDeliveryAdapter
TeamMessageFeedReplyObserver
TelegramProjectionAdapter
FileMessengerRuntimeTurnStore
```

Important:

```text
Core should know "visible reply observed".
Core should not know TeamProvisioningService internals.
```

## Implementation Notes

### Source enum

Add source values instead of overloading existing ones:

```text
messenger_inbound
messenger_reply
messenger_status
messenger_system
```

This makes policy simpler:

```text
source == messenger_reply and to == user and relayOfMessageId matches turn -> projectable
```

### Native lead path

Recommended:

```text
1. Write messenger inbound row to MessengerConversationStore.
2. Write lead inbox row with source=messenger_inbound, conversationId, replyToConversationId, messageId.
3. Trigger lead relay.
4. Set run.activeMessengerReplyContext for this turn.
5. Capture SendMessage(to=user) during that context.
6. Inject conversationId/relayOfMessageId into captured local row before persisting.
7. Observe row and advance turn to reply_observed.
```

### OpenCode path

Recommended:

```text
1. Build OpenCode-native prompt from turn metadata.
2. Require message_send with source=messenger_reply and relayOfMessageId.
3. Reuse visible reply proof pattern from OpenCodePromptDeliveryLedger.
4. Do not accept plain assistant text as external reply unless manual approval is enabled.
```

### TeamMessageFeed observer

Use it only as a convenience observer:

```text
scan for candidate visible reply rows
validate with MessengerReplyCorrelationPolicy
append to MessengerConversationStore
notify projection use case
```

Do not use it as:

```text
canonical conversation history
provider send queue
external visibility policy owner
```

## Edge Cases To Test

Native lead:

- Messenger inbound creates one runtime turn and one lead inbox row.
- Lead replies with native SendMessage to user, turn becomes `reply_observed`.
- Lead outputs plain text only, turn remains `reply_expected` or becomes `no_visible_reply`, but no Telegram send happens.
- Lead outputs plain text plus SendMessage, only SendMessage is projected.
- Native SendMessage stream input shape `to/message` is captured.
- Native SendMessage stream input shape `recipient/content` is captured if that is the real normalized shape.
- Native SendMessage to non-user is not projected.

MCP/OpenCode:

- `message_send` with `relayOfMessageId` matching turn is projected.
- `message_send` with `conversationId` matching turn is projected.
- `message_send` without both correlation signals is local-only or manual-review.
- `message_send` to user without `from` fails clearly.
- `message_send` supports `conversationId` and `replyToConversationId` through MCP schema.
- OpenCode prompt retry asks for visible status only and does not repeat original work.

Concurrency:

- Two Telegram messages in one topic arrive quickly. First turn is active, second waits.
- Lead replies to first, projection completes, second delivers next.
- Two different team topics can process independently.
- Local UI user sends a normal message while messenger turn is active. It does not steal correlation.
- Team route is disabled while turn is pending.
- Team process restarts after prompt delivery and before reply.

Restart recovery:

- App restarts after inbound local commit before runtime delivery.
- App restarts after runtime delivery before reply observed.
- App restarts after reply observed before Telegram projection.
- `sentMessages.json` prunes old rows, but MessengerConversationStore still has the reply.
- Runtime turn with missing local inbox row is marked failed_retryable or repaired.

Provider projection:

- Reply longer than 4096 chars is split and all provider ids are stored.
- First chunk uses `reply_parameters` when provider inbound link exists.
- Telegram send timeout marks projection ambiguous, not duplicate-sent.
- `sendChatAction` failure does not affect turn state.
- `sendMessageDraft` disabled in MVP.

Privacy:

- Tool output, permission requests, idle notices, and internal blocks are not projectable.
- Plain lead capture is local-only.
- Manual approval is required for uncorrelated visible replies.
- Conversation rows record sanitized policy reason codes.

## Decision Update

Add this to the implementation plan:

```text
MessengerRuntimeTurnLedger is mandatory.
Messenger inbound should be delivered one turn at a time per route in MVP.
Telegram projection requires correlated visible replies.
Plain assistant text is not Telegram-projectable by default.
MCP message_send must expose conversationId and replyToConversationId.
Native SendMessage capture must normalize/prove tool field names before messenger launch.
```

Recommended MVP route:

```text
Telegram inbound
-> local conversation append
-> runtime turn ledger pending
-> lead inbox/runtime delivery with correlation metadata
-> explicit visible reply observed
-> conversation outbound append
-> Telegram projection
```

Main remaining uncertainty:

```text
Can native Claude Code SendMessage carry enough metadata for direct correlation,
or do we need sidecar-only correlation for native paths?
```

My current recommendation:

🎯 8   🛡️ 8   🧠 5   Approx change size: +500-1200 LOC

```text
Use sidecar correlation for native SendMessage in MVP,
and use explicit relayOfMessageId/conversationId for MCP message_send.
```

Reason:

```text
It keeps native launch compatible while giving OpenCode/MCP paths stronger structured proof.
```
