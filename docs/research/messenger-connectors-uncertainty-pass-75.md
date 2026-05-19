# Messenger Connectors Uncertainty Pass 75

Focus:

```text
Does the canonical provider-neutral identity model still leak old Telegram-only route wording?
Does the durable store list contain every first-class concept in the canonical chain?
```

## Finding

The docs were mostly coherent after pass 74, but three older summary sections still used pre-abstraction wording:

- Telegram conversation identity included `message_thread_id`.
- The route registry still used an old topic-specific provisioning-attempt name.
- The top durable-store lists did not include newer route activation and delivery-resolution records.

These are small wording issues, but they matter because the first implementation slice will likely copy names from the
summary.

## Correct Identity Split

Use this split everywhere:

```text
ExternalConversationKey
  outer provider container
  Telegram: botUserId + chat_id
  Slack: enterprise_id? + team_id/context_team_id + channel_id

ProviderSubrouteKey
  optional provider-native topic/thread/selector state
  Telegram: message_thread_id
  Slack: thread_ts

ProviderRouteAddress
  accountBindingId + provider + conversationKey + subrouteKey? + routeGeneration

ExternalMessageKey
  provider message identity
  Telegram: botUserId + chat_id + message_thread_id? + message_id
  Slack: team/context + channel + ts
```

The route address chooses a team only through an active `TeamRouteBinding` with valid `RouteActivationProof`.
`message_thread_id` by itself never chooses a team in core.

## Store Alignment

The canonical local store needs logical records for every stateful concept in the main chain:

```text
connections
teamRouteBindings
routeEntryPoints
routeTombstones
provisionAttempts
routeActivationProofs
controlPlaneDecisions
routeDecisions
processedUpdates
conversationEntries
externalMessageLinks
runtimeTurns
localProjectionEffects
providerOutbox
providerSendAttempts
providerDeliveryResolutions
manualResolutionTasks
```

Official shared-bot mode may add adapter/backend metadata tables such as `relayAckLedger`, `officialSendRequests`,
`providerResultCache`, and `relayClaims`. Those are not substitutes for the feature-owned state records above.

## Tests To Add First

1. Telegram `chat_id` without `message_thread_id` resolves to control/setup, not a team route.
2. Telegram `chat_id + message_thread_id` resolves only through active `ProviderRouteAddress + TeamRouteBinding`.
3. Stale `routeGeneration` blocks inbound and outbound delivery.
4. A store migration missing `routeActivationProofs` fails fast before route activation.
5. A store migration missing `providerDeliveryResolutions` fails fast before provider send recovery.
6. Slack `thread_ts` follows the same `ProviderSubrouteKey` path and does not require Telegram-specific fields.

## Top 3 Options

1. Provider-neutral identity plus explicit store tables.
   🎯 9   🛡️ 10   🧠 6   Approx `700-1500` LOC.
   Recommended. This keeps Telegram and Slack under the same core contracts.

2. Keep Telegram composite keys in early MVP and map to provider-neutral later.
   🎯 5   🛡️ 6   🧠 3   Approx `300-800` LOC now, likely `1200-2500` LOC later.
   Faster initially, but it turns Slack into a retrofit.

3. Let adapters build ad hoc keys and store opaque route strings.
   🎯 4   🛡️ 4   🧠 2   Approx `200-600` LOC.
   Rejected. It hides route-generation and activation-proof bugs until recovery or repair.

## Verdict

The docs should keep one vocabulary:

```text
conversationKey + subrouteKey + routeGeneration -> ProviderRouteAddress
ProviderRouteAddress + RouteActivationProof -> active TeamRouteBinding
active TeamRouteBinding + ExternalMessageLink -> exact target routing
```

Implementation should create these types and migration tests before adding Telegram SDK calls.
