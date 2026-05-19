# Messenger Connectors Uncertainty Pass 81

Focus:

Are the current use-case and port names internally coherent, or do historical names still compete with the canonical architecture?

Finding:

The provider side had been split into small ports, but the local Agent Teams side still had a broad `TeamMessagingPort` in current sections. Older research also still used names like `DeliverInboundToTeamUseCase`, `InjectInboundToLeadUseCase`, `TeamVisibleMessagePort`, `MessengerRelayPort` and `MessengerSecretStorePort`. Those names are acceptable as historical notes, but not as competing implementation targets.

Current use-case name map:

```text
LinkUnifiedTelegramBotUseCase, LinkOwnTelegramBotUseCase
  -> ConnectMessengerUseCase with connection mode
AcceptRelayOfferUseCase, AcceptDesktopRelayOfferUseCase
  -> MessengerRelayTransportPort input adapter + HandleProviderUpdateUseCase
DeliverInboundToTeamUseCase, InjectInboundToLeadUseCase
  -> DeliverExternalInboundMessageUseCase + TeamRuntimeDeliveryPort
HandleProviderCallbackUseCase
  -> HandleProviderUpdateUseCase + ProviderInteractionPort + ProviderControlPlaneClassifier
RepairMessengerRouteUseCase
  -> RepairTeamRouteBindingUseCase
```

Current team-side ports:

```text
TeamDirectoryPort
TeamRuntimeDeliveryPort
TeamConversationProjectionPort
TeamRuntimeEventPort
TeamLifecyclePort
```

Responsibilities:

- `TeamDirectoryPort` resolves stable team/member identity, display labels, roles and current existence.
- `TeamRuntimeDeliveryPort` injects one external inbound turn into the lead or teammate runtime and returns local delivery evidence.
- `TeamConversationProjectionPort` writes, verifies and reads app-visible local message projections needed for messenger conversation history and reply proof.
- `TeamRuntimeEventPort` observes lead/teammate outbound messages, turn results and cleanup events after local persistence decisions.
- `TeamLifecyclePort` receives team/member rename, delete, restore and tombstone events so route bindings can be repaired or archived.

Boundary rules:

- No use case should depend on a broad `TeamMessagingPort`.
- Provider adapters never call team services directly.
- `TeamRuntimeDeliveryPort` cannot create provider outbox items.
- `TeamConversationProjectionPort` cannot decide provider routing.
- `TeamRuntimeEventPort` cannot infer provider reply target by newest visible message.
- `TeamLifecyclePort` can tombstone or repair route bindings, but cannot silently reroute an old provider topic to a new team identity.

Top 3 implementation options:

1. Split team-side ports now - 🎯 9   🛡️ 9   🧠 6, about `700-1600` LOC.
   - Recommended.
   - Matches provider small-port design and keeps `TeamProvisioningService` behind adapters.
2. Keep `TeamMessagingPort` as a facade but expose only small subinterfaces to use cases - 🎯 7   🛡️ 7   🧠 4, about `400-900` LOC.
   - Acceptable short-term.
   - Easy to accidentally grow into a god interface.
3. Let messenger use cases call `TeamProvisioningService`, `TeamMessageFeedService` and team stores directly - 🎯 4   🛡️ 4   🧠 3, about `300-700` LOC.
   - Fastest demo path.
   - Violates the feature architecture standard and makes provider scaling fragile.

Verdict:

Use small team-side anti-corruption ports. Treat `TeamMessagingPort` as superseded shorthand in older research notes, not as a current core dependency.
