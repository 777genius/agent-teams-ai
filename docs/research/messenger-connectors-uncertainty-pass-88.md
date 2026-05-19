# Messenger Connectors Uncertainty Pass 88

Date: 2026-05-01
Scope: cross-document coherence for reply proof, storage boundary, relay transport and identity fields

## What Was Still Weak

The docs were mostly aligned, but four old research threads could still be misread as active MVP policy:

1. Plain assistant text fallback.
   Earlier sections said a clean assistant reply could be sent to Telegram if one route lock was active. Later sections correctly changed this to exact-proof only. The old wording was dangerous because one route lock proves scheduling ownership, not user-visible reply intent.

2. Storage implementation default.
   Earlier sections alternated between one big `VersionedJsonStore`, sharded JSON, NDJSON WAL and SQLite. Later sections correctly converged on a single logical store/unit-of-work boundary, but some older recommendations still sounded like different MVP defaults.

3. Relay transport default.
   Earlier sections said WebSocket should be first. Later sections correctly changed the MVP to main-process HTTP streaming/SSE-wire plus HTTPS POST, with WSS as fallback if production proxy behavior requires it.

4. Identity field drift.
   Some examples still used `routeId`, `teamBindingId`, `desktopLeaseId` and `botConnectionId` in places that looked like active schemas. These now use `teamRouteId`, `teamIdentityId`, `deviceLeaseId` and `messengerConnectionId`.

## Current Reply Proof Rule

Provider auto-send is allowed only when a durable local visible reply creates `ExternalReplyProjectionIntent`.

Allowed MVP proof sources:

```text
message_send or SendMessage with relayOfMessageId
explicit provider link proof
exact runtime sidecar proof tied to the route-locked inbound message
```

Not allowed for provider auto-send:

```text
plain assistant text
latest visible message in the transcript
one active route lock by itself
lead_process text without exact proof
lead_session text without exact proof
```

Plain assistant text can still be useful:

```text
local conversation history
manual-review candidate
debug evidence for a repair task
```

It must not create `ProviderOutboxItem` in MVP.

## Why Route Lock Is Not Enough

A per-team route lock says "this external turn owns the runtime slot". It does not say "this specific text is safe to send to Telegram".

Failure modes:

- lead writes status text before tool completion;
- lead writes a planning note that looks user-facing;
- lead emits both visible narration and an explicit `message_send`;
- runtime stream duplicates or replays old text;
- route lock expires while a late assistant message still appears;
- local user sends a separate same-team prompt during the capture window.

Therefore:

```text
Route lock can authorize capture window.
ExternalReplyProjectionIntent authorizes provider outbox.
```

## Current Storage Rule

Core contract:

```text
MessengerStateStorePort
MessengerUnitOfWork
```

MVP adapter:

```text
sharded VersionedJsonStore physical tables
unit-of-work journal
idempotent repair loops
```

Future adapters:

```text
SQLite if query volume and transactional complexity grow
NDJSON WAL if append-heavy audit/history volume grows
encrypted backend queue store if advanced reliability mode ships
```

Do not expose the physical storage choice to domain policies, provider adapters or UI routes.

## Top 3 Storage Interpretations

1. Current MVP: logical `MessengerStateStorePort` plus `MessengerUnitOfWork`, sharded `VersionedJsonStore` physical tables.
   🎯 9   🛡️ 9   🧠 6   Approx `1600-3400` changed LOC.
   Best fit for current repo patterns. Keeps Clean Architecture boundary stable.

2. Hybrid JSON config plus NDJSON WAL ledgers from day one.
   🎯 8   🛡️ 9   🧠 7   Approx `2500-5200` changed LOC.
   Strong later option, but adds compaction and recovery surface before first Telegram proof.

3. SQLite now.
   🎯 7   🛡️ 9   🧠 8   Approx `4000-8500` changed LOC plus packaging.
   Strong data model, but adds native/Electron dependency and migration work too early.

## Coherence Fix Applied

Updated the living architecture and summary so current-looking older sections now say:

- plain assistant text is local/manual-review evidence only;
- provider auto-send requires exact proof through `ExternalReplyProjectionIntent`;
- storage default is one logical store/unit-of-work boundary;
- sharded `VersionedJsonStore` is the current MVP physical adapter;
- SQLite and NDJSON WAL are later adapters, not MVP defaults;
- relay transport default is main-process HTTP streaming/SSE-wire plus HTTPS POST;
- WSS is a fallback, not the first MVP choice;
- active schemas use `teamRouteId`, `teamIdentityId`, `deviceLeaseId` and `messengerConnectionId` consistently.

## Remaining Confidence

Reply proof coherence:

🎯 9.8   🛡️ 9.8   🧠 6

Storage boundary coherence:

🎯 9.6   🛡️ 9.3   🧠 6

Relay transport coherence:

🎯 9.7   🛡️ 9.4   🧠 6

Identity coherence:

🎯 9.8   🛡️ 9.6   🧠 4

Main remaining uncertainty is implementation proof, not architecture wording: we still need tests around capture windows, duplicate stream rows, crash after local visible reply, crash after provider request start and manual repair of `send_unknown`.
