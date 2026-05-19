# Messenger Connectors Uncertainty Pass 86

Date: 2026-05-01
Focus: cross-document identity coherence after `MessengerConnectionId`, `TeamRouteBindingId`, `RelaySessionId` and `DeviceLeaseId`

## Question

Are the living summary, architecture plan, relay examples and storage examples still organically connected after the recent identifier taxonomy passes?

## Finding

Mostly yes, but several current-looking snippets still used old identity names:

```text
accountBindingId
providerAccountId
routeId
routeTeamId
connectionId
leaseId / leaseEpoch / connectionEpoch
```

That is risky because these names sit exactly on the critical chain:

```text
Telegram provider update
  -> cloud relay metadata
  -> desktop ACK
  -> local durable inbound
  -> team runtime route
  -> provider outbox
```

If implementers copy the older snippets literally, they can accidentally validate an ACK against the public product connection id, store a provider route as a public route id, or serialize plaintext claim lanes under a name that no longer exists in the domain model.

## Current Taxonomy

```text
MessengerConnectionId
  product/API connected provider account id
  public DTO field: connectionId

TeamRouteBindingId
  product/API team route binding id
  public DTO field: teamRouteId

teamIdentityId
  stable Agent Teams team identity
  not a provider route id

ProviderRouteAddress
  provider + messengerConnectionId + conversationKey + subrouteKey? + routeGeneration
  not public API identity

RelaySessionId
  one live cloud relay stream/session
  never public connectionId

DeviceLeaseId
  active desktop plaintext-receiving lease
  validates relay delivery permission
```

## Coherence Rule

Current docs should read as:

```text
UI/API route identity
  connectionId = MessengerConnectionId
  teamRouteId = TeamRouteBindingId

Provider route identity
  ProviderRouteAddress + RouteGeneration

Relay transport identity
  RelaySessionId + DeviceLeaseId

Team runtime identity
  teamIdentityId + run/session evidence
```

The relay ACK boundary must carry all four relevant identities:

```text
messengerConnectionId
teamRouteId
relaySessionId
deviceLeaseId
routeGeneration
```

## Applied Cleanup

- Added `pass-86` to the living summary index.
- Added alias rules for old `providerAccountId`, `routeTeamId`, `leaseEpoch` and `connectionEpoch` wording.
- Replaced current-looking storage and relay examples with `messengerConnectionId`, `teamRouteId`, `relaySessionId` and `deviceLeaseId`.
- Clarified metadata-only claim serialization as per `MessengerConnectionId`.
- Kept old research pass wording historical rather than rewriting every old note.

## Top 3 Options

1. Keep old research text but add strong alias map plus fix current-looking examples - 🎯 10   🛡️ 9   🧠 3, about `80-180` changed lines.
   - Best balance for a living research document.
   - Preserves research history while preventing implementation drift.

2. Rewrite every old pass to new names - 🎯 7   🛡️ 8   🧠 8, about `1200-2500` changed lines.
   - Cleaner search output.
   - High churn and easy to distort historical reasoning.

3. Leave aliases only in the summary - 🎯 6   🛡️ 6   🧠 2, about `10-30` changed lines.
   - Fast.
   - Architecture file remains confusing when read directly.

## Decision

Use option 1.

The docs are now more coherent without pretending historical passes were written with the final vocabulary. The important implementation-facing snippets now point at the current taxonomy.
