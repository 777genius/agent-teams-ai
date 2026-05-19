# Messenger Connectors Uncertainty Pass 69

Date: 2026-05-01
Focus: conversation rows vs proof rows vs provider outbox

## Question

Does the documentation make it clear how a provider message becomes local history, runtime work, reply proof and then a provider send?

## Finding

The top architecture was mostly coherent, but the canonical flow still used vague phrases like "conversation inbound row" and "conversation outbound row". That was readable, but not implementation-grade.

The fix is to name the row:

```text
MessengerConversationEntry
```

This is a feature-owned local user-visible message row attached to a provider-neutral route. It can contain plaintext locally, sender identity, route context, display metadata and internal message ids.

It is not proof for provider auto-send by itself.

## Correct Relationship

```text
ProcessedProviderUpdate
  -> ProviderReplyReference
  -> ExternalReplyTargetResolution
  -> MessengerRouteDecision
  -> MessengerConversationEntry inbound
  -> ExternalMessageLink inbound
  -> MessengerRuntimeTurnLedger
  -> TeamMessagingPort delivery
  -> MessengerConversationEntry outbound
  -> ExternalReplyProjectionIntent
  -> ProviderOutboxItem
  -> ExternalMessageLink outbound
```

Meaning:

- `ProcessedProviderUpdate` dedupes provider ingress.
- `ProviderReplyReference` is the optional provider pointer from the current inbound message to an older provider message.
- `ExternalReplyTargetResolution` resolves that pointer through the existing link table before target selection.
- `MessengerRouteDecision` persists the final delivery/control outcome before runtime delivery.
- `MessengerConversationEntry inbound` is local history/runtime context.
- `ExternalMessageLink inbound` maps provider source message to the internal inbound entry and route target.
- `MessengerRuntimeTurnLedger` owns whether local lead/team runtime accepted the external turn.
- `MessengerConversationEntry outbound` is the local visible reply row after read-back verification.
- `ExternalReplyProjectionIntent` is the proof-backed decision that the outbound row is allowed to leave the app.
- `ProviderOutboxItem` owns send attempt state and ambiguity.
- `ExternalMessageLink outbound` stores returned provider message ids for future reply-to routing.

## Boundary Rule

Inbound provider-originated entries must never become provider outbox candidates.

Outbound entries become provider-send candidates only after read-back verification plus explicit proof policy creates `ExternalReplyProjectionIntent`.

This prevents a common bug:

```text
provider message arrives
-> app stores local row
-> generic conversation sync sees a new row
-> provider outbox sends it back to Telegram
```

The docs now make that impossible by contract:

```text
conversation entry != projection intent
projection intent != provider outbox result
provider outbox result != local runtime ownership
```

## Repository Boundary

Add a logical repository:

```text
MessengerConversationRepository
```

It lives behind:

```text
MessengerStateStorePort
MessengerUnitOfWork
```

It should not write directly to existing inbox/sent files. Existing inbox/sent files are side-effect destinations and UI inputs, not provider-routing truth.

## Implementation Consequence

First slice should include tests that prove:

1. inbound `MessengerConversationEntry` never creates `ProviderOutboxItem`;
2. outbound `MessengerConversationEntry` without `ExternalReplyProjectionIntent` never creates `ProviderOutboxItem`;
3. outbound `MessengerConversationEntry` with a valid projection intent creates exactly one deterministic provider outbox item;
4. provider send success creates outbound `ExternalMessageLink`;
5. provider send ambiguity does not mutate runtime turn ownership.

## Top 3 Options

1. Explicit `MessengerConversationEntry` plus projection intent gate.
   🎯 9   🛡️ 9   🧠 6   Approx `700-1400` LOC.
   Recommended. Clear SRP: history, proof, runtime and provider send are separate.

2. Reuse existing inbox/sent rows as connector truth.
   🎯 4   🛡️ 5   🧠 3   Approx `300-800` LOC.
   Too fragile because current UI stores are capped, inferred and not built as provider-routing ledgers.

3. Skip conversation entries and store only links/ledgers/outbox.
   🎯 6   🛡️ 7   🧠 5   Approx `500-1000` LOC.
   Cleaner for backend-style routing, but weak UX/history and harder manual review.

## Verdict

The docs are more organic with `MessengerConversationEntry` as a named local row. It bridges UI-visible history to runtime/proof/outbox without letting UI rows become provider delivery truth.
