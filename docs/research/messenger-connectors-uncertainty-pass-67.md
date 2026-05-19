# Messenger Connectors Uncertainty Pass 67

Date: 2026-05-01
Focus: final organic dependency review and implementation bridge.

## Question

Is the documentation interconnected enough that a developer can start implementation without re-inventing the architecture?

## Result

The docs now have a coherent dependency chain:

```text
ProviderSurfaceModel
  -> ExternalRouteEntryPoint
  -> ProviderRouteAddress
  -> TeamRouteBinding
  -> ExternalMessageLink
  -> MessengerRuntimeTurnLedger
  -> ExternalReplyProjectionIntent
  -> ProviderOutbox
```

The only missing piece was a direct bridge from that chain to the first code slice. Added that bridge to the living summary and architecture plan.

## Added Implementation Bridge

First implementation should create things in this order:

1. Domain identity models.
   `ProviderSurfaceModel`, `ExternalConversationKey`, `ProviderSubrouteKey`, `ProviderRouteAddress`, `ExternalRouteEntryPoint`, `TeamRouteBinding`, `ExternalMessageKey`, `ExternalMessageLink`.

2. Domain state models.
   `ProcessedProviderUpdate`, `MessengerRuntimeTurnLedger`, `ExternalReplyProjectionIntent`, `ProviderOutboxItem`.

3. Domain policies.
   `TargetSelectionPolicy`, provider capabilities policy, ingress ACK policy, provider outbox state machine, repair/tombstone policy, plaintext boundary policy.

4. Application ports.
   `MessengerStateStorePort`, `MessengerUnitOfWork`, `RouteEntryPointRepository`, `TeamRouteBindingRepository`, `ExternalMessageLinkRepository`, `ProviderOutboxRepository`, `TeamMessagingPort`, provider adapter small ports.

5. Adapters.
   File-backed store, local HTTP input adapter, TeamMessaging adapter, Telegram adapter, relay adapter, renderer DTO adapter.

## Organic Fit Check

Product:

- Official Telegram bot default.
- Private topics preferred but gated.
- Own bot is privacy-clean optional mode.
- Slack later maps through route entrypoints, not Telegram nouns.

Domain:

- Entry point and route binding are separate.
- Message link and route binding are separate.
- Runtime turn and provider outbox are separate.
- Provider capability and formatting stay outside routing policy.

Ports:

- No provider god-port.
- Provider adapters are bundles of small ports.
- Local HTTP, MCP runtime tools and cloud relay have distinct boundaries.

Storage:

- Canonical boundary is `MessengerStateStorePort` plus `MessengerUnitOfWork`.
- Partitioned JSON is MVP physical storage.
- SQLite remains a storage adapter option, not a core design change.

## Decision

Docs are now organically connected enough for first implementation. The next productive step is code, starting with contracts/domain and tests for the canonical chain.

## Confidence

1. Start implementation from the added bridge.
   🎯 9   🛡️ 9   🧠 5   Approx 2500-4500 LOC for the first contracts/domain/store-policy slice.
   Recommended.

2. Spend another pass only on docs.
   🎯 6   🛡️ 7   🧠 3   Approx 200-800 LOC.
   Useful only if a new concrete ambiguity appears.

3. Rewrite docs into a shorter RFC before coding.
   🎯 7   🛡️ 8   🧠 7   Approx 1500-3500 LOC.
   Nice later, but not required before first slice.
