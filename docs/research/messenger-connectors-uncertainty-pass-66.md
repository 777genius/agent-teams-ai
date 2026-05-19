# Messenger Connectors Uncertainty Pass 66

Date: 2026-05-01
Focus: organic structure and cross-concept coherence audit.

## Question

Does the documentation now read as one coherent architecture, not as disconnected research fragments?

## Structural Findings

The main architecture is coherent, but three vocabulary edges made it harder to read:

1. `ProviderConversationRouteBinding`, `ConversationBinding`, `RouteBinding` and `RouteEntryPoint` were mixed in different sections.
2. Store wording had both "canonical store" and "partitioned JSON" without enough explanation of how those fit together.
3. The docs explained individual abstractions, but did not show the full responsibility chain from provider UI surface to provider outbox.

## Corrections Made

1. Canonical vocabulary now uses:

```text
ExternalConversationKey
ProviderSubrouteKey
ProviderRouteAddress
ExternalRouteEntryPoint
TeamRouteBinding
ExternalMessageLink
```

2. Historical route-binding names are now collapsed into current meaning:

```text
ExternalRouteEntryPoint = provider-visible route root
TeamRouteBinding = route-to-Agent-Team binding
```

3. The store story is now:

```text
MessengerStateStorePort + MessengerUnitOfWork = canonical transactional boundary
partitioned JSON files = MVP physical table files
SQLite = later storage adapter behind the same boundary
```

4. Store names now use `team-route-bindings.json` and `teamRouteBindings` to match `TeamRouteBinding`.

5. Top architecture outbox names now use `ProviderOutboxItem`, `ProviderOutboxRepository` and `DrainProviderOutboxUseCase`.

6. Added a coherence map to the living summary and architecture:

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

## Organic Architecture Check

Product to provider:

- Official Telegram bot is default.
- Telegram topics are preferred but gated.
- Slack later uses the same route-entrypoint abstraction with root messages/threads.
- WhatsApp can use the same core with selector state and no subroute.

Provider to local app:

- Provider surface creates entrypoints.
- Entrypoints produce route addresses.
- TeamRouteBinding maps route addresses to Agent Teams teams.
- ExternalMessageLink maps provider messages to exact internal reply targets.

Local app to runtime:

- MessengerRuntimeTurnLedger gates lead/team delivery.
- LeadTurnGate prevents interleaving.
- Existing team stores are side-effect destinations, not canonical provider state.

Runtime to provider:

- Runtime output becomes provider-sendable only through `ExternalReplyProjectionIntent`.
- ProviderOutbox owns send attempts and ambiguous outcomes.
- ExternalMessageLink stores sent provider message ids for future replies.

## Remaining Intentional Historical Differences

These are acceptable because the summary/top architecture explicitly override historical passes:

- older "one topic per team" shorthand;
- older SQLite options;
- older ACK/offline alternatives;
- old names like route binding or conversation binding in rejected or historical sections.

## Decision

The docs are now coherent enough for implementation if the first code slice creates the domain contracts using the canonical vocabulary above.

## Confidence

1. Keep docs as living summary plus historical research passes.
   🎯 9   🛡️ 9   🧠 4   Approx 300-800 LOC documentation cleanup.
   Recommended.

2. Split historical research into an archive and keep only canonical docs in the main tree.
   🎯 7   🛡️ 8   🧠 6   Approx 1200-3000 LOC.
   Useful later, but not necessary before implementation.

3. Rewrite the entire architecture doc from scratch.
   🎯 5   🛡️ 7   🧠 9   Approx 10000-25000 LOC.
   Not recommended now.
