# Messenger Connectors - Uncertainty Pass 37

Date: 2026-04-29
Scope: lowest-confidence implementation contracts after pass 36, especially native visible reply capture, MCP correlation, Telegram outbound ambiguity, and keeping the research state actionable

## Executive Delta

Pass 36 identified the critical chain:

```text
Telegram topic
-> team route
-> lead or teammate runtime turn
-> durable local message
-> correlated visible agent reply
-> Telegram projection
```

The weakest remaining areas are now narrower:

1. Native `SendMessage` field contract is internally inconsistent.
2. MCP `message_send` lacks two correlation fields that lower stores already support.
3. Telegram outbound has no provider idempotency key, so ambiguous network failures must be first-class state.
4. `sentMessages.json` and `TeamMessageFeedService` are useful projections but not reliable provider ledgers.
5. The research history needs a stable summary doc so implementation decisions do not get buried.

Most important new finding:

```text
Native SendMessage prompt contracts say: to, summary, message.
Native SendMessage capture currently reads: recipient, content.
The code even labels recipient/content as forbidden aliases in prompt rules.
```

This is the highest-risk local contract before messenger launch.

## Source Facts Rechecked

Telegram official facts checked on 2026-04-29:

- Incoming updates are stored until the bot receives them, but not longer than 24 hours.
- `getUpdates` confirms an update when called with an offset higher than the update id.
- `getUpdates` does not work while an outgoing webhook is set.
- Webhook delivery is retried on non-2xx responses and then abandoned after Telegram's retry policy.
- `setWebhook.secret_token` is sent in `X-Telegram-Bot-Api-Secret-Token`.
- `sendMessage` returns a `Message` on success.
- `sendMessage` accepts `message_thread_id`, `reply_parameters`, and `text`, but has no idempotency key parameter in the documented method signature.
- `createForumTopic` works in forum supergroups and private chats with a user.
- `getManagedBotToken` returns the managed bot token as a string.
- Telegram allows answering a webhook request with a Bot API method, but the docs say it is not possible to know whether that request succeeded or get its result.

Sources:

- https://core.telegram.org/bots/api#getting-updates
- https://core.telegram.org/bots/api#getupdates
- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#sendmessage
- https://core.telegram.org/bots/api#createforumtopic
- https://core.telegram.org/bots/api#getmanagedbottoken
- https://core.telegram.org/bots/api#making-requests-when-getting-updates

Implications:

```text
Official shared bot backend must not use inline webhook responses for user-visible replies.
We need the returned provider Message id, so sends must happen through an explicit outbox worker.
Provider outbound ambiguous state is mandatory because Telegram does not expose a client idempotency key.
Own-bot polling must persist local ownership before advancing offset.
Webhook mode must persist local ownership before returning 2xx or before returning a terminal offline response.
```

## Local Code Facts Rechecked

### Native SendMessage prompt contract

Current canonical prompt helpers define:

```text
SEND_MESSAGE_CANONICAL_FIELDS = to, summary, message
SEND_MESSAGE_FORBIDDEN_ALIAS_FIELDS = recipient, content
```

The UI direct-message prompt also says:

```text
The SendMessage tool input must use exact field names to, summary, message.
```

The native runtime protocol helper builds examples like:

```text
SendMessage { to: "team-lead", summary: "short", message: "body" }
```

### Native SendMessage capture path

`TeamProvisioningService.captureSendMessages()` currently reads native tool input as:

```ts
recipient = inp.recipient
msgContent = inp.content
summary = inp.summary
```

`hasCapturedVisibleSendMessage()` also checks native `recipient/content`.

Tests for live native `SendMessage` use:

```ts
input: {
  type: 'message',
  recipient: 'user',
  content: 'Task completed!',
  summary: 'Done',
}
```

Implication:

```text
Messenger cannot rely on native SendMessage until capture accepts the canonical fields,
or until we prove the CLI stream-json normalizes canonical input to recipient/content.
```

### MCP message_send correlation gap

`mcp-server/src/tools/messageTools.ts` exposes:

```text
teamName
to
text
from
summary
source
relayOfMessageId
leadSessionId
attachments
taskRefs
```

It does not expose:

```text
conversationId
replyToConversationId
```

But these already exist in lower-level types/stores:

- `src/shared/types/team.ts` `SendMessageRequest`
- `TeamSentMessagesStore`
- `agent-teams-controller/src/internal/messageStore.js`
- cross-team MCP tool schema

Implication:

```text
MCP message_send needs a small schema/pass-through change,
not a new data model.
```

### sentMessages and feed boundaries

`TeamSentMessagesStore`:

- Keeps only newest 200 rows.
- Uses atomic write, but no file lock around read-modify-write.
- Preserves `relayOfMessageId`, `conversationId`, and `replyToConversationId`.

`TeamMessageFeedService`:

- Merges several local projections.
- Dedupes and annotates for UI.

Implication:

```text
These are good observer inputs.
They are not durable provider ledgers and must not own Telegram projection state.
```

### Existing reliable patterns to reuse

`RuntimeDeliveryJournalStore.begin()` already models:

```text
new
already_committed
resume_pending
payload_conflict
```

`OpenCodePromptDeliveryLedgerStore.ensurePending()` already models:

```text
payload hash conflict
attempts
visible reply correlation
terminal failure
```

Implication:

```text
MessengerRuntimeTurnLedger should be a feature-owned sibling pattern,
not a thin dependency on OpenCode internals.
```

## Top 3 Lowest-Confidence Areas

### 1. Native SendMessage field contract

🎯 9   🛡️ 9   🧠 3   Approx change size: 180-420 LOC with tests

Recommended option:

```text
Normalize both native shapes at the capture boundary:
to = input.to ?? input.recipient
message = input.message ?? input.content
summary = input.summary
```

Then add tests for:

- canonical `to/summary/message`
- legacy or normalized `recipient/content`
- both fields present with conflict
- empty message
- `to=user` projection context
- `to=teammate` non-projection path

Why:

```text
The app already tells agents that recipient/content are forbidden aliases,
but capture only sees those aliases today.
That makes visible reply capture non-deterministic for any messenger turn.
```

Rejected alternatives:

1. Enforce only `to/message` immediately - 🎯 6   🛡️ 7   🧠 2   Approx 80-180 LOC.
   Risk: if real CLI stream-json normalizes native tool calls to `recipient/content`, production capture breaks.
2. Keep only `recipient/content` and update prompts - 🎯 4   🛡️ 5   🧠 2   Approx 80-200 LOC.
   Risk: reverses recent canonical-contract work and keeps the app coupled to an unproven alias.
3. Require new `messenger_reply` tool for native MVP - 🎯 7   🛡️ 9   🧠 8   Approx 1500-3500 LOC.
   Good fallback, but too much before we try the cheap normalization.

Decision:

```text
Add native SendMessage normalization before implementing Telegram projection.
```

### 2. MCP message_send correlation surface

🎯 9   🛡️ 9   🧠 2   Approx change size: 80-220 LOC with tests

Recommended option:

```text
Add optional conversationId and replyToConversationId to message_send schema,
pass them through to getController(...).messages.sendMessage(...).
```

Why:

- The type and store fields already exist.
- Cross-team MCP already exposes the same concepts.
- Messenger should reuse the existing conversation vocabulary.
- `relayOfMessageId` remains the strongest correlation signal, but `conversationId` is needed for topic-thread continuity and reply grouping.

Rejected alternatives:

1. Add messenger-specific `messengerConversationId` - 🎯 5   🛡️ 6   🧠 3   Approx 150-350 LOC.
   Risk: duplicates existing semantics.
2. Rely only on `relayOfMessageId` - 🎯 7   🛡️ 7   🧠 1   Approx 0-80 LOC.
   Risk: works for single-message turns but weak for grouped conversations and cross-team continuity.
3. Add dedicated `messenger_reply` now - 🎯 7   🛡️ 9   🧠 8   Approx 1500-3500 LOC.
   Strong but premature.

Decision:

```text
Expose existing conversation fields in message_send.
Do not invent new messenger-only fields for the same contract.
```

### 3. Telegram outbound ambiguity

🎯 9   🛡️ 9   🧠 5   Approx change size: 900-1800 LOC

Recommended option:

```text
Use a provider outbox with explicit states:
queued
sending
sent
rate_limited
failed_retryable
failed_terminal
ambiguous
```

Rules:

- `sent` requires Telegram `sendMessage` success with returned `Message.message_id`.
- `ambiguous` means request may have reached Telegram but response was lost.
- `ambiguous` must not auto-resend by default.
- Manual retry should create a new explicit attempt record.
- Split long text before send, and store links for every chunk.
- `reply_parameters` failure may retry once without reply parameters but same topic.

Why:

```text
Telegram sendMessage does not expose a documented idempotency key.
Automatic retry after network timeout can duplicate visible Telegram messages.
```

Rejected alternatives:

1. Auto-retry every timeout - 🎯 5   🛡️ 4   🧠 3   Approx 400-900 LOC.
   Risk: duplicates replies in Telegram.
2. Send Telegram replies inside webhook response - 🎯 3   🛡️ 3   🧠 4   Approx 300-700 LOC.
   Telegram docs say the app cannot know success or receive result in that mode.
3. Drop ambiguous sends silently - 🎯 6   🛡️ 5   🧠 2   Approx 200-500 LOC.
   Risk: invisible data loss and impossible support debugging.

Decision:

```text
Provider outbox ambiguity is part of MVP, not a later reliability polish.
```

## Updated Implementation Gate

Before any Telegram end-to-end projection:

```text
1. Add MessengerResearchSummary as the living context index.
2. Add native SendMessage input normalizer and tests.
3. Add MCP message_send conversationId/replyToConversationId pass-through and tests.
4. Create MessengerRuntimeTurnLedger domain state machine.
5. Create provider outbox state machine with ambiguous state.
6. Only then connect Telegram sendMessage.
```

Why order matters:

```text
If Telegram send comes first, the project will be tempted to use feed/newest-message heuristics.
That is the path most likely to send the wrong private answer to the wrong topic.
```

## Clean Architecture Mapping

Core/domain:

```text
NativeSendMessageInputPolicy
MessengerReplyCorrelationPolicy
MessengerOutboxStateMachine
MessengerRuntimeTurnStateMachine
TelegramTextChunkingPolicy
ExternalVisibilityPolicy
```

Core/application:

```text
ObserveLocalVisibleReplyUseCase
QueueProviderOutboundUseCase
MarkProviderOutboundResultUseCase
RecoverMessengerOutboxUseCase
RecoverRuntimeTurnsUseCase
```

Ports:

```text
LocalVisibleMessageObserver
MessengerRuntimeTurnRepository
MessengerOutboxRepository
MessengerProviderGateway
MessengerConversationRepository
LoggerPort
ClockPort
```

Main adapters:

```text
NativeSendMessageObserverAdapter
OpenCodeMessageSendObserverAdapter
TelegramSendMessageGateway
FileMessengerOutboxRepository
FileMessengerRuntimeTurnRepository
```

SRP check:

```text
SendMessage normalization belongs at the local observer adapter boundary.
Reply correlation belongs in core policy.
Telegram retry and rate-limit handling belongs in provider gateway/outbox application flow.
Renderer health UI only displays state; it does not decide retry semantics.
```

OCP check:

```text
Discord/WhatsApp later add provider gateways and capability mappings.
They should not change MessengerRuntimeTurnLedger or local reply correlation rules.
```

DIP check:

```text
Core sees ProviderMessageLink and ProviderCapabilities,
not Telegram Bot API objects.
```

## Edge Cases Added By This Pass

Native capture:

- Agent calls canonical `SendMessage { to, summary, message }`.
- Agent calls legacy/normalized `SendMessage { recipient, summary, content }`.
- Agent sends both canonical and alias fields with different values.
- Agent sends `SendMessage` with empty canonical message and non-empty alias content.
- Agent sends `SendMessage(to="user")` while no messenger turn is active.
- Agent sends `SendMessage(to="user")` while exactly one messenger turn is active.
- Agent sends `SendMessage(to="user")` while two candidate messenger turns are active. Must not auto-project.

MCP correlation:

- `message_send` with `relayOfMessageId` and `conversationId` both matching the turn.
- `message_send` with only `conversationId` matching a unique active turn.
- `message_send` with stale `relayOfMessageId` and matching `conversationId`. Must prefer exact relay mismatch failure over guessing.
- `message_send` with no correlation fields. Must be local-only or manual-review.

Provider outbox:

- Telegram send success stores every returned `message_id`.
- Telegram send timeout becomes `ambiguous`.
- App restart during `sending` recovers as `ambiguous` or `failed_retryable`, never blindly `queued`.
- Telegram `retry_after` becomes `rate_limited` with next attempt time.
- Telegram rejects `reply_parameters`, retry once without reply target and store degraded reason.
- Telegram rejects `message_thread_id`, disable topic binding and ask user to repair.

Summary hygiene:

- New research decisions are added to `messenger-connectors-research-summary.md`.
- Every uncertainty pass updates the top open risks and implementation gates.
- Summary uses stable links to detailed docs.

## Decision Update

Add to canonical plan:

```text
Native SendMessage capture must be normalized before messenger projection.
MCP message_send must expose conversationId and replyToConversationId.
Telegram provider outbox must model ambiguous sends.
Inline webhook Bot API responses are disallowed for user-visible replies.
sentMessages.json and TeamMessageFeedService are observer inputs only.
```

Updated MVP confidence:

```text
Official shared bot + one topic per team + optional own bot
with MessengerRuntimeTurnLedger and provider outbox:
🎯 8   🛡️ 9   🧠 8   Approx implementation size: 8000-13000 LOC with tests
```

Remaining highest uncertainty:

```text
Whether native Claude Code stream-json emits canonical SendMessage fields,
or whether it normalizes to recipient/content.
```

But the recommended mitigation is clear:

```text
Accept both shapes at capture boundary,
record which shape was seen in diagnostics,
and test both before Telegram E2E.
```
