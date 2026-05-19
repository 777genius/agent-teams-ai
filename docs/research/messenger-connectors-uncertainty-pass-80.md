# Messenger Connectors Uncertainty Pass 80

Focus:

Does provider adapter port naming match the current use cases without creating a hidden `ProviderBotApiPort` god interface?

Finding:

The current use-case chain requires two explicit provider-side capabilities that were still implicit in one bridge section: route entrypoint provisioning and provider sends. The top ports list already had explicit names, but the earlier bridge still said "provider adapter small ports", while a lower SOLID section still had traces of broader adapter naming. That made the docs less coherent than the intended implementation.

Corrected boundary:

```text
Use cases
-> smallest needed provider-neutral port
-> provider adapter bundle assembled in main/composition
-> provider SDK or HTTP API
```

Canonical provider-facing ports:

```text
ProviderSurfacePort
ProviderRouteProvisioningPort
ProviderSendPort
ProviderIngressAckPolicyPort
ProviderInteractionPort
ProviderFormattingPort
ProviderRateLimitPort
ProviderPermalinkPort
ProviderNavigationPort
ProviderHistoryBackfillPort
MessengerRelayTransportPort
```

Non-port core policies:

```text
ProviderControlPlaneClassifier
RouteContainerSelectionPolicy
RouteActivationPolicy
ReplyTargetResolutionPolicy
TargetSelectionPolicy
ProviderOutboxItem state machine
ProviderDeliveryResolution policy
```

Boundary rules:

- `ProviderRouteProvisioningPort` may create or probe provider route roots and selector state, but it cannot activate `TeamRouteBinding`.
- `ProviderSendPort` sends an already leased provider request and returns `ProviderSendResult` evidence, but it cannot create `ProviderOutboxItem`, own retries or skip the `request_started` send-attempt boundary.
- `ProviderIngressAckPolicyPort` decides provider ACK behavior, but it cannot route messages to the team runtime.
- `ProviderControlPlaneClassifier` is a pure core policy over normalized inbound data, not a provider adapter port.
- `MessengerRelayTransportPort` handles official-bot relay transport, not provider SDK calls.
- `TeamMessagingPort` bridges local Agent Teams runtime/history, not provider transport.
- Provider SDK payloads, Slack Block Kit JSON, Telegram ids, Discord bucket state and WhatsApp template ids stay in adapters/infrastructure.

Route-send chain after this pass:

```text
ProvisionRouteEntryPointUseCase
-> ProviderRouteProvisioningPort
-> RouteActivationPolicy
-> TeamRouteBinding active routeGeneration

CreateExternalReplyProjectionIntentUseCase
-> EnqueueProviderOutboxItemUseCase
-> DrainProviderOutboxItemsUseCase
-> ProviderSendAttempt request_started
-> ProviderSendPort
-> ResolveProviderDeliveryUseCase
```

Required tests:

1. Route provisioning success cannot activate `TeamRouteBinding` without `RouteActivationProof`.
2. `ProviderSendPort` cannot create an outbox item or decide retry policy.
3. Every provider send attempt persists `request_started` before the port call.
4. Ingress ACK policy cannot deliver to runtime or create route decisions.
5. Relay transport cannot persist plaintext queue in MVP official-bot mode.
6. Provider adapters expose normalized DTOs only.

Top 3 implementation options:

1. Explicit small provider ports now - 🎯 9   🛡️ 9   🧠 5, about `500-1200` LOC.
   - Recommended.
   - Best match for SOLID ISP/DIP and future Slack/Discord/WhatsApp adapters.
2. One `ProviderBotApiPort` with many methods - 🎯 6   🛡️ 6   🧠 3, about `300-800` LOC.
   - Faster initially.
   - Tends to become a provider-specific god interface.
3. Provider-specific core use cases - 🎯 4   🛡️ 5   🧠 3, about `500-1200` LOC.
   - Easy Telegram MVP.
   - Forces core rewrite when Slack or WhatsApp arrives.

Verdict:

Use explicit provider-neutral small ports. Keep provider control-plane classification as a pure core policy over normalized inbound data. Do not introduce `ProviderBotApiPort`.
