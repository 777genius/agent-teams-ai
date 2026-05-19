# Messenger Connectors Uncertainty Pass 64

Date: 2026-05-01
Focus: documentation consistency audit after Slack route-entrypoint and storage corrections.

## Question

Do the current messenger connector docs contradict themselves after the latest Slack, provider abstraction and storage decisions?

## Audit Scope

Checked:

- product decision and final architecture top sections;
- living research summary;
- current provider-neutral core model;
- storage boundary;
- Telegram topic default and fallback language;
- stale/missing reply routing;
- Slack Home/root-thread route model;
- provider port/capability language.

## Conflicts Found And Fixed

1. Telegram topic default was too absolute in the architecture top section.
   Fixed to:

```text
One Telegram private-chat topic per Agent Teams team only when capability checks,
mutation policy, per-team activation proof and live client compatibility pass.
```

2. Stale or missing reply links sometimes said "route to lead with context".
   Fixed to:

```text
Normal un-replied team-topic messages route to lead.
Explicit provider replies with missing/stale/tombstoned links become ambiguous
and require repair/selector confirmation.
```

3. Storage language conflicted between "one physical messenger-state.json" and partitioned JSON.
   Fixed to:

```text
Core depends on MessengerStateStorePort + MessengerUnitOfWork.
MVP physical storage is partitioned versioned JSON with a unit-of-work journal.
SQLite remains a later replacement behind the same port.
```

4. Provider capability list was older and too small.
   Fixed to include surfaces, route entrypoints, formatting, rate limits, navigation and history/backfill policy.

5. Historical research sections can still contain older exploratory language.
   Fixed by adding canonical notes:

```text
Living summary + top Final Product Decision are current.
Detailed passes are historical working notes.
If older pass text conflicts with the summary, use the latest summary decision.
```

## Remaining Non-Conflicts

These phrases appear in old research sections, but are acceptable because they are historical or now scoped by the canonical note:

- "one topic per team" means "when the Telegram topic route container is active".
- "SQLite later" does not conflict with "no SQLite in MVP".
- Slack "thread" does not mean a core topic. It maps to `ExternalRouteEntryPoint` plus `ProviderSubrouteKey`.
- `ProviderPermalinkPort` and `ProviderNavigationPort` are not duplicate abstractions. Permalink is provider link creation; navigation is product-level open/repair/deep-link behavior.

## Current Canonical Decisions

- Default product path: official shared Telegram bot.
- Telegram private topics are preferred, but gated.
- Fallback selector mode is mandatory.
- Optional own-bot mode remains the privacy-clean mode.
- Slack future path: Home tab dashboard/control plus Messages/app DM root-thread per Agent Team.
- Core must use provider-neutral route entrypoints, surfaces and small ports.
- MVP storage uses partitioned versioned JSON behind `MessengerStateStorePort` and `MessengerUnitOfWork`.
- Explicit provider reply without a valid link is ambiguous, not lead-by-default.

## Confidence

1. Docs are now internally consistent at the canonical decision level.
   🎯 9   🛡️ 9   🧠 4   Approx 200-500 LOC documentation cleanup.

2. Leave old research text as historical with canonical note.
   🎯 9   🛡️ 8   🧠 2   Approx 20-80 LOC.
   Recommended because rewriting all historical passes would erase useful decision history.

3. Rewrite every historical pass to current language.
   🎯 5   🛡️ 7   🧠 8   Approx 5000-12000 LOC.
   Not recommended; high churn and easy to lose research context.
