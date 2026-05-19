# Messenger Connectors Uncertainty Pass 70

Date: 2026-05-01
Focus: reply-reference lookup before current-message link persistence

## Question

Does the documentation clearly separate these two operations?

```text
1. read a reply reference from the current provider message and resolve its target
2. save a new link for the current provider message
```

## Finding

Not enough. The lower research already had `ProviderReplyReference`, but the top canonical flow compressed everything into "durable ExternalMessageLink". That could lead implementation to create the current message link before it has resolved the previous reply target, or to treat the current link as proof for itself.

## Correct Inbound Order

```text
Provider update
-> ProcessedProviderUpdate dedupe
-> ExternalRouteEntryPoint lookup
-> TeamRouteBinding lookup
-> ProviderReplyReference extraction
-> ExternalMessageLinkRepository lookup for previous provider message
-> ExternalReplyTargetResolution
-> TargetSelectionPolicy route decision
-> MessengerRouteDecision persisted
-> MessengerConversationEntry inbound
-> ExternalMessageLink save for current provider message
-> MessengerRuntimeTurnLedger
```

## Definitions

`ProviderReplyReference`:

- optional;
- extracted from the current inbound provider message;
- Telegram uses same-chat same-thread `reply_to_message.message_id`;
- Slack normal thread replies use thread context for team scope, not exact teammate target;
- Discord and WhatsApp can expose provider-native message references;
- never trusted from visible text, quoted text, sender name or topic title.

`ExternalReplyTargetResolution`:

- result of resolving `ProviderReplyReference` through `ExternalMessageLinkRepository`;
- can be `none`, `resolved`, `ambiguous`, `stale`, `tombstoned`, `crossRoute` or `unsupported`;
- is input to `TargetSelectionPolicy`;
- is not persisted as the source of truth unless the route decision stores its reason.

`ExternalMessageLink`:

- previous-message lookup source before target selection;
- current-message persistence record after local entry creation;
- outbound provider id record after provider send success.

## Rule

Never let the current inbound message link resolve the current inbound message target.

Target selection for a provider reply must use an already-existing link for the provider message being replied to.

If the previous link is missing, stale, tombstoned or cross-route:

```text
normal un-replied message -> lead by default
provider reply with unresolved target -> ambiguous/repair/selector
```

## Why This Matters

Without this split, an implementation can create these bugs:

- reply-to teammate message routes to lead because lookup happens after current entry save;
- unknown reply target is silently treated as normal lead message;
- current message link becomes self-proof;
- stale route generation links route to a deleted team;
- Slack thread context is mistaken for exact teammate proof.

## Tests To Add First

1. Current inbound link cannot resolve its own target.
2. Missing previous reply link gives ambiguous state, not lead, when the provider message is an explicit reply.
3. Normal un-replied team-route message still routes to lead.
4. Tombstoned previous link blocks delivery to old teammate/team.
5. Cross-route previous link blocks delivery.
6. Slack normal thread reply routes to lead by team scope, not teammate exact target.

## Top 3 Options

1. Add `ProviderReplyReference` and `ExternalReplyTargetResolution` to core.
   🎯 9   🛡️ 10   🧠 6   Approx `500-1100` LOC.
   Recommended. It keeps reply lookup explicit and provider-neutral.

2. Keep this inside `TargetSelectionPolicy` only.
   🎯 7   🛡️ 8   🧠 4   Approx `250-700` LOC.
   Less code, but the policy becomes harder to test because it mixes provider reference parsing, repository lookup and routing.

3. Treat missing reply links as lead messages.
   🎯 3   🛡️ 3   🧠 2   Approx `100-300` LOC.
   Rejected. It creates wrong-recipient risk.

## Verdict

The docs are now more organic because `ExternalMessageLink` has three explicit roles:

```text
previous-message lookup
current-message inbound persistence
outbound provider id persistence
```

Implementation should test these roles separately before any Telegram adapter E2E.
