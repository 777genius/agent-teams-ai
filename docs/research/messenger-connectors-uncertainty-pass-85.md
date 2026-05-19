# Messenger Connectors Uncertainty Pass 85

Focus:

Does `connectionId` mean one thing across local UI/API, provider routing and cloud relay transport?

Finding:

After pass 84, public `connectionId` correctly means `MessengerConnectionId`. Some relay sections still used `connectionId` for the live websocket or stream session. That is a different concept. If left unresolved, a future implementation could validate an ACK against the product connection id while intending to validate a relay session id.

Current identifier taxonomy:

```text
MessengerConnectionId
  public API name: connectionId
  stable connected provider account/mode/transport owner in the desktop feature

RelaySessionId
  cloud relay stream/websocket session id
  changes on reconnect
  never exposed as public connectionId

DeviceLeaseId
  cloud relay lease for one desktop device to receive plaintext transiently
  may rotate without changing MessengerConnectionId

TeamRouteBindingId
  public API name: teamRouteId
  stable app-owned route binding under a MessengerConnectionId
```

Historical name map:

```text
connectionId in local UI/API docs
  -> MessengerConnectionId

connectionId in old relay/websocket docs
  -> RelaySessionId

leaseId or deviceLeaseId in old relay docs
  -> DeviceLeaseId
```

Relay frame rule:

```text
RelayOfferFrame:
  frameId
  relaySessionId
  deviceLeaseId
  messengerConnectionId
  teamRouteId?
  routeGeneration?
  payloadHash
  sequenceNumber

RelayAck:
  frameId
  relaySessionId
  deviceLeaseId
  messengerConnectionId
  teamRouteId?
  payloadHash
  localInboundId?
  status
```

Boundary rules:

- Local HTTP routes use `connectionId` only for `MessengerConnectionId`.
- Relay transport contracts use `relaySessionId` for live stream identity.
- Plaintext relay offers must require an active `DeviceLeaseId`.
- ACKs from stale `RelaySessionId` or stale `DeviceLeaseId` are rejected.
- Reconnecting the relay creates a new `RelaySessionId`, but not a new `MessengerConnectionId`.
- Repairing a team route keeps `TeamRouteBindingId`, increments `RouteGeneration`, and does not change `RelaySessionId`.

Required tests:

1. Local API rejects `relaySessionId` passed as `connectionId`.
2. Relay ACK rejects public `connectionId` when `relaySessionId` is expected.
3. Websocket reconnect creates new `RelaySessionId` and keeps `MessengerConnectionId`.
4. Stale `DeviceLeaseId` cannot ACK plaintext offers.
5. Renderer DTO never contains `relaySessionId` or `DeviceLeaseId`.

Top 3 implementation options:

1. Explicit relay identifiers now - 🎯 9   🛡️ 9   🧠 4, about `300-900` LOC.
   - Recommended.
   - Prevents relay ACK/session bugs and keeps local API vocabulary clean.
2. Keep relay `connectionId` but namespace it in DTOs - 🎯 6   🛡️ 6   🧠 3, about `150-400` LOC.
   - Less renaming.
   - Still easy to misuse because the word remains overloaded.
3. Reuse `MessengerConnectionId` for relay sessions - 🎯 3   🛡️ 4   🧠 2, about `100-250` LOC.
   - Simple.
   - Breaks reconnect semantics and stale-session protection.

Verdict:

Use `RelaySessionId` for relay stream identity and `DeviceLeaseId` for plaintext-receiving lease identity. Keep public `connectionId` reserved for `MessengerConnectionId`.
