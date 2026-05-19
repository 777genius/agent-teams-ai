# Messenger Connectors Uncertainty Pass 76

Focus:

```text
Do message identity, local conversation history and provider outbox naming still point to one coherent chain?
```

## Finding

The route identity vocabulary was fixed in pass 75, but one adjacent naming drift remained:

- the current summary still used `ProviderMessageKey` in one identity block;
- the same block said `ProviderOutbox` chooses send ownership, while the canonical chain uses `ProviderOutboxItem`;
- the physical store list used `conversations.json`, while the logical table and domain model are `conversationEntries` and `MessengerConversationEntry`.

These are not behavior changes, but they matter for the first implementation slice because they decide class, file and
repository names.

## Canonical Names

Use these names in new implementation docs and code:

```text
ExternalMessageKey
  provider-native message id normalized by adapter

ExternalMessageLink
  durable provider message <-> internal message/target link

MessengerConversationEntry
  local user-visible history/runtime context row

ExternalReplyProjectionIntent
  proof that a local visible reply may leave the app

ProviderOutboxItem
  deterministic provider send intent and chunk ownership

ProviderSendAttempt
  non-idempotent request_started boundary

ProviderDeliveryResolution
  durable post-send feature outcome
```

Avoid introducing new `ProviderMessageKey` types in core. If lower historical notes mention `providerMessageKey`, read
that as adapter/internal field naming for the canonical `ExternalMessageKey`.

## Store Naming

The current physical store names should make the domain model obvious:

```text
conversation-entries.json -> conversationEntries -> MessengerConversationEntry
local-projection-effects.json -> localProjectionEffects -> LocalProjectionEffect
provider-outbox.json -> providerOutbox -> ProviderOutboxItem
provider-send-attempts.json -> providerSendAttempts -> ProviderSendAttempt
provider-delivery-resolutions.json -> providerDeliveryResolutions -> ProviderDeliveryResolution
manual-resolution-tasks.json -> manualResolutionTasks -> MessengerManualResolutionTask
```

Do not use old generic names like `conversations.json`, `outbox.json` or `projection-ledger.json` in the current
implementation plan. They hide the responsibility split.

## Tests To Add First

1. `ExternalMessageKey` is the only core message identity type exported by the feature public entrypoint.
2. `ExternalMessageLink` cannot be created from a `MessengerConversationEntry` without provider message evidence.
3. `ProviderOutboxItem` cannot be created without `ExternalReplyProjectionIntent`.
4. `ProviderSendAttempt` cannot be retried blindly after `request_started`.
5. Store migration maps old `conversations` data into `conversationEntries` before routing is enabled.

## Top 3 Options

1. Canonical external-message and conversation-entry names now.
   🎯 9   🛡️ 9   🧠 4   Approx `250-700` LOC.
   Recommended. Small cleanup, high implementation clarity.

2. Keep `ProviderMessageKey` as an alias type.
   🎯 7   🛡️ 7   🧠 3   Approx `150-400` LOC.
   Acceptable internally, but only if public core contracts still expose `ExternalMessageKey`.

3. Keep generic store names and document mapping separately.
   🎯 5   🛡️ 6   🧠 2   Approx `50-150` LOC.
   Rejected for MVP implementation docs because it makes recovery and projection ownership easier to mix up.

## Verdict

The docs should keep the message chain explicit:

```text
ExternalMessageKey
-> ExternalMessageLink
-> MessengerConversationEntry
-> ExternalReplyProjectionIntent
-> ProviderOutboxItem
-> ProviderSendAttempt
-> ProviderDeliveryResolution
```

This keeps local history, reply proof and provider delivery as separate responsibilities.
