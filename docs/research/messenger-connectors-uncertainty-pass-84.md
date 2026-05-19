# Messenger Connectors Uncertainty Pass 84

Focus:

Does the identifier taxonomy make `connectionId`, `teamRouteId`, provider route identity and historical `routeId` unambiguous?

Finding:

Pass 83 made the public API provider-neutral with `teamRouteId`, but the current domain vocabulary still did not name `TeamRouteBindingId`. That left a gap where implementers could accidentally serialize `ProviderRouteAddress`, Telegram `message_thread_id`, Slack thread timestamp or old `routeId` as the public route id.

Current identifier taxonomy:

```text
MessengerConnectionId
  app-owned opaque id
  public API name: connectionId
  identifies one connected provider account/mode/transport owner

TeamRouteBindingId
  app-owned opaque id
  public API name: teamRouteId
  identifies one Agent Teams team route under a connection

RouteGeneration
  internal lifecycle counter
  increments on repair/reprovision
  never used alone as a public selector

ProviderRouteAddress
  provider route identity
  includes MessengerConnectionId, provider, conversation key, optional subroute key and route generation
  not exposed as public route id

ExternalRouteEntryPoint
  provider-visible root object such as Telegram topic, Slack root message, Discord thread or WhatsApp selector state
  not exposed as public route id
```

Historical name map:

```text
routeId in old public/API notes
  -> TeamRouteBindingId / teamRouteId

routeId in old provider-routing notes
  -> ProviderRouteAddress + RouteGeneration

accountBindingId in old notes
  -> MessengerConnectionId when it means a connected provider account in the desktop feature

message_thread_id, Slack thread ts, Discord thread id, WhatsApp selector id
  -> provider adapter fields only
```

Boundary rules:

- `connectionId` serializes only `MessengerConnectionId`.
- `teamRouteId` serializes only `TeamRouteBindingId`.
- `TeamRouteBindingId` survives provider route repair while `RouteGeneration` increments.
- `ProviderRouteAddress` may change on repair and must not be used as a stable public route id.
- Provider-native ids may appear in adapter logs only after redaction/hash policy, not in renderer DTO ids.
- Public DTOs may include provider-specific display labels such as "Telegram topic", but not provider-native ids as selectors.

Required tests:

1. `PATCH /api/messenger/team-routes/:teamRouteId` rejects a Telegram `message_thread_id`.
2. `POST /api/messenger/team-routes/:teamRouteId/repair` keeps the same `TeamRouteBindingId` and increments `RouteGeneration`.
3. Stale `RouteGeneration` cannot accept inbound runtime delivery.
4. Renderer DTO snapshot contains `teamRouteId`, not `ProviderRouteAddress`.
5. Slack adapter can map root message/thread to `ProviderRouteAddress` without changing public DTO names.

Top 3 implementation options:

1. Add explicit id value objects now - 🎯 9   🛡️ 9   🧠 4, about `300-800` LOC.
   - Recommended.
   - Prevents provider id leakage and makes tests precise.
2. Keep string aliases but document conventions - 🎯 6   🛡️ 6   🧠 2, about `100-250` LOC.
   - Fast.
   - Easy to mix up `routeId`, `teamRouteId` and provider ids.
3. Use provider address as public route id - 🎯 3   🛡️ 4   🧠 3, about `100-300` LOC.
   - Looks simple.
   - Breaks repair, provider migration and privacy redaction.

Verdict:

Add explicit `MessengerConnectionId`, `TeamRouteBindingId` and `RouteGeneration` to the current vocabulary. Public APIs expose only app-owned opaque ids.
