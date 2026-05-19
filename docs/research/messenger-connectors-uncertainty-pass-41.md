# Messenger Connectors - Uncertainty Pass 41

Date: 2026-04-30
Scope: lowest-confidence area after relay ACK and provider outbox research

Focus:

- Telegram topic -> team -> lead/teammate route -> durable local message -> agent reply -> Telegram reply
- Runtime acceptance proof for the current Claude lead path
- Reply projection proof from app-visible messages
- Why existing lead relay cannot be the messenger turn engine
- How to reuse OpenCode watchdog ideas without coupling the feature to OpenCode internals

## 1. New Bottom Line

The weakest link is not Telegram topic routing anymore. The weakest link is proving this exact chain:

```text
external Telegram inbound T1
-> local durable inbound L1
-> lead runtime accepted prompt for L1
-> lead produced a user-visible reply R1
-> R1 is correlated to L1
-> provider outbox sent R1 to the same Telegram topic
```

The important correction:

```text
stdin.write callback is not runtime delivery.
plain assistant text is not provider-sendable by default.
leadRelayCapture is not durable enough for external messenger turns.
```

The recommended MVP rule:

```text
Telegram auto-reply requires a durable visible app message with exact relayOfMessageId or an explicit ProviderMessageLink.
```

Everything weaker becomes:

- local-only lead transcript;
- candidate reply;
- manual review;
- retry prompt asking for a concrete visible reply;
- unresolved turn status.

## 2. Sources Checked In This Pass

Official docs:

- Claude Code CLI reference: `--input-format stream-json`, `--output-format stream-json`, `--replay-user-messages`.
- Claude Code headless docs: stream-json output and retry/system events.
- Claude Agent SDK streaming input docs: persistent interactive sessions, queued messages, hooks, context persistence.
- Claude Code hooks docs: hooks receive `transcript_path`, `last_assistant_message`, and lifecycle events.

Local code:

- `TeamProvisioningService.sendMessageToRun()`
- `TeamProvisioningService.relayLeadInboxMessages()`
- `TeamProvisioningService.captureSendMessages()`
- `TeamProvisioningService.hasCapturedVisibleSendMessage()`
- `TeamProvisioningService.findOpenCodeVisibleReplyByRelayOfMessageId()`
- `OpenCodePromptDeliveryLedger`
- `OpenCodeBridgeCommandContract`
- `OpenCodePromptDeliveryWatchdog`
- OpenCode delivery tests in `TeamProvisioningService.test.ts`
- `InboxMessage` and `SendMessageRequest` shared types

## 3. Code Facts That Changed Confidence

### 3.1 `sendMessageToRun()` proves only stdin acceptance

Current lead delivery writes one stream-json user message:

```text
{"type":"user","message":{"role":"user","content":[...]}}
```

Then it resolves after the Node stream write callback.

That proves:

```text
the Node child stdin stream accepted bytes
```

It does not prove:

```text
the runtime parsed the JSON
the prompt was indexed in the session
the prompt was not dropped during process death
the reply belongs to this external turn
the final assistant output is safe for Telegram
```

Official Claude CLI has `--replay-user-messages`, which can improve this from "stdin accepted bytes" to "runtime re-emitted the user message on stdout". That is useful, but still not enough for Telegram auto-send.

Recommended proof ladder for Claude lead:

```text
stdin_write_accepted_by_os
-> replay_user_message_observed
-> prompt_marker_indexed_in_transcript
-> visible_reply_observed
-> visible_reply_persisted
-> provider_outbox_created
```

MVP should treat `replay_user_message_observed` as an acceptance signal only, not as reply proof.

### 3.2 Existing `relayLeadInboxMessages()` is not safe enough

The existing lead relay path:

- batches unread lead inbox messages;
- can relay up to 10 messages at once;
- marks batch read after `sendMessageToRun()` succeeds;
- stores a single mutable `leadRelayCapture` on the run;
- uses timeout and idle windows;
- can persist a generated `lead-process-...` reply without a durable external turn id;
- is designed around internal app inbox relay, not provider-facing delivery.

That is too weak for Telegram:

```text
one Telegram inbound needs one durable local external turn
one external turn needs one correlation id
one provider reply must come from one proven visible reply
```

Do not wrap Telegram around `relayLeadInboxMessages()`.

### 3.3 Existing `captureSendMessages()` is useful but not enough

The current capture path recognizes:

- native `SendMessage`;
- Agent Teams `message_send`;
- cross-team send tools.

For native `SendMessage`, current code reads:

```text
recipient
content
summary
```

while the prompt/canonical shape elsewhere expects:

```text
to
message
summary
```

That normalization still needs to be fixed before Telegram E2E.

More important:

```text
native SendMessage(to="user") currently does not carry exact messenger relayOfMessageId by itself.
```

So native `SendMessage` can be:

- useful local UI output;
- useful candidate reply;
- useful fallback only when an explicit feature-owned active turn context attaches correlation.

But default Telegram auto-send should prefer:

```text
agent-teams_message_send with relayOfMessageId = local external inbound id
```

### 3.4 OpenCode watchdog already solved the right class of problem

OpenCode delivery has a strong shape:

- durable ledger;
- payload hash mismatch detection;
- `prePromptCursor`;
- accepted/responded/unanswered/retry states;
- `acceptanceUnknown`;
- visible reply proof by `relayOfMessageId`;
- semantic reply sufficiency;
- stale session handling;
- deterministic due ordering;
- no blind duplicate prompt when payload changed.

This should become the template for messenger, not a direct dependency.

Reason:

```text
OpenCode details are provider-specific.
Messenger needs provider-neutral external turn semantics.
```

## 4. Official Docs Implication

### 4.1 `--replay-user-messages` should be added to the Claude lead spike

Official CLI says `--replay-user-messages` re-emits stdin user messages on stdout and requires stream-json input and output.

This is nearly ideal as an acceptance marker for our current process model.

Top 3 choices:

1. Add `--replay-user-messages` and correlate replayed user messages by external marker - 🎯 8   🛡️ 8   🧠 5, approx `500-1100` LOC.
   - Recommended.
   - Better than stdin callback.
   - Needs parser fixtures so replayed `type=user` events do not pollute the lead feed.

2. Skip replay and rely only on transcript marker scan - 🎯 7   🛡️ 8   🧠 6, approx `900-1800` LOC.
   - Still viable.
   - Slower to observe and harder to debug live.

3. Keep stdin callback as acceptance proof - 🎯 3   🛡️ 4   🧠 2, approx `80-200` LOC.
   - Too weak for Telegram.

Recommendation:

```text
Use both replay-user-messages and transcript marker scan.
Replay is fast acceptance.
Transcript scan is recovery proof after restart or stream parser loss.
```

### 4.2 Streaming input docs support persistent session design

Claude Agent SDK docs recommend streaming input for long-lived interactive sessions with queued messages, interruptions, hooks, and context persistence.

That supports our direction:

```text
do not launch one process per Telegram message
do not create one bot per command
do not create one topic per command
keep one team topic and durable local turn queue
```

But it also means we need a real local queue and active-turn lock. The runtime is long-lived, so interleaving is the default failure mode unless we guard it.

### 4.3 Hook docs are useful but not enough alone

Hooks expose `transcript_path` and `last_assistant_message`.

Potential use:

- detect active transcript path;
- observe stop/failure events;
- attach deterministic diagnostics;
- help build prompt marker scan fixtures.

Not enough alone:

```text
last_assistant_message can be plain text and may not be Telegram-safe.
hooks do not replace durable relayOfMessageId proof.
```

## 5. Recommended Runtime Turn State Machine

Separate runtime delivery from provider delivery.

```text
claim_received
-> local_prepared
-> ack_accepted
-> runtime_turn_reserved
-> stdin_write_started
-> stdin_write_accepted_by_os
-> replay_user_message_pending
-> replay_user_message_observed
-> prompt_index_pending
-> prompt_indexed
-> visible_reply_pending
-> visible_reply_observed
-> visible_reply_persisted
-> provider_outbox_created
-> completed
```

Failure and unknown states:

```text
stdin_write_failed_before_acceptance
runtime_acceptance_unknown
prompt_index_unknown
visible_reply_missing
visible_reply_ambiguous
visible_reply_not_semantically_sufficient
provider_outbox_not_created
runtime_failed_terminal
```

Important gate:

```text
runtime_turn_reserved cannot happen before ack_accepted in official shared bot mode.
```

Important retry rule:

```text
After stdin_write_accepted_by_os, do not blindly resend the same external message.
Observe first.
```

## 6. New Ledger Needed

Create a provider-neutral ledger:

```text
MessengerRuntimeTurnLedger
```

Suggested record:

```ts
type MessengerRuntimeTurnRecord = {
  id: string;
  accountBindingId: string;
  provider: "telegram";
  routeId: string;
  teamName: string;
  targetKind: "lead" | "teammate";
  targetMemberName: string | null;
  localInboundMessageId: string;
  providerUpdateKey: string;
  providerConversationKey: string;
  payloadHash: string;
  status:
    | "pending"
    | "ack_accepted"
    | "runtime_turn_reserved"
    | "accepted"
    | "prompt_indexed"
    | "responded"
    | "candidate_reply"
    | "awaiting_manual_review"
    | "retry_scheduled"
    | "failed_retryable"
    | "failed_terminal";
  attempts: number;
  maxAttempts: number;
  acceptanceUnknown: boolean;
  activeLockId: string | null;
  runtimeProviderId: string | null;
  runtimeSessionId: string | null;
  prePromptCursor: string | null;
  postPromptCursor: string | null;
  replayedUserMessageId: string | null;
  transcriptUserMessageId: string | null;
  observedAssistantMessageId: string | null;
  visibleReplyMessageId: string | null;
  visibleReplyCorrelation:
    | "relayOfMessageId"
    | "providerMessageLink"
    | "active_turn_context"
    | "plain_assistant_text"
    | null;
  visibleReplyOutboxId: string | null;
  lastReason: string | null;
  diagnostics: string[];
  createdAt: string;
  updatedAt: string;
};
```

This is intentionally close to OpenCode but not the same type.

Why:

- OpenCode has member/lane-specific fields.
- Messenger has provider route, provider update, and official/own-bot account binding fields.
- Messenger needs to link inbound provider identity to local reply proof and provider outbox.

## 7. Prompt Envelope

The external prompt should carry a durable marker that is both visible enough for debugging and machine-parseable.

Recommended marker:

```text
<agent-teams-external-turn>{"schemaVersion":1,"kind":"telegram_inbound","localTurnId":"extmsg_...","routeId":"route_...","conversationId":"conv_..."}</agent-teams-external-turn>
```

Prompt body:

```text
Telegram message for team "<teamName>".
Sender: <display name or redacted id>
Topic: <team topic display name>
Local external turn id: <localTurnId>

<message text>

When replying visibly to the human, use agent-teams_message_send to="user" with relayOfMessageId="<localTurnId>".
Do not include internal notes. If you need more work, send a concise status via the same visible message path.
```

Security rule:

```text
Do not let Telegram user text set relayOfMessageId, routeId, conversationId, to, from, or tool-looking metadata.
Those fields come only from connector domain state.
```

## 8. Transcript Proof

Use two proof channels:

```text
stdout replay:
  fast runtime acceptance signal

transcript marker scan:
  durable recovery signal
```

Pre-injection cursor:

```text
leadSessionId
transcriptPath
fileSize
lastLineOffset
lastKnownMessageUuid
capturedAt
```

Prompt indexed proof:

```text
scan appended JSONL after cursor
find exact external marker or marker hash
extract user message uuid if present
record prompt_indexed
```

If scan fails:

```text
do not assume prompt lost
mark prompt_index_unknown
continue observing for bounded time
show local unresolved state
do not blind retry if stdin was accepted
```

Top 3 transcript proof strategies:

1. Marker scan after prePromptCursor plus stdout replay - 🎯 8   🛡️ 9   🧠 7, approx `1500-3400` LOC.
   - Recommended.
   - Works with current lead process model.
   - Good recovery story after app restart.

2. Hooks-only proof from `UserPromptSubmit` and `Stop` - 🎯 6   🛡️ 7   🧠 6, approx `1200-2600` LOC.
   - Useful auxiliary diagnostics.
   - Hook order and last message are not exact enough for provider auto-send.

3. No transcript scan, only stream-json stdout - 🎯 6   🛡️ 6   🧠 4, approx `700-1600` LOC.
   - Faster implementation.
   - Loses proof across parser crash or app restart.

Recommendation: option 1.

## 9. Reply Projection Policy

### 9.1 Automatic Telegram send

Allowed only when:

```text
local inbound turn id = L1
durable app-visible reply row exists
reply.relayOfMessageId == L1
reply.source is connector-safe or runtime_delivery
reply text passes external visibility policy
provider outbox item was created once with deterministic id
```

Alternative allowed proof:

```text
ExternalMessageLink or ProviderMessageLink explicitly says reply R1 belongs to inbound L1.
```

### 9.2 Candidate only

Candidate reply, not auto-send:

```text
plain assistant text after prompt marker
native SendMessage(to="user") without relayOfMessageId
message_send without relayOfMessageId
reply with same route but no exact localTurnId
reply inferred by timestamp only
reply inferred by newest feed row
```

### 9.3 Manual review

Manual review if:

```text
two replies have same relayOfMessageId and different payload hashes
reply has exact relayOfMessageId but visibility policy fails
reply is plain assistant text and product wants fallback
provider outbox is ambiguous
topic route was repaired while turn was pending
```

Top 3 reply projection choices:

1. Require exact `relayOfMessageId` or explicit provider link for auto-send - 🎯 9   🛡️ 9   🧠 6, approx `900-2200` LOC.
   - Recommended.
   - Lowest wrong-recipient risk.

2. Allow active-turn context to attach `relayOfMessageId` to native `SendMessage` - 🎯 7   🛡️ 8   🧠 7, approx `1400-3200` LOC.
   - Useful later.
   - Requires a typed capture coordinator and one active turn lock.

3. Auto-send plain assistant text if there is only one active Telegram turn - 🎯 5   🛡️ 6   🧠 4, approx `700-1600` LOC.
   - Tempting.
   - Still unsafe when assistant text is status/planning or not meant for Telegram.

Recommendation: option 1 for MVP, option 2 as later compatibility path.

## 10. Active Turn Lock

MVP should enforce:

```text
one active messenger turn per provider route
one active external turn capture per lead run
per-route FIFO
different teams can process independently
```

Lock key:

```text
teamName + routeId + runtimeTarget
```

The lock must block or defer:

- another Telegram inbound for the same team topic;
- manual UI lead prompt that would steal reply correlation;
- internal `relayLeadInboxMessages()` lead capture;
- silent user DM forward;
- post-compact prompt injection;
- crash recovery replay if the first turn is acceptance-unknown.

If lock cannot be acquired:

```text
store inbound turn as queued
do not ACK as runtime-started
do not tell Telegram the desktop is offline
show queued/busy status if product wants a bot response
```

## 11. Duplicate And Retry Matrix

### 11.1 Inbound duplicate provider update

Same `providerUpdateKey`, same payload digest:

```text
return existing local row
return duplicate_local ACK if already local_prepared
do not create a new runtime turn
```

Same `providerUpdateKey`, different payload digest:

```text
payload_conflict
do not deliver to runtime
surface diagnostic
```

### 11.2 Crash before runtime write

State:

```text
ack_accepted, no stdin_write_started
```

Action:

```text
safe retry original runtime injection
```

### 11.3 Crash during runtime write

State:

```text
stdin_write_started but no callback or replay proof
```

Action:

```text
observe transcript first
if marker absent and process/session definitely changed before acceptance, retry
otherwise mark runtime_acceptance_unknown
```

### 11.4 Stdin callback succeeded, no replay or marker

State:

```text
stdin_write_accepted_by_os
```

Action:

```text
observe only
do not blind retry
eventually mark prompt_index_unknown
```

### 11.5 Prompt indexed, no visible reply

Action:

```text
schedule a duplicate-guarded follow-up asking for visible message_send with relayOfMessageId
do not rerun task-heavy work
```

### 11.6 Visible reply persisted, provider send ambiguous

Action:

```text
do not create a second provider outbox item
show ambiguous provider state
manual confirm or explicit duplicate send
```

## 12. Teammate Replies To User

The user asked whether messages from teammates to the user can appear in Telegram.

Yes, but only if route-linked.

Safe policy:

```text
Same team topic.
Prefix sender display name.
Forward teammate reply only when relayOfMessageId or ProviderMessageLink proves it belongs to this external turn.
```

Example:

```text
Alice: I checked the migration. The failing test is in auth/session.test.ts.
```

Do not forward:

- teammate internal chatter;
- messages to lead without an external route link;
- tool logs;
- task status unless external visibility policy allows it;
- messages inferred by timestamp.

Top 3 teammate projection choices:

1. Same team topic, sender prefix, exact route link required - 🎯 8   🛡️ 9   🧠 6, approx `1000-2400` LOC.
   - Recommended.
   - Fits "one topic per team".

2. Separate topic per teammate - 🎯 5   🛡️ 7   🧠 8, approx `2500-5200` LOC.
   - More visible separation.
   - Worse UX and more topic provisioning edge cases.

3. Do not forward teammates in MVP - 🎯 8   🛡️ 8   🧠 2, approx `100-300` LOC.
   - Simplest.
   - Product loses a strong use case.

Recommendation: option 1 after lead-only MVP is stable.

## 13. SOLID And Port Boundaries

Keep these separate:

```text
RuntimeTurnAdmissionPolicy
RuntimeTurnDeliveryLedger
RuntimePromptInjectorPort
RuntimePromptObserverPort
RuntimeVisibleReplyObserverPort
ReplyProjectionPolicy
ProviderOutboxPolicy
TelegramGatewayPort
OfficialRelayTransportPort
OwnBotPollingPort
```

Do not put these in one service:

- Telegram update parsing;
- local JSON store;
- runtime stdin writer;
- transcript JSONL observer;
- visible reply projection;
- provider HTTP send;
- UI status mapping.

Dependency direction:

```text
core/application depends on ports and domain policies
main/adapters implement ports
renderer uses feature public entrypoints
TeamProvisioningService is an adapter, not messenger core
```

This follows the existing `FEATURE_ARCHITECTURE_STANDARD.md` direction and avoids turning `TeamProvisioningService` into the owner of Telegram semantics.

## 14. Proposed Tests Before Implementation

Create these before real Telegram E2E:

```text
MessengerRuntimeTurnLedger.test.ts
  idempotent same providerUpdateKey
  payload hash mismatch terminal
  no runtime start before ack_accepted
  stdin accepted then restart becomes acceptance_unknown
  prompt indexed then no visible reply schedules follow-up
  visible reply with exact relayOfMessageId completes runtime turn

ClaudeLeadPromptDeliveryPolicy.test.ts
  stdin callback alone is not accepted proof
  replay-user-message marks accepted
  transcript marker after cursor marks prompt_indexed
  replayed user event does not create lead UI message
  parser loss plus transcript marker recovers

MessengerReplyProjectionPolicy.test.ts
  message_send with exact relayOfMessageId creates provider outbox
  plain assistant text becomes candidate only
  native SendMessage without relayOfMessageId becomes candidate only
  two replies for same relay id with different hashes require manual review
  wrong route relay id rejected

MessengerActiveTurnLock.test.ts
  same route second inbound queues
  different team can process in parallel
  manual lead prompt is deferred or blocked during external turn
  relayLeadInboxMessages is deferred during external turn

MessengerTeammateProjectionPolicy.test.ts
  teammate reply with relayOfMessageId forwards with sender prefix
  internal teammate chatter does not forward
  missing route link becomes local-only

TelegramProviderOutboxPolicy.test.ts
  exact visible reply creates deterministic outbox id
  send ambiguity does not auto-retry
  manual mark sent closes ambiguous item
```

## 15. Implementation Order Update

Better sequence for the next real implementation:

1. Normalize native `SendMessage` shapes and add tests.
2. Add MCP `message_send` conversation field pass-through.
3. Add provider-neutral messenger domain models and stores.
4. Add relay ACK gate.
5. Add `MessengerRuntimeTurnLedger`.
6. Add active turn lock.
7. Add Claude lead prompt marker injector adapter.
8. Add `--replay-user-messages` compatibility spike.
9. Add transcript marker observer.
10. Add visible reply observer requiring exact `relayOfMessageId`.
11. Add reply projection policy.
12. Add provider outbox.
13. Add Telegram transport gateway.
14. Add official relay and own-bot transport.
15. Add renderer status/manual review UI.

Why runtime ledger before Telegram transport:

```text
Telegram send is easy compared to proving the local reply is the right reply.
```

## 16. Updated Lowest-Confidence Map

1. Claude lead prompt indexing proof.
   🎯 7   🛡️ 8   🧠 8
   - `--replay-user-messages` helps, but transcript proof and parser fixtures are still needed.

2. Exact automatic reply proof for current native lead path.
   🎯 7   🛡️ 8   🧠 7
   - MCP `message_send(relayOfMessageId)` is clean.
   - Native `SendMessage(to=user)` needs feature-owned context before it can auto-send.

3. Active turn interleaving with existing lead prompts and relay jobs.
   🎯 7   🛡️ 8   🧠 8
   - Needs real locks and tests around `leadRelayCapture`, manual prompts, and post-compact injections.

4. Reply semantic sufficiency.
   🎯 7   🛡️ 7   🧠 6
   - Ack-only replies are common and must not close ask-style external turns.

5. Teammate-to-user projection.
   🎯 7   🛡️ 8   🧠 6
   - Feasible, but only after route-linked message proof exists.

## 17. Decision Update

Add these decisions to the living summary:

```text
stdin.write callback is not delivery proof.
Claude lead should use --replay-user-messages plus transcript marker scan.
relayLeadInboxMessages is not the messenger external turn engine.
MessengerRuntimeTurnLedger is separate from provider outbox.
Automatic Telegram replies require relayOfMessageId or explicit provider link.
Plain assistant text stays local/candidate by default.
Native SendMessage(to=user) is not Telegram-safe unless a connector capture context attaches exact relayOfMessageId.
OpenCode watchdog is the model to copy, not a dependency to reuse directly.
```

## 18. Practical MVP Recommendation

MVP should be stricter than the eventual product:

```text
Official bot receives Telegram inbound.
Desktop persists inbound and ACKs only after local durable commit.
Desktop starts runtime only after backend accepts ACK.
Lead prompt includes external marker and asks for message_send(relayOfMessageId).
Runtime acceptance is observed by replay-user-message and/or transcript marker.
Only a durable message_send reply with exact relayOfMessageId creates provider outbox.
Provider outbox sends to the same topic.
Plain assistant text and native SendMessage without connector correlation stay local or manual.
```

This is more code, but it prevents the most expensive bug:

```text
sending the wrong lead response to the wrong Telegram topic or duplicating a user-visible reply.
```

