# Messenger Connectors Uncertainty Pass 65

Date: 2026-05-01
Focus: second documentation consistency audit after pass 64.

## Question

Do the docs still contain contradictions that could mislead implementation?

## Additional Conflicts Found And Fixed

1. Top product decision in the summary still used shorter topic-gate wording.
   Fixed to match architecture:

```text
One Telegram private-chat topic per Agent Teams team only when capability checks,
mutation policy, per-team activation proof and live client compatibility pass.
```

2. Historical architecture sections still had "missing link -> fallback to lead".
   Fixed to:

```text
Normal un-replied team-topic message -> lead.
Explicit provider reply with missing/stale/unknown link -> ambiguous + repair/selector confirmation.
Removed teammate target -> ambiguous or teammate unavailable.
```

3. Historical relay sections still implied ACK timeout sends offline/degraded notice immediately after dispatch.
   Fixed to:

```text
Before plaintext dispatch:
  terminal non-delivery can return 2xx.

After plaintext dispatch:
  ACK missing returns non-2xx within bounded retry budget.
  Duplicate/local ACK can repair ownership.
  Retry budget expiry sends delivery_unconfirmed and returns 2xx.
```

4. An old architecture port list still used a provider god-port shape.
   Fixed to "provider adapter bundle split into small ports" so it does not conflict with pass 63.

## Checked And Still Consistent

- Local API boundary: existing Fastify `HttpServer` is HTTP-first local UI/control API; MCP is for agent/runtime tools; cloud relay is separate.
- Storage boundary: core depends on `MessengerStateStorePort` and `MessengerUnitOfWork`; MVP physical storage is partitioned JSON with unit-of-work journal; SQLite is later.
- Slack route model: Home tab dashboard/control, Messages/app DM root message per Agent Team, thread pane for conversation.
- Own-bot privacy model: BotFather token stays local; Managed Bots are convenience only, not privacy story.
- Provider abstractions: route entrypoint, surface model, interactions, formatting, rate limits, navigation/permalink and history backfill stay provider-neutral.

## Remaining Historical Language Policy

Some old sections still mention old options as rejected alternatives or research context, for example SQLite now, one giant state blob, old topic UX options, or offline notices before plaintext dispatch. That is acceptable if the text is clearly an option or historical context.

Canonical rule remains:

```text
Living summary + top Final Product Decision are current.
Historical passes do not override them.
```

## Confidence

1. Current canonical docs are implementation-safe.
   🎯 9   🛡️ 9   🧠 4   Approx 250-650 LOC documentation cleanup.

2. Rewrite every historical section to remove all old options.
   🎯 5   🛡️ 7   🧠 9   Approx 8000-18000 LOC.
   Not recommended because it would erase decision history and create churn.

3. Freeze current docs and move straight to implementation.
   🎯 8   🛡️ 8   🧠 3   Approx 0 LOC.
   Reasonable after this audit, but first implementation should still create tests for the canonical invariants.
