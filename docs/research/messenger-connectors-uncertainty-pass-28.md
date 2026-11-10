# Messenger Connectors - Uncertainty Pass 28

Date: 2026-04-28
Scope: internal delivery, reply capture, projection correctness, and loop prevention
Context source: local code in `src/main/services/team`, `src/main/ipc/teams.ts`, `src/renderer/utils/teamMessageFiltering.ts`

## Executive Delta

The next weakest area is the internal app boundary:

```text
Telegram inbound -> durable local turn -> lead/teammate runtime -> user-visible reply -> Telegram outbound
```

The current app has several strong pieces, especially OpenCode prompt delivery ledgers, but the existing UI send path and lead inbox relay are not safe enough to reuse directly as the messenger protocol.

New conclusion:

```text
Build a dedicated MessengerInternalTurnLedger and MessengerReplyCollector.
Do not use renderer message feed or TeamMessageFeedService.feedRevision as the projection authority.
Do not rely on leadRelayCapture batch semantics for Telegram replies.
```

## Source Facts Rechecked

Local code facts:

- `TeamDataService.sendMessage()` delegates to the controller and invalidates message feed. It is not a messenger-specific durable state machine.
- UI direct-to-live-lead path sends stdin first, then persists best-effort through `sendDirectToLead()`.
- If stdin succeeds but persistence fails, existing UI code intentionally does not fall back to inbox because that would duplicate.
- `sendDirectToLead()` appends a `user_sent` message and returns `deliveredViaStdin: true`.
- Offline lead or teammate path writes to inbox files through `TeamInboxWriter`, which uses file locks and verifies the write.
- `relayLeadInboxMessages()` is batch-oriented, can relay up to 10 unread messages, and has an in-memory `leadRelayCapture` with a 15 second timeout.
- `relayLeadInboxMessages()` is built for lead inbox maintenance, not for exact provider-message correlation.
- `sentMessages.json` is capped at 200 messages.
- `TeamMessageFeedService` merges inbox, lead session messages, and sent messages. It dedupes, attaches session ids, links passive summaries, caches for 5 seconds and emits a `feedRevision`.
- Renderer `filterTeamMessages()` hides task comment notifications, noise, relay duplicates and other UI-only details.
- OpenCode prompt delivery already has a stronger model: ledger, response states, visible reply proof via `relayOfMessageId`, acceptance unknown and retry policy.

Telegram facts already relevant:

- Telegram update ids support deduping inbound updates.
- Telegram outbound `sendMessage` has no client-supplied idempotency key.
- Telegram `reply_to_message` is same chat and same thread; `external_reply` can cross chat/topic and must not drive teammate routing.

Sources:

- https://core.telegram.org/bots/api
- https://core.telegram.org/method/messages.sendMessage

## 1. Existing UI Send Path Is Not The Messenger Delivery Protocol

The UI path is optimized for responsiveness:

```text
alive lead:
  send stdin
  persist user_sent best-effort

offline lead or teammate:
  write inbox
  maybe relay later
```

For Telegram this is too weak because the provider side needs durable causality.

Danger scenario:

```text
1. Telegram update arrives.
2. Desktop sends to live lead stdin.
3. App crashes before persisting internal message/link.
4. Lead may answer, but connector cannot prove which Telegram message it answered.
```

Top 3 internal delivery options:

1. Dedicated `MessengerInternalTurnLedger` with durable inbound-before-runtime and runtime ambiguity states - 🎯 9   🛡️ 9   🧠 7, approx 2000-4200 LOC.
   - Correct for provider causality.
   - Can reuse `TeamInboxWriter`, `TeamSentMessagesStore`, and OpenCode ledger ideas.
   - More code, but isolates messenger invariants.

2. Reuse existing `handleSendMessage`/`TeamDataService.sendMessage` and add source metadata - 🎯 5   🛡️ 5   🧠 3, approx 500-1200 LOC.
   - Fast demo.
   - Does not solve stdin-first persistence gap.
   - Hard to prove reply correlation.

3. Reuse `relayLeadInboxMessages()` as the main Telegram delivery path - 🎯 4   🛡️ 5   🧠 4, approx 600-1400 LOC.
   - Has some capture behavior.
   - Batch semantics are wrong for one Telegram turn.
   - In-memory capture is not enough.

Recommendation:

```text
Use option 1.
Treat existing send paths as adapters, not as the messenger protocol.
```

## 2. Internal Runtime Delivery Also Has An Ambiguous Boundary

Earlier we identified Telegram outbound ambiguity. The same class of bug exists inside the app:

```text
persist send_in_flight
write prompt to live lead stdin
process/app crashes before marking runtime_delivered
```

After restart, the app cannot know whether the lead received the stdin prompt.

So the internal delivery ledger needs:

```ts
type MessengerInternalDeliveryStatus =
  | "accepted_local"
  | "internal_message_persisted"
  | "runtime_send_pending"
  | "runtime_send_in_flight"
  | "runtime_delivered"
  | "runtime_acceptance_unknown"
  | "saved_for_later"
  | "failed_terminal";
```

Policy:

- If the crash happens before runtime boundary, retry is safe.
- If the crash happens after entering `runtime_send_in_flight`, automatic retry is not always safe.
- Use deterministic `internalMessageId` and idempotency instructions, but do not pretend they are a hard exactly-once guarantee.
- For live lead stdin, stale `runtime_send_in_flight` should become `runtime_acceptance_unknown`, not automatic resend.
- For durable inbox file delivery before runtime relay, retry is safer because the inbox row has a deterministic message id.

Top 3 policies:

1. Mark stale live-runtime in-flight as `runtime_acceptance_unknown` and require user/recovery action - 🎯 8   🛡️ 9   🧠 6, approx 900-1800 LOC.
   - Safest.
   - Rare ambiguity can be surfaced in the connector UI.

2. Auto-retry live-runtime in-flight with same `MessageId` and "do not duplicate" prompt - 🎯 6   🛡️ 6   🧠 4, approx 500-1100 LOC.
   - More convenient.
   - Can duplicate lead work or answers.

3. Always write to lead inbox and never send direct stdin - 🎯 7   🛡️ 7   🧠 5, approx 800-1600 LOC.
   - More durable source.
   - Existing lead relay still ultimately crosses stdin and can duplicate after crash if unread is not marked read.

Recommendation:

```text
Use option 1 for live lead delivery.
Use deterministic inbox rows for offline/teammate delivery.
```

## 3. `user_sent` Source Is Probably Correct, But Needs Origin Ledger

Telegram inbound from the app user is still user-originated. If the lead creates a task from that message, `task_create_from_message` should probably work.

Therefore this is a subtle decision:

```text
source: "user_sent"
origin ledger: provider_user / telegram route id / provider message key
```

Do not rely only on a new `source: "messenger_inbound"` because existing task tools accept `user_sent` as user-originated provenance.

Top 3 source/origin options:

1. Store Telegram inbound as `source: "user_sent"` plus durable `MessengerOriginLink` - 🎯 8   🛡️ 8   🧠 5, approx 700-1500 LOC.
   - Preserves task provenance behavior.
   - Projection can skip by origin link, not only source.

2. Add `source: "messenger_inbound"` everywhere - 🎯 7   🛡️ 8   🧠 6, approx 900-2000 LOC.
   - Clearer connector semantics.
   - Breaks or complicates task_create_from_message eligibility unless task tools are updated.

3. Use `source: "inbox"` for all messenger inbound - 🎯 4   🛡️ 5   🧠 3, approx 300-900 LOC.
   - Misrepresents user-originated messages.
   - Weak provenance for lead instructions and task creation.

Recommendation:

```text
Use option 1.
Add connector origin markers outside InboxMessage.source.
```

Suggested origin link:

```ts
type MessengerOriginLink = {
  internalMessageId: string;
  provider: "telegram";
  accountBindingId: string;
  routeId: string;
  routeGeneration: number;
  providerMessageKey: string;
  origin: "provider_user";
  createdAt: string;
};
```

Projection must check this link so user-originated Telegram messages do not echo back to Telegram.

## 4. Lead Reply Capture Needs Single-Turn Semantics

Existing `leadRelayCapture` is useful but not sufficient:

- It is in-memory.
- It captures plain assistant text for a batch of lead inbox messages.
- It has no provider message key.
- It times out after 15 seconds.
- It is designed around inbox relay, not provider route proof.

Messenger needs a single-turn collector:

```ts
type MessengerReplyCollector = {
  begin(input: {
    internalTurnId: string;
    teamIdentityId: string;
    teamName: string;
    routeId: string;
    inboundInternalMessageId: string;
    expectedRecipient: "user";
    startedAt: string;
    timeoutMs: number;
  }): Promise<void>;

  observeInternalMessage(message: InboxMessage): Promise<void>;
  complete(input: { internalTurnId: string; reason: string }): Promise<void>;
};
```

Reply proof order:

```text
1. SendMessage(to="user", relayOfMessageId=<inboundInternalMessageId>)
2. SendMessage(to="user") during active collector window
3. Plain lead text during active collector window, if no SendMessage was captured
4. No reply, task-only action, or tool-only action
```

Top 3 reply capture strategies:

1. Dedicated single-turn collector with explicit `relayOfMessageId` preference and plain-text fallback - 🎯 8   🛡️ 8   🧠 7, approx 1500-3200 LOC.
   - Best UX and correctness balance.
   - Handles lead natural text.
   - Needs careful tests around overlapping turns.

2. Require explicit `SendMessage(to=user, relayOfMessageId=...)` for Telegram replies - 🎯 8   🛡️ 9   🧠 5, approx 900-1800 LOC.
   - Cleaner proof.
   - Lead may fail to use tool, causing "no answer" despite visible plain text.

3. Poll `TeamMessageFeedService` for any new lead message after inbound timestamp - 🎯 5   🛡️ 5   🧠 4, approx 600-1400 LOC.
   - Too heuristic.
   - Can pick unrelated lead thoughts or another user's turn.

Recommendation:

```text
Use option 1.
For retries, ask explicitly for SendMessage with relayOfMessageId.
```

## 5. Overlapping Telegram Turns Need A Per-Team Queue

If two Telegram messages arrive quickly in the same topic, a natural lead reply can be ambiguous.

Top 3 concurrency models:

1. Per-route serial queue for lead-directed Telegram turns - 🎯 8   🛡️ 9   🧠 6, approx 900-1800 LOC.
   - Prevents plain-text reply ambiguity.
   - Simple mental model.
   - May delay bursts.

2. Allow parallel turns but require explicit `relayOfMessageId` for reply correlation - 🎯 7   🛡️ 8   🧠 7, approx 1300-2800 LOC.
   - More throughput.
   - More pressure on lead/tool behavior.

3. Free parallel processing and timestamp heuristics - 🎯 4   🛡️ 4   🧠 4, approx 500-1200 LOC.
   - Will misroute under load.

Recommendation:

```text
Use option 1 for lead-directed turns in MVP.
Teammate replies can be parallel only when each target runtime has explicit delivery ledger support.
```

Queue key:

```text
provider + accountBindingId + routeId + routeGeneration + targetKind
```

For targetKind:

```text
lead
teammate:<memberRouteGeneration>
```

## 6. Projection Must Not Use UI Feed As Authority

`TeamMessageFeedService` is a normalized UI feed. It is useful for rendering, but not authoritative for external delivery.

Reasons:

- It merges different stores.
- It dedupes and prefers one copy.
- It has a 5 second cache.
- It attaches session ids heuristically.
- It computes `feedRevision` from normalized content.
- Renderer filtering hides messages for UI reasons.
- `sentMessages.json` trims to 200 messages.

Projection to Telegram should use:

```text
durable raw sources
ProviderMessageLink
MessengerOriginLink
MessengerProjectionLedger
Team lifecycle/identity registry
```

Projection source adapters:

```ts
type MessengerProjectionSource =
  | { kind: "sent_messages"; teamName: string; message: InboxMessage }
  | { kind: "user_inbox"; teamName: string; message: InboxMessage }
  | { kind: "runtime_delivery"; teamName: string; message: InboxMessage; journalId?: string };
```

Projection eligibility:

```text
project:
  lead/team member message to user
  teammate runtime delivery to user
  explicit SendMessage(to=user)

skip:
  user_sent
  provider-originated MessengerOriginLink
  task_comment_notification
  slash_command_result unless explicitly user-visible
  lead thoughts with no to=user unless captured by active MessengerReplyCollector
  relay duplicates with relayOfMessageId already projected
  cross_team_sent unless the user asked to mirror cross-team flows later
```

## 7. Teammate-To-User Projection Is Real But Needs Better Attribution

The user wanted messages from teammates to show in Telegram too. This is real, but attribution is tricky.

Observed paths:

- Teammate replies can land in `inboxes/user.json`.
- OpenCode runtime delivery can write user-directed messages into `sentMessages.json` with `from: envelope.fromMemberName`, `to: "user"`, `source: "lead_process"`.
- Source alone is not enough to distinguish lead vs teammate.

Projection attribution should use:

```text
message.from
team roster
lead name
runtime delivery journal if present
ProviderMessageLink target
memberRouteGeneration
```

Display prefix policy:

```text
Lead:
  "Lead: <text>"

Teammate:
  "<member display name>: <text>"

Unknown member:
  "Team: <text>"
  attach internal diagnostics only, not visible warning
```

Do not create separate Telegram topics per teammate in MVP. One team topic with author prefix is still the right model.

## 8. Loop Prevention Needs Two Ledgers

One ledger is not enough.

Needed:

```text
MessengerOriginLink:
  provider -> internal message
  prevents echoing provider-originated user messages back to provider

MessengerProjectionLedger:
  internal message -> provider outbox
  prevents sending the same internal reply multiple times
```

Projection ledger shape:

```ts
type MessengerProjectionRecord = {
  projectionId: string;
  internalMessageId: string;
  routeId: string;
  routeGeneration: number;
  provider: "telegram";
  status:
    | "eligible"
    | "skipped"
    | "outbox_enqueued"
    | "sent"
    | "acceptance_unknown"
    | "failed_terminal";
  skipReason?: string;
  providerMessageKey?: string;
  createdAt: string;
  updatedAt: string;
};
```

Critical invariant:

```text
One internal message id can map to at most one provider outbox item per routeGeneration.
```

If the same message appears through live cache and durable file, the projection id must remain the same.

## 9. Attachment And Media Should Be A Later Slice

This is still lower confidence and should not block text MVP.

Top 3 media strategies:

1. Text-first MVP, summarize unsupported attachments with local notice - 🎯 9   🛡️ 8   🧠 3, approx 300-800 LOC.
   - Avoids provider file privacy and download complexity.

2. Telegram inbound file download into local attachment store - 🎯 7   🛡️ 7   🧠 7, approx 1800-3600 LOC.
   - Useful.
   - Needs size limits, retention, malware-safe handling, and privacy copy.

3. Full bidirectional media sync in MVP - 🎯 5   🛡️ 6   🧠 9, approx 3500-7000 LOC.
   - Too much scope.

Recommendation:

```text
Use option 1 for MVP.
Design ports so media can be added later.
```

## 10. Revised Internal Architecture Additions

Add these core/application concepts:

```text
MessengerInternalTurnLedger
MessengerInternalDeliveryPolicy
MessengerRuntimeAcceptancePolicy
MessengerReplyCollector
MessengerProjectionLedger
MessengerProjectionSourceReader
MessengerProjectionPolicy
MessengerLoopPreventionPolicy
MessengerRouteQueue
```

Use existing local patterns:

- OpenCode prompt delivery ledger is the closest reference for delivery state.
- Runtime delivery journal is the closest reference for destination verification.
- `VersionedJsonStore` remains the recommended store mechanism.
- `TeamInboxWriter` is safe as an adapter for inbox persistence.

Do not reuse directly:

- `leadRelayCapture` as the main messenger reply collector.
- renderer `filterTeamMessages()` as projection policy.
- `feedRevision` as outbox cursor.
- `sentMessages.json` as long-term message link storage.

## 11. Current Lowest-Confidence Map

1. Cross-client Telegram topic UX - 🎯 5   🛡️ 8   🧠 6.
   - Still needs live probe.
   - Now isolated by capability proof and fallback.

2. Live lead stdin acceptance ambiguity - 🎯 6   🛡️ 8   🧠 7.
   - Newly elevated risk.
   - Needs `runtime_acceptance_unknown` just like Telegram outbound.

3. Plain lead reply correlation - 🎯 6   🛡️ 8   🧠 7.
   - Existing app supports visible lead text, but provider correlation needs single-turn collector.

4. Projection correctness for teammate-to-user messages - 🎯 7   🛡️ 8   🧠 7.
   - Feasible.
   - Needs durable source reader and attribution policy.

5. Stable team/member identity - 🎯 6   🛡️ 8   🧠 6.
   - Pass 27 recommendation still stands.

6. Outbound Telegram `acceptance_unknown` UX - 🎯 7   🛡️ 9   🧠 6.
   - Technical state is clear.
   - UI wording still needs product work.

## 12. Revised Next Slice

Before UI, implement/test in this order:

1. Internal turn ledger and per-route queue - 🎯 9   🛡️ 9   🧠 7, approx 1800-3600 LOC.
2. Reply collector with explicit `relayOfMessageId` and plain-text fallback - 🎯 8   🛡️ 8   🧠 7, approx 1500-3200 LOC.
3. Projection source reader and projection ledger - 🎯 9   🛡️ 9   🧠 6, approx 1500-3000 LOC.
4. Team/member identity registry from pass 27 - 🎯 9   🛡️ 9   🧠 6, approx 1000-2200 LOC.
5. Telegram topic live probe - 🎯 9   🛡️ 9   🧠 5, approx 700-1500 LOC.

This gives us a feature that can survive crashes and delayed replies before any polished setup wizard exists.
