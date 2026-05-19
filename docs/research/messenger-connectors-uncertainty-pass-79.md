# Messenger Connectors Uncertainty Pass 79

Focus:

```text
Do application use-case names match the canonical record chain and responsibility boundaries?
```

## Finding

After repository naming was aligned, the top use-case list still had broad names:

```text
SyncMessengerConversationsUseCase
ForwardInternalUserVisibleMessageUseCase
DrainProviderOutboxUseCase
```

Those names are understandable from an early product view, but they blur the chain that the docs now depend on:

```text
MessengerConversationEntry
-> ExternalReplyProjectionIntent
-> ProviderOutboxItem
-> ProviderSendAttempt
-> ProviderDeliveryResolution
```

## Canonical Use-Case Family

Use these names in the first implementation slice:

```text
ConnectMessengerUseCase
DisconnectMessengerUseCase
GetMessengerConnectorsSnapshotUseCase
ListMessengerConversationEntriesUseCase
ProvisionRouteEntryPointUseCase
ActivateTeamRouteBindingUseCase
HandleProviderUpdateUseCase
DeliverExternalInboundMessageUseCase
CreateExternalReplyProjectionIntentUseCase
EnqueueProviderOutboxItemUseCase
DrainProviderOutboxItemsUseCase
ResolveProviderDeliveryUseCase
ResolveMessengerManualResolutionTaskUseCase
RepairTeamRouteBindingUseCase
RotateOwnBotTokenUseCase
```

Provider-specific adapters may expose Telegram/Slack setup helpers, but the core use-case names should stay provider
neutral.

## Responsibility Boundaries

Important splits:

```text
ListMessengerConversationEntriesUseCase
  reads local history and UI DTOs, never routes provider messages

CreateExternalReplyProjectionIntentUseCase
  verifies a local visible reply can leave the app, but does not send provider messages

EnqueueProviderOutboxItemUseCase
  creates deterministic provider send work, but does not cross request_started

DrainProviderOutboxItemsUseCase
  leases outbox items and creates ProviderSendAttempt records

ResolveProviderDeliveryUseCase
  turns ProviderSendResult into link, retry schedule, terminal failure, local-only or manual task

ResolveMessengerManualResolutionTaskUseCase
  applies explicit user/support decisions without mutating send history in place
```

## Tests To Add First

1. `ListMessengerConversationEntriesUseCase` cannot enqueue provider outbox work.
2. `CreateExternalReplyProjectionIntentUseCase` requires verified visible local message evidence.
3. `EnqueueProviderOutboxItemUseCase` cannot call `ProviderSendPort`.
4. `DrainProviderOutboxItemsUseCase` creates `ProviderSendAttempt` before provider request start.
5. `ResolveProviderDeliveryUseCase` creates manual task for unknown send state.
6. `ResolveMessengerManualResolutionTaskUseCase` appends a new resolution and leaves attempt history immutable.

## Top 3 Options

1. Record-aligned use-case names now.
   🎯 9   🛡️ 9   🧠 4   Approx `250-700` LOC.
   Recommended. Slightly more names, much clearer responsibility boundaries.

2. Keep broad use-case names and split internally.
   🎯 6   🛡️ 7   🧠 3   Approx `150-400` LOC.
   Feasible, but harder for reviewers to catch send/projection boundary violations.

3. Provider-specific use cases in core.
   🎯 4   🛡️ 5   🧠 3   Approx `200-600` LOC.
   Rejected. It makes Slack and Discord future support a retrofit.

## Verdict

The current docs should treat use cases as orchestration over one domain record transition at a time. This keeps Clean
Architecture, SRP and the future SQLite migration path intact.
