# Messenger Connectors Uncertainty Pass 74

Focus:

```text
ProviderSurfaceModel -> ExternalRouteEntryPoint -> TeamRouteBinding
```

The previous top-level docs still jumped too quickly from "provider can show/create this kind of surface" to
"we have an active team route". Lower sections already rejected this for Telegram private topics, but the canonical
architecture needed the same split.

## Finding

The route lifecycle needs three first-class concepts between capability and active binding:

```text
ProviderCapabilities
  says the connected provider account may support a container type

ProviderSurfaceModel
  describes what the adapter can show or create

RouteEntryPointProvisioningPlan
  chooses private topic, root thread, selector fallback, mutation policy and user confirmation policy

RouteEntryPointProvisioningAttempt
  records the provider mutation/probe attempt and its unknown/result boundary

ExternalRouteEntryPoint
  stores the provider-visible root object or selector state

ProviderRouteAddress
  normalizes the route key for idempotency and lookup

RouteActivationProof
  proves that this exact route generation is safe to use

TeamRouteBinding
  maps only an active route generation to Agent Teams teamIdentityId
```

## Invariant

No inbound provider message may reach the lead/team runtime unless the route has:

```text
active TeamRouteBinding
matching ProviderRouteAddress
matching routeGeneration
valid RouteActivationProof
non-tombstoned ExternalRouteEntryPoint
```

This is provider-neutral. Telegram private topics, Slack root-message threads and private-DM selector fallback routes all
use the same lifecycle. The provider-specific evidence differs, but the core state machine does not.

## Telegram Evidence

Do not activate from:

- `getMe.has_topics_enabled` alone;
- `createForumTopic` success alone;
- `sendMessage` success alone;
- topic title;
- missing or unknown `message_thread_id`;
- callback payload that has no signed nonce and no stored probe link.

Acceptable proof kinds:

```text
telegram_topic_inbound_proof:
  update contains expected chat_id + message_thread_id

telegram_topic_callback_proof:
  signed nonce matches stored probe message and routeGeneration

telegram_topic_medium_probe:
  createForumTopic persisted
  send probe result persisted
  provider returned expected chat_id + message_thread_id
  account-level topic UX confirmation is fresh

selector_explicit_activation:
  user selected team through signed selector state
```

## Slack Evidence

For future Slack support:

- `chat.postMessage` root message success is a provisioning result, not enough by itself if local persistence fails.
- `thread_ts` is a provider subroute key, not team identity by itself.
- a root message/thread may become active only after the root message link, route address and activation proof are
  committed.
- App Home Home tab is dashboard/control state, not canonical route history.
- App Home Messages tab or app DM root thread can use the same activation proof model.

## Failure States

Use explicit states instead of partial booleans:

```text
planned
provisioning
provisioned_unverified
activation_pending
active
activation_failed
repair_required
tombstoned
```

Crash windows:

- plan persisted, provider call not started: retry is safe.
- provider call started, local result missing: mark `provision_unknown` and require repair/probe, not blind recreate.
- entrypoint persisted, probe missing: stay `activation_pending`.
- activation proof persisted, binding update failed: recovery may activate same generation after verifying proof.
- binding active, tombstone detected: stop runtime delivery and move to repair.

## Tests To Add First

1. `has_topics_enabled=true` without activation proof does not activate a route.
2. `createForumTopic` success with failed local persist becomes `provision_unknown`, not active.
3. Probe send success without callback, inbound proof or fresh account-level proof stays pending.
4. Stale activation proof cannot activate a new `routeGeneration`.
5. Tombstoned entrypoint blocks inbound and outbound delivery.
6. Selector fallback route needs explicit selector activation proof.
7. Slack root message/thread activation uses the same proof gate.
8. Recovery can activate only the same generation after proof is already durably committed.

## Top 3 Options

1. First-class plan, attempt and proof records.
   🎯 9   🛡️ 10   🧠 7   Approx `900-1800` LOC.
   Recommended. It keeps capability, mutation and active routing separate and scales to Slack.

2. Store activation fields inside `TeamRouteBinding`.
   🎯 7   🛡️ 8   🧠 5   Approx `400-900` LOC.
   Simpler, but easier to activate stale generations and harder to audit provisioning crashes.

3. Activate immediately after provider create success.
   🎯 4   🛡️ 4   🧠 2   Approx `200-500` LOC.
   Rejected. This is the exact bug class the Telegram topic lifecycle is trying to avoid.

## Verdict

The canonical docs should now treat route setup as its own lifecycle:

```text
capability
-> surface
-> provisioning plan
-> provisioning attempt
-> entrypoint
-> route address
-> activation proof
-> active team binding
```

Implementation should start with these core models and tests before Telegram networking code.
