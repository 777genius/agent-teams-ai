# Messenger Connectors Uncertainty Pass 78

Focus:

```text
Do repository and port names match the canonical domain records and logical tables?
```

## Finding

The domain and store vocabulary is now mostly consistent, but the first-slice port list still had older broad names:

```text
MessengerConversationRepository
ProviderOutboxRepository
MessengerManualResolutionRepository
ProcessedUpdateRepository
```

Those names are close, but they hide the actual record ownership. The canonical chain is more explicit:

```text
ProcessedProviderUpdate
MessengerConversationEntry
ProviderOutboxItem
MessengerManualResolutionTask
```

## Canonical Repository Family

Use these first-slice repositories behind `MessengerStateStorePort` and `MessengerUnitOfWork`:

```text
ProcessedProviderUpdateRepository
RouteEntryPointRepository
RouteProvisioningAttemptRepository
RouteActivationProofRepository
TeamRouteBindingRepository
ProviderControlPlaneDecisionRepository
MessengerRouteDecisionRepository
MessengerConversationEntryRepository
ExternalMessageLinkRepository
MessengerRuntimeTurnLedgerRepository
LocalProjectionEffectRepository
ProviderOutboxItemRepository
ProviderSendAttemptRepository
ProviderDeliveryResolutionRepository
MessengerManualResolutionTaskRepository
```

These repositories are not separate transaction owners. They are logical table gateways inside one unit-of-work boundary.

## Why This Matters

Broad names encourage mixed responsibilities:

- `MessengerConversationRepository` can drift into route lookup, reply proof or UI feed projection.
- `ProviderOutboxRepository` can mix send intent, request attempt and delivery outcome.
- `MessengerManualResolutionRepository` can mix the task with delivery resolution history.
- `ProcessedUpdateRepository` can lose the provider-specific idempotency context.

The first implementation slice should make illegal states harder to express by naming the table and record exactly.

## Inbound Flow Alignment

The unified-bot inbound flow should persist state in this order:

```text
ProcessedProviderUpdateRepository
-> TeamRouteBindingRepository
-> ExternalMessageLinkRepository reply lookup
-> MessengerRouteDecisionRepository
-> MessengerConversationEntryRepository
-> ExternalMessageLinkRepository current-message link
-> MessengerRuntimeTurnLedgerRepository
-> TeamMessagingPort
```

Provider outbound work should start only from explicit projection/status ownership:

```text
ExternalReplyProjectionIntent or status/control response
-> ProviderOutboxItemRepository
-> ProviderSendAttemptRepository
-> ProviderSendPort
-> ProviderDeliveryResolutionRepository
```

## Tests To Add First

1. `ProcessedProviderUpdateRepository` dedupes before route decision.
2. `MessengerConversationEntryRepository` cannot create provider send work.
3. `ProviderOutboxItemRepository` cannot mark provider request started.
4. `ProviderSendAttemptRepository` owns `request_started`.
5. `ProviderDeliveryResolutionRepository` owns manual/terminal/retry outcome.
6. `MessengerManualResolutionTaskRepository` appends tasks without mutating send attempts.

## Top 3 Options

1. Explicit repository per canonical record/table.
   🎯 9   🛡️ 9   🧠 5   Approx `500-1200` LOC.
   Recommended. More interfaces, but clean ownership and easier migration tests.

2. One generic `MessengerStateRepository` plus typed methods.
   🎯 7   🛡️ 7   🧠 3   Approx `250-700` LOC.
   Less boilerplate, but easier to blur responsibilities inside one large adapter.

3. Keep broad repositories and rely on comments.
   🎯 5   🛡️ 5   🧠 2   Approx `50-200` LOC.
   Rejected. The docs already show enough state machines that naming should carry the boundary.

## Verdict

Keep `MessengerStateStorePort` and `MessengerUnitOfWork` as the transaction boundary, but expose narrow repositories that
match domain record names. This is the cleanest path for SOLID and future SQLite migration.
