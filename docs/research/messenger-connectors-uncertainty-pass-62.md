# Messenger Connectors Uncertainty Pass 62

Date: 2026-05-01
Focus: Slack App Home or app DM UX, one Slack thread per Agent Teams team, and extra provider abstractions for future scale.

## Question

How would "App Home Messages tab or app DM, one thread per Agent Team" look inside Slack, and where do we need more abstraction so Telegram topics do not leak into the core architecture?

## Slack Source Facts

- Slack App Home is a private one-to-one space between a user and an app.
- App Home can contain Home, Messages and About tabs.
- The Home tab is a customizable Block Kit view and can contain up to 100 blocks.
- The Messages tab is the private app-user conversation and requires `chat:write`; message events require `message.im`.
- Slack can deep-link to the app home `home`, `about`, or `messages` tab.
- Slack messages support threads. To send a reply, `chat.postMessage` uses the parent message `ts` as `thread_ts`.
- Slack `chat.getPermalink` can produce a URL for a message, including a threaded message URL with `thread_ts`.
- `conversations.replies` can retrieve a thread, but for new commercially distributed non-Marketplace apps it can be limited to 1 request per minute and 15 objects, so it must not be the live hot path.
- Block Kit works across Home tabs, messages and modals, and supports interactive components such as buttons and menus.
- Slack Events API HTTP delivery needs an HTTP 2xx within three seconds and retries failed delivery attempts. Socket Mode uses WebSocket delivery and a separate app-level token.

## Recommended Slack UX

Inside Slack the user sees one app, for example `Agent Teams`, in the Slack sidebar.

Home tab:

```text
Agent Teams

Active
  Web Dashboard       Acme CRM        Lead online      3 teammates
  Mobile Checkout     Storefront      Lead busy        1 teammate
  Infra Runner        Platform        Desktop offline

Actions per team:
  Open thread
  Open desktop
  Pause external replies
  Repair route
  Message teammate
```

The Home tab is not canonical chat history. It is the navigation and control surface:

- group Agent Teams by project/workspace;
- show status, last activity, unresolved sends and route health;
- provide buttons for `Open thread`, `Open desktop`, `Pause`, `Repair` and `Message teammate`;
- refresh from our local canonical messenger state, not from Slack history polling.

Messages tab or app DM:

- When a team is connected, the app posts one root message for that team.
- That root message is the Slack equivalent of a Telegram topic header.
- The actual conversation happens in the Slack thread under that root message.
- New Agent Team means new root message and new thread.
- Deleted or archived Agent Team means the root message is updated or followed up with a final status, while the stored route generation is tombstoned.

Example root message:

```text
Team: Web Dashboard
Project: Acme CRM
Status: Lead online, 3 teammates

Use this thread to talk to the team lead.
Buttons: Open desktop, Pause, Repair, Message teammate
```

Thread messages:

```text
You:
Can you check why onboarding fails on Safari?

Lead:
Looks like the OAuth popup is blocked. I am checking the callback flow.

Alice:
I pushed a fix for the popup dimensions. Need review from lead.
```

Normal user reply in this thread routes to the lead by default. This is important: Slack `thread_ts` proves the Agent Team thread, but does not prove which teammate message the user meant. Teammate-targeted replies need an explicit target:

- button/select/modals from Block Kit, for example `Message teammate`;
- explicit command syntax, for example `@Alice can you check logs?`;
- a stored exact provider reference if Slack event payload gives enough proof.

Top-level messages in the app DM are control plane, not lead traffic:

- `/teams` or a natural-language team name can open a selector;
- ambiguous text asks the user to choose a team;
- setup, pause, repair and help commands are handled before routing;
- no top-level app-DM text should be blindly delivered to the lead.

## Top 3 Slack UX Options

1. Home dashboard plus Messages tab/app DM, one root message/thread per Agent Team.
   🎯 8   🛡️ 9   🧠 7   Approx 2500-4500 LOC.
   Best default for future Slack because it is private, discoverable and maps cleanly to route entrypoints.

2. App DM only with `/teams` selector and one thread per Agent Team.
   🎯 7   🛡️ 8   🧠 5   Approx 1800-3200 LOC.
   Simpler to build, but worse discoverability and weaker repair/status UX.

3. User-selected Slack channel with one thread per Agent Team.
   🎯 7   🛡️ 8   🧠 7   Approx 3000-5200 LOC.
   Good advanced shared mode, but not the private default because workspace channel membership and Slack Connect can complicate routing and privacy.

## Core Abstractions Needed

The core should not know "topic". It should know "route entrypoint plus optional subroute".

Add or reserve these abstractions before deep Telegram implementation:

- `ProviderSurfaceModel`: declares which surfaces a provider has, for example private chat, topic, app home, app DM, channel, thread, modal, button/menu interactions.
- `RouteEntryPointRegistry`: stores provider-created entrypoints such as Telegram topic, Slack root message, Discord thread or WhatsApp selector state.
- `ExternalRouteEntryPoint`: provider root object for an Agent Team route, with provider, account binding, conversation key, optional subroute key, provider message key, route generation and tombstone state.
- `ProviderInteractionPort`: normalizes Telegram callback query, Slack Block Kit action/modal, Discord component interaction and WhatsApp button/list response.
- `TargetSelectionPolicy`: decides lead-by-default, teammate-by-explicit-target, team selector, repair/setup and ambiguous.
- `ProviderFormattingRenderer`: produces Telegram plain text, Slack mrkdwn/Block Kit, Discord markdown and WhatsApp text/template-safe output from one core message intent.
- `ProviderRateLimitPolicy`: owns provider-specific throttling keys. Slack needs workspace/channel/method awareness; Telegram needs bot/chat awareness.
- `ProviderPermalinkPort`: optional link creation for route repair and "open in provider" UX.
- `ProviderHistoryBackfillPort`: optional recovery/backfill, never required in the live hot path.
- `ProviderInstallMode`: official hosted app, local Socket Mode, own bot, OAuth bot token, app-level token, unified relay.
- `ProviderMessageMetadataPolicy`: declares what provider-visible metadata can contain. Slack metadata is not secret, so only opaque correlation ids are allowed.
- `ProviderControlPlaneClassifier`: handles `/teams`, `/sent`, setup, repair, pause and top-level selector messages before route delivery.

## Top 3 Architecture Options

1. Provider capability and strategy registry in contracts, with adapter-owned implementations.
   🎯 9   🛡️ 10   🧠 7   Approx 1200-2500 LOC.
   Recommended. Core stays stable, Telegram adapter owns private topics, Slack adapter owns App Home/root-thread behavior.

2. Keep Telegram-shaped core now and retrofit Slack later.
   🎯 5   🛡️ 5   🧠 3   Approx 300-700 LOC now, but likely 2500-5000 LOC of churn later.
   Fastest today, but it will leak `message_thread_id` semantics into routing, repair, UI and tests.

3. Build a generic plugin framework now.
   🎯 6   🛡️ 8   🧠 9   Approx 3000-6000 LOC.
   Technically flexible, but too heavy before Telegram MVP proves the core lifecycle.

## Extra Edge Cases

1. Home tab block limit.
   Slack Home tabs have a 100 block limit. For many Agent Teams, the Home tab must group, paginate or show only active/unresolved teams.

2. Thread history rate limits.
   Slack `conversations.replies` cannot be used as source of truth for every render. Use our local canonical store, with optional backfill.

3. Root message deleted.
   If the Slack root message disappears or `thread_not_found` appears, mark route generation as `repair_required`; do not recreate silently without user-visible repair state.

4. Top-level app DM ambiguity.
   Text outside a team thread must never route by newest team or recent activity. It is selector/control-plane traffic.

5. Teammate targeting ambiguity.
   A plain thread reply is not enough to target a specific teammate. Use explicit interaction or command.

6. Slack AI app tab naming.
   Slack docs note that enabling Agents & AI Apps can replace the Messages tab with Chat and History tabs. Our model must depend on route entrypoints and conversations, not literal UI tab labels.

7. Provider-visible metadata.
   Slack message metadata is visible to workspace members/apps with access. Store only opaque ids or hashes.

8. Hosted Slack ACK semantics.
   Slack HTTP Events want a fast 2xx, unlike the Telegram no-plaintext queue decision where desktop durable ACK gates provider ACK. Hosted Slack without a backend queue means the provider UX must be "accepted by Slack, later offline/status reply", not "Slack retry until desktop receives".

9. Socket Mode install complexity.
   Local Socket Mode is privacy-friendly, but the user must create/install a Slack app and provide bot/app tokens. This is an advanced privacy mode, not the easiest default.

10. Slack Connect and shared channels.
    For channel mode, `context_team_id`, `team_id`, `enterprise_id` and channel membership must be normalized. App DM default avoids most of this.

## Decision

Use this future Slack shape:

```text
Slack App Home Home tab = dashboard/control surface
Slack App Home Messages tab or app DM = private conversation container
One Slack root message per Agent Team
One Slack thread under that root message per Agent Team
Thread replies route to lead by default
Teammate routing requires explicit target selection
Top-level app-DM messages are selector/control-plane only
```

Core must introduce route entrypoint and surface abstractions now. Telegram private topics then become one adapter strategy, not the architecture.

## Sources

- Slack App Home: https://docs.slack.dev/surfaces/app-home/
- Slack messaging overview: https://docs.slack.dev/messaging/
- Slack `chat.postMessage`: https://docs.slack.dev/reference/methods/chat.postMessage/
- Slack `conversations.replies`: https://docs.slack.dev/reference/methods/conversations.replies/
- Slack `chat.getPermalink`: https://docs.slack.dev/reference/methods/chat.getPermalink/
- Slack Block Kit: https://docs.slack.dev/block-kit/
- Slack Events API: https://docs.slack.dev/apis/events-api/
- Slack Socket Mode: https://docs.slack.dev/apis/events-api/using-socket-mode/
- Slack request verification: https://docs.slack.dev/authentication/verifying-requests-from-slack/
