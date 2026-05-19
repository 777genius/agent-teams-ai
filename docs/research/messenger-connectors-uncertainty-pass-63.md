# Messenger Connectors Uncertainty Pass 63

Date: 2026-05-01
Focus: make the Slack UX visually concrete and re-check whether the architecture has enough abstraction for future providers.

## Question

The selected Slack model is "Home dashboard plus Messages/app DM plus one root thread per Agent Team". It is technically sound, but visually hard to imagine. Also, re-check whether the current Clean Architecture abstraction is enough before implementation starts.

## Visual Slack Mental Model

Think about Slack as three surfaces, not one giant chat:

```text
Slack sidebar app
  -> Home tab: index/dashboard/control
  -> Messages tab or app DM: private conversation shelf
  -> Thread pane: actual per-team chat room
```

Home tab is the index:

```text
Agent Teams

[Search teams...]        Status: Desktop online

Project: Acme CRM
  Web Dashboard       Lead online       3 teammates       [Open thread] [Open desktop] [...]
  Billing API         Lead busy         2 teammates       [Open thread] [Repair]

Project: Platform
  Infra Runner        Desktop offline   1 teammate        [Open desktop]

Needs attention
  Mobile Checkout     Send unknown      [Repair route]
```

Messages tab or app DM is the shelf of root messages:

```text
Agent Teams app DM

Agent Teams bot
Team: Web Dashboard
Project: Acme CRM
Status: Lead online, 3 teammates
Use this thread to talk to the team lead.
[Open desktop] [Pause] [Message teammate]
12 replies

Agent Teams bot
Team: Billing API
Project: Acme CRM
Status: Lead busy, 2 teammates
Use this thread to talk to the team lead.
4 replies
```

Thread pane is the actual conversation:

```text
Thread: Web Dashboard

You
Can you check why onboarding fails on Safari?

Lead
Looks like the OAuth popup is blocked. I am checking the callback flow.

Alice
I pushed a fix for the popup dimensions. Need review from lead.

You
Thanks, lead please verify.
```

Important product rule:

```text
Home tab = find and control the team
Root message = stable door into a team thread
Thread replies = actual lead conversation
Top-level app-DM messages = selector/setup/repair only
```

This avoids a cluttered Slack DM because normal replies stay inside threads. The Home tab is what makes old root messages findable.

## How The User Navigates

1. User opens `Agent Teams` app in Slack.
2. Home tab shows all connected Agent Teams grouped by project.
3. User clicks `Open thread` on `Web Dashboard`.
4. Slack opens the root message/thread via provider permalink.
5. User writes in that thread.
6. Connector routes the message to the lead by default.
7. Teammate messages appear in the same thread with visible sender label.
8. If user wants a specific teammate, they use `Message teammate`, a select menu, or explicit command.

If the user types a top-level message in the app DM:

```text
"Web Dashboard: can you check auth?"
```

The connector can either open/activate the team selector or ask confirmation. It must not route by newest team.

## Why This Is Not A Telegram Topic Clone

Telegram private topics:

```text
private bot chat
  topic per Agent Team
```

Slack App Home/app DM:

```text
private app-user conversation
  root message per Agent Team
  thread under root message per Agent Team
```

Same product concept, different provider primitives:

```text
Agent Team route entrypoint
  Telegram: chat_id + message_thread_id
  Slack: channel_id + root ts + thread_ts
  Discord: dm/guild/channel/thread id
  WhatsApp: contact conversation + active team selector state
```

That is why core must speak `ExternalRouteEntryPoint`, not `Topic`.

## Architecture Adequacy Review

Verdict:

```text
Current architecture is sufficient if route entrypoints and provider surfaces are implemented as first-class core contracts before Telegram networking.
```

The required separation is:

```text
Provider update/input
  -> ProviderInboundNormalizer
  -> ProviderControlPlaneClassifier
  -> RouteEntryPointResolver
  -> TargetSelectionPolicy
  -> TeamDeliveryUseCase

Internal visible message/reply
  -> ExternalReplyProjectionIntent
  -> ProviderFormattingRenderer
  -> ProviderRateLimitPolicy
  -> ProviderOutboundSender
  -> ExternalMessageLinkRepository
```

Clean Architecture fit:

- `contracts`: DTOs and local HTTP/IPC route contracts only.
- `core/domain`: route identity, entrypoint state, target selection, dedupe, privacy, ambiguity and retry policies.
- `core/application`: use cases and ports. No Fastify, Electron, Telegram, Slack or renderer state.
- `main/adapters/input`: local HTTP/IPC, Telegram webhook/polling, future Slack Events/Socket Mode.
- `main/adapters/output`: provider API clients, durable store, team runtime injection, safe logger, vault.
- `renderer`: connection wizard, health, repair and review UI. It never performs delivery or opens relay streams.

SOLID review:

- SRP: provider normalizers parse provider payloads; route policies route; renderers format; senders send.
- OCP: Slack, Discord and WhatsApp add adapter bundles and capability maps without changing route core.
- LSP: a provider with no native thread, like WhatsApp, must still satisfy core by exposing `subrouteKey = none` and selector capability, not by pretending to support threads.
- ISP: avoid one giant provider port. Split inbound normalization, entrypoint provisioning, interactions, formatting, rate limits, permalink, history backfill and outbound send.
- DIP: use cases depend on ports and pure policies, not SDKs, JSON files, Fastify, Electron, Slack Block Kit or Telegram Bot API types.

## Abstractions That Are Definitely Needed

These should exist before or during the first Telegram slice:

1. `ExternalRouteEntryPoint`
   - First-class route root object.
   - Stores provider, account binding, conversation key, optional subroute key, root provider message key, route generation and status.

2. `ProviderSurfaceModel`
   - Declares available surfaces and limits.
   - Examples: private topic, app home, app DM, channel thread, modal, button, selector, permalink, history backfill.

3. `ProviderControlPlaneClassifier`
   - Runs before route resolution.
   - Catches `/teams`, `/sent`, setup, repair, pause and top-level app-DM selector text.

4. `TargetSelectionPolicy`
   - Normal thread/topic replies route to lead by default.
   - Teammate route requires exact link, interaction target, or explicit command.

5. `ProviderInteractionPort`
   - Normalizes Telegram callback queries, Slack Block Kit actions/modals, Discord components and WhatsApp buttons/lists.

6. `ProviderFormattingRenderer`
   - Keeps Telegram text, Slack mrkdwn/Block Kit, Discord markdown and WhatsApp template restrictions outside core.

7. `ProviderRateLimitPolicy`
   - Keeps Telegram bot/chat limits, Slack workspace/channel/method limits, Discord buckets and WhatsApp send windows outside core.

8. `ProviderIngressAckPolicy`
   - Telegram webhook/own-polling, Slack HTTP Events and Slack Socket Mode have different ACK semantics.

9. `ProviderNavigationPort`
   - Wraps Slack permalinks, Telegram repair links and future provider deep links.
   - Can be implemented with `ProviderPermalinkPort` plus provider-specific route URLs.

10. `ProviderHistoryBackfillPort`
    - Optional repair tool only.
    - Never used as live source of truth.

## Abstractions To Avoid For Now

- Do not create a universal `Topic` core model.
- Do not create a universal `ThreadMessage` model that pretends all providers thread the same way.
- Do not put Slack Block Kit JSON, Telegram message ids, Discord route buckets or WhatsApp template ids in core domain.
- Do not build a full plugin marketplace/framework for providers before Telegram MVP.
- Do not make one provider god interface. Use small ports and wire provider bundles in composition.

## Architecture Options

1. Capability-bundle plus small ports.
   🎯 9   🛡️ 9   🧠 7   Approx 1200-2500 LOC.
   Recommended. Providers are added through adapters and capability data, while core policies remain stable.

2. Full provider plugin framework now.
   🎯 6   🛡️ 8   🧠 9   Approx 3000-6000 LOC.
   Flexible, but too much before Telegram proves lifecycle, recovery and UX.

3. Telegram-first core and retrofit Slack later.
   🎯 5   🛡️ 5   🧠 3   Approx 300-700 LOC now, but likely 2500-5000 LOC later.
   Fast now, high future rewrite risk.

## Decision

Keep the current feature-slice architecture, but make these corrections explicit:

- one canonical `MessengerStateStorePort` and `MessengerUnitOfWork` boundary for MVP;
- physical storage stays replaceable;
- recommended MVP physical storage is partitioned versioned JSON with a unit-of-work journal, not a domain-visible single state object;
- SQLite can replace partitioned JSON later without changing core;
- `ExternalRouteEntryPoint` is not optional;
- `ProviderSurfaceModel` is pure capability/configuration data, not UI code;
- no provider adapter leaks SDK payloads into `core/domain` or `core/application`;
- Slack support later should require adding a Slack adapter bundle and renderer setup screens, not rewriting route core.

## Sources

- Feature architecture standard: `docs/FEATURE_ARCHITECTURE_STANDARD.md`
- Reference feature layout: `src/features/recent-projects`
- Slack App Home: https://docs.slack.dev/surfaces/app-home/
- Slack `chat.postMessage`: https://docs.slack.dev/reference/methods/chat.postMessage/
- Slack `chat.getPermalink`: https://docs.slack.dev/reference/methods/chat.getPermalink/
- Slack Block Kit button element: https://docs.slack.dev/reference/block-kit/block-elements/button-element/
