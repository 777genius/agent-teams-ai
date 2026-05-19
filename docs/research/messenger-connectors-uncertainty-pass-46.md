# Messenger Connectors - Uncertainty Pass 46

Date: 2026-04-30
Scope: runtime acceptance proof, shared lead-turn gate, reply ownership, and Claude stream-json replay behavior

## 1. Bottom Line

The weakest remaining implementation area is now the local runtime handshake:

```text
provider inbound
-> durable local turn
-> exactly one lead/runtime stdin turn
-> proof that runtime accepted the turn
-> proof that a visible reply belongs to that turn
-> exactly one provider outbox item
```

The critical rule is stricter after this pass:

```text
Do not let messenger turns share the lead stdin pipe with UI sends, post-compact reminders,
Gemini hydration, legacy inbox relay, or background recovery without one shared per-team lead-turn gate.
```

The gate is not a Telegram abstraction. It belongs around the local lead runtime. Messenger only owns the durable external policy and link/outbox state.

Recommended implementation:

🎯 9   🛡️ 9   🧠 8   Approx `1500-2800` LOC

```text
Shared per-team LeadTurnGate plus MessengerRuntimeTurnLedger.
Use --replay-user-messages as acceptance proof when capability probe passes.
Use exact relayOfMessageId or explicit ProviderMessageLink for provider auto-send.
```

Rejected shortcut:

🎯 4   🛡️ 4   🧠 3   Approx `250-600` LOC

```text
Check leadActivityState === idle immediately before messenger stdin.write and infer the reply from the next assistant/result event.
```

That shortcut is timing-dependent. It will eventually attach a reply to the wrong Telegram message.

## 2. Official Claude Code Facts

Official CLI reference facts:

- `--input-format stream-json` is a print-mode input format.
- `--output-format stream-json` is a print-mode output format.
- `--replay-user-messages` re-emits stdin user messages back on stdout for acknowledgment.
- `--replay-user-messages` requires both `--input-format stream-json` and `--output-format stream-json`.
- `--include-partial-messages` requires `--print` and `--output-format stream-json`.

Official programmatic usage facts:

- `stream-json` output is newline-delimited JSON for real-time streaming.
- `system/init` reports session metadata.
- `system/api_retry` can appear before a retry.
- Programmatic streaming with `stream-json` is intended for structured consumers, not text scraping.

Official Agent SDK streaming input facts:

- Streaming input is the preferred mode for a long lived interactive session.
- Streaming input supports queued messages, interruption, hooks, real-time feedback, and context persistence.
- Single-message mode is simpler but does not support dynamic message queueing or real-time interruption.

Official Channels reference facts:

- A channel is an MCP server that runs on the same machine as Claude Code.
- A two-way channel can expose a reply tool.
- Inbound handlers should gate on sender identity first.
- Permission relay should only be enabled if the channel authenticates the sender.
- Permission verdict replies must be intercepted before forwarding normal chat text.
- Local terminal permission dialogs remain open, and the first valid local or remote answer wins.

Implication for Agent Teams:

```text
Claude Code Channels validate the shape of "chat bridge plus explicit reply tool",
but they do not replace our durable route binding, link table, runtime turn ledger, or provider outbox.
```

## 3. Local CLI Probe

Local installed version:

```text
Claude Code 2.1.119
```

Local help confirms:

```text
--replay-user-messages
  Re-emit user messages from stdin back on stdout for acknowledgment
  only works with --input-format=stream-json and --output-format=stream-json
```

Local probe command:

```bash
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Reply exactly OK."}}' \
  | timeout 60 claude -p \
      --input-format stream-json \
      --output-format stream-json \
      --replay-user-messages \
      --max-turns 1 \
      --tools "" \
      --permission-mode dontAsk \
      --verbose
```

Observed stdout sequence:

```text
1. system/init
2. user replay event
3. assistant event
4. result success event
```

Observed replay event shape:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "Reply exactly OK."
  },
  "session_id": "f81a69ba-ccb4-4219-aa04-f4cd84092e9e",
  "parent_tool_use_id": null,
  "uuid": "2de842b6-cacd-4924-9ff6-455a66d2daac",
  "timestamp": "2026-04-29T21:56:42.146Z",
  "isReplay": true
}
```

Observed assistant event shape:

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "OK" }
    ]
  },
  "session_id": "f81a69ba-ccb4-4219-aa04-f4cd84092e9e"
}
```

Observed result event shape:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "num_turns": 1,
  "result": "OK",
  "stop_reason": "end_turn",
  "session_id": "f81a69ba-ccb4-4219-aa04-f4cd84092e9e"
}
```

Important local finding:

```text
--output-format stream-json required --verbose in this CLI run.
```

This matches current Agent Teams launch args, which already include:

```text
--input-format stream-json
--output-format stream-json
--verbose
```

Current Agent Teams launch args do not include:

```text
--replay-user-messages
```

Interpretation:

```text
replay_user_message_observed is strong proof that Claude Code accepted and indexed
the input into its stream-json session.
```

But:

```text
replay_user_message_observed is not proof that the model answered that turn,
and not proof that a later visible reply belongs to that turn unless a lead-turn gate
prevents interleaving.
```

## 4. Local Code Facts

### 4.1 Lead stdin injection

`TeamProvisioningService.sendMessageToRun()`:

- checks current run and writable stdin;
- builds a stream-json `type=user` payload;
- writes one line to stdin;
- resolves on `stdin.write` callback;
- sets lead activity to `active`.

Current payload has no explicit messenger correlation field:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "..." }
    ]
  }
}
```

Messenger requirement:

```text
Add an explicit opaque turn marker inside trusted prompt text,
and store the marker in MessengerRuntimeTurnLedger before stdin write.
```

The marker is needed because the replay event echoes message content, but creates its own `uuid`.

### 4.2 Current stdout `type=user` handling

`handleStreamJsonMessage()` currently handles `msg.type === "user"` by:

- extracting raw user text;
- parsing permission_request JSON;
- finishing runtime tool activity from `tool_result` blocks;
- handling native teammate user messages;
- returning.

Risk after enabling replay:

```text
An app-originated replayed user message can be misclassified as permission or teammate traffic
unless app replay is detected before existing user-message parsing.
```

Required classifier order:

```text
1. app prompt replay with isReplay=true and known turn marker
2. runtime permission/control messages
3. tool_result blocks
4. teammate message blocks
5. unknown user stdout
```

### 4.3 Current result handling is process-level

`result: success` currently:

- clears post-compact reminder in-flight flags;
- clears Gemini hydration in-flight flags;
- resets runtime tool activity;
- sets lead activity to idle;
- resolves `leadRelayCapture` if present;
- clears silent relay state and pending relay candidates;
- may inject deferred reminders/hydration.

This is process-level completion, not a typed turn completion.

Risk:

```text
If two stdin turns overlap, result success cannot safely identify which user turn it completed.
```

Therefore:

```text
Messenger must not depend on result success without a shared per-team turn gate.
```

### 4.4 Current native SendMessage capture mismatch

`captureSendMessages()` currently reads native `SendMessage` as:

```text
recipient
content
summary
```

But the canonical prompt guidance often says:

```text
to
message
summary
```

Required before E2E:

```text
recipient = input.recipient ?? input.to
content = input.content ?? input.message
summary = input.summary
```

### 4.5 Current TeamDataService pass-through gap

`SendMessageRequest` supports:

```text
relayOfMessageId
conversationId
replyToConversationId
```

`TeamDataService.sendMessage()` passes `conversationId` and `replyToConversationId`, but still does not pass `relayOfMessageId` into `controller.messages.sendMessage()`.

This blocks exact projection for UI/manual sends until fixed.

## 5. Updated Proof Ladder

The durable proof ladder should be:

```text
provider_update_committed
-> route_decision_committed
-> messenger_turn_created
-> lead_turn_gate_lease_acquired
-> stdin_write_completed
-> replay_user_message_observed
-> prompt_marker_observed
-> assistant_or_tool_reply_observed
-> internal_reply_persisted
-> external_message_link_created
-> provider_outbox_item_created
-> provider_send_started
-> provider_send_succeeded
```

Important separations:

```text
stdin_write_completed:
  OS accepted bytes into the child stdin pipe.

replay_user_message_observed:
  Claude Code emitted the app input back on stdout.

prompt_marker_observed:
  Our correlation marker was observed in replay or transcript after the expected cursor.

assistant_or_tool_reply_observed:
  The lead produced text or an explicit user-directed tool call while this turn owned the gate.

internal_reply_persisted:
  We wrote the local canonical reply row/link.

provider_outbox_item_created:
  Provider sending is now independent from runtime.
```

Do not collapse these states.

## 6. Lead Turn Gate

### 6.1 Goal

The gate must serialize all lead stdin writes that can produce a `result` event or visible output.

Lead turn kinds:

```ts
type LeadTurnKind =
  | "ui_user"
  | "external_messenger"
  | "post_compact_reminder"
  | "gemini_hydration"
  | "legacy_inbox_relay"
  | "system_recovery";
```

Turn ownership:

```text
One active lead turn per team run.
No second stdin user turn starts until the active turn reaches success, error, timeout, or cleanup.
```

### 6.2 Top options

1. Shared per-team LeadTurnGate - 🎯 9   🛡️ 9   🧠 8, approx `1500-2800` LOC.
   Recommended. Wraps UI sends, external messenger, reminders, hydration, and legacy relay. Makes reply ownership deterministic.

2. External-only gate plus collision detection - 🎯 7   🛡️ 7   🧠 6, approx `700-1300` LOC.
   Useful stepping stone, but still vulnerable if a normal UI send bypasses the gate.

3. Idle check only - 🎯 4   🛡️ 4   🧠 3, approx `250-600` LOC.
   Reject. Race-prone around `leadActivityState`, async stdin writes, and deferred reminder injection.

### 6.3 Recommended gate states

```text
idle
queued
leased
stdin_writing
awaiting_replay
awaiting_result
completed
errored
timed_out
interrupted_by_cleanup
```

For `external_messenger`, mirror these into durable messenger states:

```text
runtime_pending
runtime_leased
stdin_write_started
stdin_write_completed
runtime_replay_observed
runtime_prompt_marker_observed
runtime_reply_observed
runtime_no_reply
runtime_error
runtime_ambiguous_after_injection
```

### 6.4 Queue policy

Recommended:

```text
priority:
  ui_user > external_messenger > legacy_inbox_relay > system_recovery > post_compact_reminder > gemini_hydration
```

But:

```text
Once an external messenger turn is injected, it must not be preempted.
```

Rationale:

- before injection, external message can wait;
- after injection, duplicate-prevention is more important than latency;
- background reminders can wait;
- user UI sends can jump ahead only before another turn starts writing.

## 7. Reply Capture Policy

### 7.1 Recommended MVP policy

For Telegram auto-send:

```text
Auto-send only explicit user-directed replies with exact turn correlation.
```

Allowed auto-send candidates:

```text
SendMessage(to=user) or SendMessage(recipient=user)
with connector-attached relayOfMessageId

message_send(to=user)
with relayOfMessageId

teammate -> user inbox row
with relayOfMessageId or explicit ProviderMessageLink
```

Manual-review candidates:

```text
visible assistant text with active external turn marker but no explicit SendMessage
plain assistant result text
reply text inferred from newest feed row
```

Rejected auto-send candidates:

```text
visible assistant text with no turn marker
any text after result success without gate ownership
message text matched by similarity
latest TeamMessageFeedService row
timestamp proximity
```

### 7.2 Top options

1. Explicit reply tool only for MVP - 🎯 9   🛡️ 10   🧠 5, approx `600-1300` LOC.
   Best reliability. The prompt tells lead and teammates to use SendMessage/message_send for external replies.

2. Explicit reply plus visible assistant fallback behind manual review - 🎯 8   🛡️ 9   🧠 6, approx `900-1800` LOC.
   Good product compromise. User can approve fallback text if the lead answers naturally.

3. Explicit reply plus automatic visible text fallback - 🎯 6   🛡️ 6   🧠 5, approx `700-1500` LOC.
   Convenient but risky. A lead can narrate internally and accidentally send that to Telegram.

Recommendation:

```text
Use option 1 for MVP, option 2 if UX needs fallback.
Do not use option 3 until we have fixtures proving stable turn ownership and text semantics.
```

## 8. Runtime Event Ports

Keep the feature boundary SOLID:

```ts
interface LeadTurnGatePort {
  enqueueTurn(input: LeadTurnRequest): Promise<LeadTurnLeaseResult>;
}

interface RuntimeTurnObserverPort {
  onUserReplay(event: RuntimeUserReplayEvent): void | Promise<void>;
  onAssistantMessage(event: RuntimeAssistantMessageEvent): void | Promise<void>;
  onToolUse(event: RuntimeToolUseEvent): void | Promise<void>;
  onResult(event: RuntimeResultEvent): void | Promise<void>;
  onCleanup(event: RuntimeCleanupEvent): void | Promise<void>;
}

interface RuntimeOutboundObserverPort {
  onLocalVisibleReply(event: RuntimeVisibleReplyEvent): void | Promise<void>;
}
```

Dependency direction:

```text
messenger-connectors core defines use cases and ports.
main/services/team implements runtime adapter and gate.
Telegram adapter never imports TeamProvisioningService.
Renderer never observes bot tokens or raw provider updates.
```

## 9. Prompt Marker Contract

Recommended marker:

```text
<agent-teams-external-message
  version="1"
  provider="telegram"
  turn_id="..."
  route_id="..."
  provider_message_key_hash="..."
/>
```

Rules:

- Marker is generated by local trusted code.
- Marker id is random and not derived from user text.
- Marker includes no raw Telegram message text.
- Marker hash is for diagnostics only, not route identity.
- Runtime replay classifier must match the marker exactly.
- If marker is missing in replay, turn becomes `runtime_replay_without_marker`.
- If marker appears in an unexpected stdout path, store diagnostic and do not auto-send.

Prompt instruction around marker:

```text
This is an internal routing marker. Do not quote it, forward it, summarize it, or show it to the user.
When replying to the external user, use SendMessage to user with the supplied relayOfMessageId.
```

## 10. Permission Relay Decision

Official Channels docs support remote permission relay, but it is not a free MVP feature.

MVP decision:

```text
Do not relay tool permissions through Telegram in the first messenger MVP.
```

Reason:

- A messenger bridge to local code execution is sensitive.
- Sender authentication must be fully proven first.
- Permission replies need exact ID parsing and must not fall through into normal chat.
- Group chats and forwarded messages make trust ambiguous.
- Local UI already supports safer review.

Future option:

🎯 7   🛡️ 8   🧠 7   Approx `900-1800` LOC

```text
Enable permission relay only for verified private chat sender, exact request id,
short expiration, and local visible audit trail.
```

## 11. Updated Edge Cases

### 11.1 Replay arrives after result

Policy:

```text
If result arrives before replay for a turn that expected replay, mark runtime_order_violation.
Do not auto-send provider reply.
```

### 11.2 Replay echoes malformed content

Policy:

```text
If isReplay=true but marker is missing, store replay event and mark runtime_replay_unmatched.
Do not infer by text.
```

### 11.3 Assistant replies before replay

Policy:

```text
Store assistant event, but do not project externally until replay/marker proof arrives.
If proof never arrives, manual review only.
```

### 11.4 Two result success events

Policy:

```text
First result closes active lead turn.
Second result without active turn is runtime_unowned_result and cannot release any messenger turn.
```

### 11.5 Cleanup after stdin write

Policy:

```text
If stdin_write_completed and cleanup happens before result or reply persistence,
mark runtime_ambiguous_after_injection.
Do not auto-reinject.
```

### 11.6 UI sends during external turn

Policy:

```text
UI send is queued behind active external turn after external stdin write starts.
Before external turn starts writing, UI send may take priority.
```

### 11.7 Post-compact during external turn

Policy:

```text
Compact boundary records pending reminder.
Reminder waits until external turn closes.
```

### 11.8 Gemini hydration during external turn

Policy:

```text
Hydration waits until external turn closes.
If hydration is already active, external turn waits or becomes deferred_busy.
```

### 11.9 Explicit reply plus visible narration

Policy:

```text
Explicit user-directed send wins.
Visible narration from same assistant message is local-only.
```

### 11.10 Visible narration only

Policy:

```text
Manual review in MVP, or local-only status.
No Telegram auto-send unless product explicitly chooses fallback mode.
```

### 11.11 Teammate reply to user

Policy:

```text
Teammate reply can be projected only from user inbox row with relayOfMessageId
or explicit ProviderMessageLink.
```

### 11.12 Existing lead relay capture active

Policy:

```text
External turn waits.
Do not arm a second capture field in parallel.
```

## 12. Implementation Sequence Updates

Insert these before Telegram E2E:

1. Add native `SendMessage` shape normalizer.
2. Pass `relayOfMessageId` through `TeamDataService.sendMessage()`.
3. Add `LeadTurnGate` around all lead stdin writes.
4. Add `RuntimeStdoutUserMessageClassifier` before current `msg.type === "user"` handling.
5. Capability-probe `--replay-user-messages`.
6. Add prompt marker injector.
7. Add replay marker observer.
8. Add result ownership handling.
9. Add external visible reply observer requiring exact relay/link proof.
10. Add ambiguous-after-injection recovery UI state.

Do not implement Telegram transport before these local contracts are testable.

## 13. Tests To Add

```text
test/main/services/team/
  LeadTurnGate.test.ts
  TeamProvisioningServiceReplayUserClassifier.test.ts
  TeamProvisioningServiceSendMessageShape.test.ts
  TeamDataServiceSendMessageRelayOfMessageId.test.ts

test/main/features/messenger-connectors/
  messengerRuntimeTurnLedger.test.ts
  runtimeReplayMarkerPolicy.test.ts
  runtimeReplyProjectionPolicy.test.ts
  runtimeAmbiguousAfterInjection.test.ts
```

Must-pass cases:

1. `stdin.write` callback without replay does not mark runtime accepted.
2. Replay with `isReplay=true` and marker marks runtime accepted.
3. Replay without marker does not match by text.
4. Replay with unknown marker does not match active turn.
5. App replay containing `permission_request` text is not parsed as runtime permission.
6. Active external turn blocks post-compact reminder injection.
7. Active external turn blocks Gemini hydration injection.
8. UI send can preempt queued external turn before external write starts.
9. UI send cannot interrupt external turn after external write starts.
10. Result success closes exactly one active turn.
11. Result success with no active turn is ignored for messenger ownership.
12. Cleanup after stdin write marks ambiguous and does not auto-reinject.
13. Explicit `SendMessage(to=user)` wins over visible narration.
14. Native `SendMessage(recipient=user, content=...)` and `SendMessage(to=user, message=...)` both normalize.
15. `TeamDataService.sendMessage()` persists `relayOfMessageId`.
16. Teammate user-inbox reply without relay/link stays manual review.

## 14. Remaining Lowest-Confidence Points

1. Exact current team launch behavior after adding `--replay-user-messages` - 🎯 7   🛡️ 8   🧠 5.
   The small CLI probe works, but we still need a real Agent Teams launch fixture with team bootstrap, MCP config, and current parser.

2. Shared LeadTurnGate regression risk - 🎯 8   🛡️ 9   🧠 8.
   Architecturally needed, but it touches many paths in a large service.

3. Native `SendMessage` canonical shape - 🎯 8   🛡️ 9   🧠 3.
   Easy to normalize, but must be fixture-proven against actual lead output.

4. Visible assistant fallback semantics - 🎯 6   🛡️ 7   🧠 5.
   Product-convenient, but too easy to leak internal narration. Keep manual-review only in MVP.

5. Permission relay through messenger - 🎯 6   🛡️ 8   🧠 7.
   Official pattern exists, but local trust/audit UX is not designed yet.

## 15. Source Links

- Claude Code CLI reference: https://code.claude.com/docs/en/cli-usage
- Claude Code programmatic usage: https://code.claude.com/docs/en/headless
- Claude Agent SDK streaming input: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- Claude Code Channels reference: https://code.claude.com/docs/en/channels-reference
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
