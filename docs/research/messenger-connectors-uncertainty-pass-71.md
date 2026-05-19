# Messenger Connectors Uncertainty Pass 71

Date: 2026-05-01
Focus: durable route decision vs reply target resolution vs control plane

## Question

Is the documentation clear that reply target resolution is not the final route decision, and that repair/setup/control commands are not normal runtime messages?

## Finding

Mostly, but the top canonical flow still treated `TargetSelectionPolicy route decision` as a step rather than a durable model. The architecture already mentioned `MessengerRouteDecision`, but it was not part of the coherence chain, implementation bridge or canonical flow.

That creates a subtle retry bug:

```text
provider update handled once
-> route target computed
-> app crashes before runtime delivery
-> retry recomputes route from newer state
-> message may go to a different target
```

## Correct Split

```text
ProviderControlPlaneDecision
  consumes setup/repair/status/callback updates before runtime delivery

ExternalReplyTargetResolution
  resolves old-message reply proof

TargetSelectionPolicy
  combines team binding, control-plane state, route health and reply target resolution

MessengerRouteDecision
  persists the final route/control outcome and reason snapshot
```

## Correct Normal Delivery Flow

```text
Provider update
-> ProcessedProviderUpdate
-> ProviderControlPlaneClassifier
-> ProviderControlPlaneDecision not consumed
-> ExternalRouteEntryPoint lookup
-> TeamRouteBinding lookup
-> ProviderReplyReference extraction
-> ExternalReplyTargetResolution
-> TargetSelectionPolicy
-> MessengerRouteDecision persisted
-> MessengerConversationEntry inbound
-> ExternalMessageLink save for current provider message
-> MessengerRuntimeTurnLedger
```

## Correct Consumed Control-Plane Flow

```text
Provider update
-> ProcessedProviderUpdate
-> ProviderControlPlaneClassifier
-> ProviderControlPlaneDecision consumed
-> durable control-plane effect/status
-> no MessengerRuntimeTurnLedger
-> no ExternalReplyProjectionIntent
-> no ProviderOutboxItem or ProviderSendAttempt except explicit status/repair response
```

Examples of consumed control-plane updates:

- `/sent <code>` repair command;
- setup command;
- `/teams` selector command;
- callback/probe confirmation;
- pause/resume command;
- invalid signed repair command that must be consumed and not sent to lead/team.

## MessengerRouteDecision Contents

`MessengerRouteDecision` should include:

- provider update key;
- route id and route generation;
- team identity id if applicable;
- target kind: lead, teammate, user, setup, repair, ambiguous, rejected, consumed;
- teammate id if applicable;
- control-plane decision id if applicable;
- reply target resolution id or summary;
- decision reason code;
- createdAt;
- policy version.

Reason codes should be stable enough for tests:

```text
normal_team_message_to_lead
explicit_reply_to_lead
explicit_reply_to_teammate
control_plane_consumed
missing_reply_link_ambiguous
tombstoned_route
unknown_route_setup
sender_not_allowed
route_suspended
provider_unsupported
```

## Rule

One provider update gets one durable route/control decision.

Retries reuse it. They do not recompute from current renderer state, newest feed row, topic title, Slack thread title or current team list.

Explicit repair may supersede a route decision, but it must write a new audited decision or repair record.

## Tests To Add First

1. Control-plane repair command is consumed and never delivered to lead/team.
2. Normal team message gets one persisted `MessengerRouteDecision`.
3. Retry after crash reuses stored decision.
4. Team rename after decision does not change target.
5. Team deletion/tombstone blocks runtime delivery but does not silently reroute.
6. Missing reply link produces ambiguous decision, not lead, when message is an explicit provider reply.
7. Slack top-level app-DM text becomes selector/control-plane, not newest-team delivery.

## Top 3 Options

1. First-class `ProviderControlPlaneDecision` and `MessengerRouteDecision`.
   🎯 9   🛡️ 10   🧠 6   Approx `700-1500` LOC.
   Recommended. It makes retry/recovery deterministic and keeps control-plane out of runtime delivery.

2. Store route reason inside `MessengerConversationEntry` only.
   🎯 6   🛡️ 7   🧠 4   Approx `300-800` LOC.
   Simpler, but mixes display history with routing proof.

3. Recompute route on every retry.
   🎯 3   🛡️ 3   🧠 2   Approx `100-300` LOC.
   Rejected. It creates wrong-target risk after rename, repair, teammate removal or route tombstone.

## Verdict

The docs are now more organic because the inbound chain has a clear decision layer:

```text
control-plane classification
-> reply target resolution
-> target selection
-> durable route/control decision
-> local runtime delivery
```

Implementation should create and test this layer before Telegram adapter E2E.
