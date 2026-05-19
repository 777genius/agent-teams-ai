# Messenger Connectors Uncertainty Pass 77

Focus:

```text
Does the ExternalMessageLink vocabulary line up across domain model, repositories and physical store names?
```

## Finding

After pass 76, the domain model was clear but the store naming still had one generic alias:

```text
ExternalMessageLinkRepository
message-links.json
messageLinks
```

That is understandable, but it creates unnecessary naming friction. The feature has several link-like records:
activation proof links, provider reply references, provider permalinks, repair tokens and message links. The current
core concept should stay explicit.

## Canonical Naming

Use one name family:

```text
ExternalMessageLink
ExternalMessageLinkRepository
external-message-links.json
externalMessageLinks
```

This keeps the store aligned with:

```text
ExternalMessageKey
-> ExternalMessageLink
-> ExternalReplyTargetResolution
```

Provider adapters may still use provider-specific local variable names while normalizing raw payloads, but core and
feature-level stores should expose `ExternalMessageLink`.

## Why This Matters

Generic `messageLinks` is easy to confuse with:

- local conversation reply links;
- UI feed references;
- provider permalinks;
- repair command links;
- Slack thread links.

The feature cannot infer teammate routing from those. It needs a durable `ExternalMessageLink` that contains provider
message identity, internal message identity, route generation and target proof.

## Tests To Add First

1. Public feature exports include `ExternalMessageLink`, not `ProviderMessageLink`.
2. Store migration maps `messageLinks` to `externalMessageLinks`.
3. `ExternalReplyTargetResolution` reads only `externalMessageLinks`.
4. Provider permalink creation cannot create an `ExternalMessageLink`.
5. Repair token resolution cannot create an `ExternalMessageLink` without provider message evidence.

## Top 3 Options

1. Use `ExternalMessageLink` naming everywhere in current docs and new code.
   🎯 9   🛡️ 9   🧠 3   Approx `150-450` LOC.
   Recommended. Low effort and removes ambiguity before implementation.

2. Keep `messageLinks` as storage shorthand and document the mapping.
   🎯 7   🛡️ 7   🧠 2   Approx `50-150` LOC.
   Acceptable, but weaker for onboarding and migration tests.

3. Keep older `ProviderMessageLink` naming.
   🎯 4   🛡️ 5   🧠 2   Approx `50-150` LOC.
   Rejected. It conflicts with the provider-neutral `ExternalMessageKey` and `ExternalMessageLink` model.

## Verdict

Use the explicit name family:

```text
ExternalMessageLinkRepository
external-message-links.json
externalMessageLinks
```

This keeps reply routing, provider proof and local conversation history separated.
