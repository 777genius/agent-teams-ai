# Messenger Connectors Uncertainty Pass 68

Date: 2026-05-01
Focus: boundary glue between adjacent abstractions

## Question

Is the documentation organically connected enough that implementation can start without each layer inventing its own interpretation of the same route?

## Verdict

Mostly yes, after one correction: the architecture chain must start with connection and capability, not with surface.

Correct chain:

```text
MessengerConnection
  -> ProviderCapabilities
  -> ProviderSurfaceModel
  -> ExternalRouteEntryPoint
  -> ProviderRouteAddress
  -> TeamRouteBinding
  -> ProviderReplyReference
  -> ExternalReplyTargetResolution
  -> MessengerRouteDecision
  -> MessengerConversationEntry
  -> ExternalMessageLink
  -> MessengerRuntimeTurnLedger
  -> ExternalReplyProjectionIntent
  -> ProviderOutbox
```

This makes the system read as one flow:

```text
provider account
-> provider can/cannot create a surface
-> provider-visible route root exists
-> normalized route address exists
-> Agent Team binding exists
-> optional provider reply reference is resolved
-> durable route/control decision exists
-> local conversation entry exists
-> exact message target exists
-> local runtime owns the turn
-> external reply projection is allowed
-> provider send is retried or reconciled
```

## Boundary Glue Rules

### 1. Connection vs Team Route Binding

`MessengerConnection` answers:

- which provider;
- which account or bot identity;
- official shared bot vs own bot;
- online/offline/blocked/reconnect status;
- relay lease or local polling owner;
- credential and privacy boundary.

`TeamRouteBinding` answers:

- which Agent Teams `teamIdentityId`;
- which provider route under that connection;
- which route generation;
- healthy, tombstoned, repair-required or disabled.

Rule: disconnecting a provider connection can suspend many team route bindings, but a team route binding must never own credentials or transport lifecycle.

### 2. Provider Capabilities vs Provider Surface Model

`ProviderCapabilities` is the umbrella contract.

It includes:

- surface model;
- route entrypoint kinds;
- exact reply support;
- thread/subroute support;
- interaction support;
- formatting profile;
- rate limit policy;
- ingress ACK policy;
- history/backfill policy;
- navigation and permalink support;
- provider-specific proof requirements.

`ProviderSurfaceModel` is only the visible/container subset:

- private chat;
- Telegram topic;
- Slack Home;
- Slack app DM;
- channel;
- thread;
- modal;
- buttons;
- menus.

Rule: route creation must consult `ProviderCapabilities`, but UI layout must only consume safe projected surface/navigation DTOs.

### 3. External Route EntryPoint vs Provider Route Address

`ExternalRouteEntryPoint` is the provider-visible root object:

- Telegram topic;
- Slack root message/thread;
- Discord thread;
- WhatsApp selector window;
- route generation;
- lifecycle/tombstone/repair status.

`ProviderRouteAddress` is the normalized routing key:

```text
accountBindingId + provider + conversationKey + subrouteKey? + routeGeneration
```

Rule: use entrypoint for lifecycle and user-facing repair, use route address for idempotency, repository keys and routing.

### 4. Team Route Binding vs External Message Link

`TeamRouteBinding` chooses the team scope.

`ExternalMessageLink` chooses the exact reply target.

Rule: a provider reply can target a teammate or lead only if the reply reference resolves through `ExternalMessageLink`. A normal un-replied message in a valid team route goes to lead by default.

### 5. Runtime Ledger vs Provider Outbox

`MessengerRuntimeTurnLedger` owns local admission:

- duplicate local delivery;
- ambiguous local ACK;
- active desktop ownership;
- local execution state.

`ProviderOutbox` owns provider send:

- send attempts;
- provider rate limits;
- timeout/unknown results;
- provider message id capture;
- outbound `ExternalMessageLink` creation.

Rule: runtime success does not imply provider delivery, and provider send ambiguity must never mutate runtime turn ownership.

### 6. Permalink vs Navigation

`ProviderPermalinkPort` creates provider-native URLs where possible.

`ProviderNavigationPort` converts product actions into navigation intents:

- open provider thread;
- open local desktop team;
- repair route;
- start setup;
- show selector/manual review.

Rule: navigation may call permalink creation, but permalink creation must not own product routing decisions.

### 7. Store Port vs Physical JSON Tables

`MessengerStateStorePort` and `MessengerUnitOfWork` are the canonical persistence boundary.

Partitioned JSON files are physical tables:

```text
connections.json
team-route-bindings.json
route-entrypoints.json
conversation-entries/*.json
message-links/*.json
provider-outbox/*.json
unit-of-work-journal.json
```

Rule: repositories share one unit-of-work boundary. JSON file layout can later become SQLite without changing domain or use-case code.

## Organic Fit Check

The current docs now satisfy the intended Clean Architecture shape:

- Product rules live above provider details.
- Core speaks in provider-neutral route, message, target and outbox concepts.
- Provider adapters expose small ports instead of one god port.
- Telegram private topics and Slack root-message threads share the same route-entrypoint abstraction.
- Renderer DTOs are projections of domain state, not route truth.
- Local HTTP server is an input adapter, not the core architecture.
- Own-bot, official relay and future Slack modes differ by adapter and capability profile, not by duplicated routing logic.
- The slice still matches `docs/FEATURE_ARCHITECTURE_STANDARD.md`: `contracts/` owns DTOs, `core/domain` owns pure rules, `core/application` owns use cases and ports, `main/adapters` own HTTP/provider/process integration, and renderer code consumes projected DTOs.

## Top 3 Implementation Glue Strategies

1. Build boundary contracts first, then Telegram adapter.
   🎯 9   🛡️ 9   🧠 7   Approx `1200-2500` LOC.
   Recommended. This locks vocabulary, tests route decisions early, and prevents Telegram SDK shapes from leaking into core.

2. Build Telegram happy path first, then extract contracts.
   🎯 6   🛡️ 6   🧠 5   Approx `900-1800` LOC now, likely `1800-3500` LOC refactor later.
   Faster demo, but higher risk that Slack and own-bot support will require changing core names and stores.

3. Build full plugin framework before Telegram.
   🎯 5   🛡️ 8   🧠 9   Approx `3000-6000` LOC.
   Too much framework before the first adapter proves the lifecycle.

## Remaining Weak Spots

1. Exact Telegram private-topic client behavior still needs fixture proof.
2. Slack production rate limits need app-level test evidence later.
3. Unit-of-work recovery must be tested with crash-at-every-step fault injection.
4. Provider outbox ambiguous-send reconciliation needs a fake provider harness before real token testing.
5. Renderer manual-review UX must make ambiguity obvious without exposing internal jargon.

## Recommendation

Start implementation with:

```text
contracts/api DTOs
core/domain connection and capability models
core/domain route models
core/domain policies
core/application repository ports
MessengerStateStorePort + MessengerUnitOfWork
route/link/outbox policy tests
```

Do Telegram networking only after these compile and pass focused unit tests.
