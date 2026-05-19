# Messenger Connectors - Uncertainty Pass 51

Date: 2026-04-30
Scope: weakest remaining chain after topic routing: `Telegram topic -> team -> lead/teammate route -> durable local message -> agent reply -> Telegram reply`

## Question

How do we avoid the worst class of bug: sending the wrong local text to Telegram, or sending a correct text to the wrong Telegram conversation?

The risky chain is:

```text
external inbound
-> local runtime turn
-> lead stdin
-> observed visible reply
-> local verified message
-> provider outbox
-> Telegram sendMessage
```

The core finding in this pass:

```text
Provider outbox MUST be created only from a feature-owned ExternalReplyProjectionIntent with exact proof.
Plain assistant text is not a provider-send source in MVP.
```

## Fresh Source Check

Official Telegram facts checked again:

- Managed Bots are not a private token flow. Telegram docs say the manager bot can use `getManagedBotToken` to fetch the new bot access token.
- `sendMessage` supports `message_thread_id` for forum supergroups and private chats of bots with forum topic mode enabled.
- `sendMessage` returns the sent `Message`, so the provider adapter must persist provider message ids after send success.

Official Claude Code fact checked again:

- `--output-format stream-json` is a supported structured streaming mode, and each line is a JSON event.

Sources:

- https://core.telegram.org/bots/features#managed-bots
- https://core.telegram.org/bots/api#sendmessage
- https://core.telegram.org/bots/api#getmanagedbottoken
- https://code.claude.com/docs/en/headless

## Local Evidence

Local code confirms three concrete gaps that matter before Telegram auto-reply:

1. `TeamDataService.sendMessage()` accepts `relayOfMessageId` through `SendMessageRequest`, but does not pass it into `controller.messages.sendMessage()`.
2. Lead prompts now demand native `SendMessage` fields `to`, `summary`, `message`, while the capture code still reads native `SendMessage` as `recipient`, `content`, `summary`.
3. Native `SendMessage(to="user")` currently persists to `sentMessages.json` without `relayOfMessageId`. Non-user messages can consume pending inbox relay candidates, but user-directed messages do not.

Relevant local paths:

- `src/main/services/team/TeamDataService.ts`
- `src/main/services/team/TeamProvisioningService.ts`
- `src/main/services/team/TeamSentMessagesStore.ts`
- `src/main/services/team/TeamInboxWriter.ts`
- `src/shared/types/team.ts`

## Stronger Reply Projection Contract

Add a feature-owned concept:

```ts
type ExternalReplyProofKind =
  | 'exact_relay_of_message_id'
  | 'explicit_provider_message_link'
  | 'native_sendmessage_sidecar_exact_turn'
  | 'manual_user_approved';
```

The projection object should be explicit:

```text
ExternalReplyProjectionIntent
  intentId
  accountBindingId
  routeId
  teamId
  localInboundMessageId
  providerInboundMessageKey
  candidateLocalMessageId
  candidateTextHash
  proofKind
  proofPayload
  state
```

State machine:

```text
candidate_observed
-> local_visible_message_verified
-> provider_outbox_queued

candidate_observed
-> manual_review_required

candidate_observed
-> rejected_no_exact_proof
```

Important rule:

```text
The provider outbox worker never reads TeamMessageFeedService or "latest sent message".
It reads only verified ExternalReplyProjectionIntent rows.
```

## Allowed Auto-Send Candidates

MVP can auto-send only when one of these is true:

1. `message_send(to=user)` produced a visible local message whose `relayOfMessageId` equals the active turn local inbound id.
2. A native `SendMessage` candidate is normalized and bound by sidecar to exactly one active messenger turn, and the connector attaches the exact `relayOfMessageId` before local persistence.
3. A teammate-to-user inbox row has exact `relayOfMessageId` or an explicit provider message link.
4. A human approved the unresolved candidate in manual review.

Everything else is local UI only or manual review.

## Forbidden Auto-Send Candidates

Do not auto-send these in MVP:

- plain assistant text
- `lead_process` rows without exact proof
- feed-inferred `relayOfMessageId`
- newest message in `TeamMessageFeedService`
- timestamp proximity
- text similarity
- `message_send` without relay/link proof
- native `SendMessage(to=user)` without connector sidecar proof
- route-only or team-only matching

If an assistant event has both narration and an explicit SendMessage, project only the explicit SendMessage. Narration must not leak to Telegram.

## Native SendMessage Normalizer

The local native capture boundary needs one normalizer shared by:

- `hasCapturedVisibleSendMessage`
- `captureSendMessages`
- future messenger visible-reply observer

Normalizer rule:

```text
to = input.to ?? input.recipient
message = input.message ?? input.content
summary = input.summary
```

Conflict rule:

```text
If canonical and legacy fields both exist and disagree, reject provider auto-send and require manual review.
```

This is important because the prompt layer and capture layer currently disagree on field names.

## Local Verification Before Provider Outbox

Provider outbox should be queued only after this local sequence:

```text
candidate observed
-> deterministic local outbound message id chosen
-> canonical MessengerStateStore reply row written
-> side-effect row written to sentMessages/inbox projection
-> side-effect row read back by deterministic id
-> ExternalReplyProjectionIntent marked local_visible_message_verified
-> provider outbox item created
```

If the side-effect write fails or read-back fails:

```text
manual_review_required or repair_required
```

Do not let `persistSentMessage` log-and-swallow behavior become provider-delivery proof.

## LeadTurnGate Requirement

Without a shared gate, `replay_user_message_observed` proves only that the prompt entered the runtime. It does not prove that a later visible reply belongs to this external turn.

All lead stdin write sources must use one shared per-team gate:

```text
ui_user
external_messenger
post_compact_reminder
gemini_hydration
legacy_inbox_relay
system_recovery
```

Top 3 gate options:

1. Shared FIFO `LeadTurnGate` around all lead stdin writes.
   🎯 9   🛡️ 9   🧠 8   Approx 1500-3000 LOC
   Recommended. It is the only option that makes reply ownership defensible.

2. Messenger-only gate plus collision detector.
   🎯 5   🛡️ 5   🧠 4   Approx 500-1200 LOC
   Useful as a temporary spike, but unsafe for production because UI sends and system reminders can still interleave.

3. No gate, rely on prompt markers and timing.
   🎯 3   🛡️ 4   🧠 3   Approx 200-600 LOC
   Rejected for Telegram auto-send. It can only support manual review.

## Top 3 Reply Projection Options

1. Exact proof intent only.
   🎯 9   🛡️ 10   🧠 7   Approx 1800-3600 LOC
   Auto-send requires `ExternalReplyProjectionIntent` with exact relay id, explicit provider link, sidecar exact turn, or manual approval.

2. Single-active-turn visible text fallback.
   🎯 6   🛡️ 6   🧠 4   Approx 700-1600 LOC
   Convenient, but still leak-prone. Keep as local-only/manual-review, not provider auto-send.

3. Feed/time/text matching.
   🎯 2   🛡️ 2   🧠 2   Approx 300-900 LOC
   Rejected. It is not a reliable external messaging contract.

## Teammate-To-User Projection

User wanted teammate messages visible in Telegram too. This is real and useful, but it needs the same proof model.

Allowed:

```text
teammate -> user row with relayOfMessageId matching external inbound
teammate -> user row with explicit ProviderMessageLink
manual user-approved teammate candidate
```

Display rule in one team topic:

```text
@teammate-name: message text
```

Do not create a separate Telegram bot per teammate or per command. It creates token sprawl, worse UX, and does not solve reply routing. One topic per team plus route-linked reply targeting is simpler and safer.

## Edge Cases

Duplicate explicit replies:

```text
same proof + same text hash + same local target id -> dedupe
same proof + different text -> manual_review_required
```

Assistant sends explicit reply and then plain text:

```text
explicit reply wins
plain text is local-only
```

Assistant sends plain text only:

```text
manual_review_required or local-only
```

Native SendMessage field conflict:

```text
input.to != input.recipient or input.message != input.content
-> manual_review_required
```

Local projection exists but provider outbox missing:

```text
read back local row
verify proof
enqueue outbox once
```

Provider send starts but result is unknown:

```text
provider_send_unknown
do not blind retry
show repair/manual status
```

Telegram send succeeds but provider result cache persist fails:

```text
send_unknown
do not blind retry
```

Topic route is tombstoned during active turn:

```text
keep local reply
do not send provider outbox
mark route_repair_required
```

Desktop goes offline after local reply before provider send:

```text
official shared bot mode: outbox remains local pending until relay returns
own-bot mode: local poller/send worker resumes when desktop returns
```

## Required Tests

- `TeamDataService.sendMessage()` passes `relayOfMessageId`.
- Native normalizer accepts canonical `to/message`.
- Native normalizer accepts legacy `recipient/content`.
- Native normalizer rejects conflicting canonical and legacy fields.
- `hasCapturedVisibleSendMessage()` and `captureSendMessages()` use the same normalizer.
- Assistant text plus explicit SendMessage projects only explicit SendMessage.
- Plain assistant text during active messenger turn does not create provider outbox.
- `message_send` without relay/link proof does not auto-send.
- `message_send` with exact relay id creates projection intent.
- Native `SendMessage(to=user)` without sidecar does not auto-send.
- Native `SendMessage(to=user)` with exact sidecar creates projection intent.
- Teammate-to-user row with exact relay id creates projection intent.
- `TeamMessageFeedService` inferred relay never creates provider outbox.
- Local visible message read-back must happen before provider outbox enqueue.
- Shared `LeadTurnGate` serializes UI send, external messenger, reminder, hydration, and legacy relay.

## Updated Confidence

Highest confidence:

```text
Provider auto-send must be proof-based.
Plain assistant text must not auto-send in MVP.
TeamMessageFeedService cannot be provider-routing truth.
```

Lower confidence until fixture work:

```text
Exact native SendMessage stream-json shape.
Exact sidecar design for native SendMessage auto-send.
Exact LeadTurnGate migration order inside the large TeamProvisioningService.
```

## Implementation Recommendation

Do the reply safety work before the Telegram adapter sends real messages:

1. Fix `relayOfMessageId` pass-through.
2. Add native `SendMessage` normalizer.
3. Add `ExternalReplyProjectionIntent`.
4. Add local projection write/read-back verifier.
5. Add exact-proof-only provider outbox creation.
6. Add shared `LeadTurnGate`.
7. Add Telegram provider send after proofed outbox is stable.

This adds code, but it prevents the feature from depending on timing, UI feed order, or model narration shape.
