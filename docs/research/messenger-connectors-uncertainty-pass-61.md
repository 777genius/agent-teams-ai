# Messenger Connectors - Uncertainty Pass 61

Date: 2026-05-01
Scope: Slack future adapter research, Slack topics/threads model, provider-neutral route architecture, Clean Architecture ports

## Question

How should we design Telegram-first messenger connectors so Slack can be added later without core refactors?

Short answer:

```text
Do not make "topic" a core concept.
Make provider route identity an outer container plus optional provider subroute.
Telegram topic, Slack thread, Discord thread and WhatsApp DM are adapter mappings, not domain rules.
```

## Fresh Source Check

Official Slack facts:

- Slack uses `conversation` as a unified term for public channels, private channels, direct messages, group direct messages and shared channels.
- Conversation API methods are scope-filtered; public/private/DM access depends on granted scopes.
- Slack channel IDs can change in shared-channel situations, so names and IDs require repair/refresh policy.
- Slack conversation objects expose booleans such as `is_im`, `is_mpim`, `is_private`, `is_shared`, `is_ext_shared`, `is_non_threadable`, `is_thread_only`, `is_read_only`.
- Slack messages live inside conversations and are identified by `channel + ts`.
- Slack threads are rooted at a parent message timestamp. `chat.postMessage.thread_ts` posts a threaded reply and docs say to use the parent message `ts`, not a reply's `ts`.
- `conversations.replies` retrieves a thread and requires `channel + ts`.
- `chat.getPermalink` can generate a URL for a message and handles message threads and all conversation types.
- App Home has a Messages tab: a private app-user conversation using `chat:write`, `im:history`, and `message.im` events.
- Events API HTTP requests should be acknowledged with `HTTP 200 OK`; Slack retries failed events up to 3 times, roughly immediately, after 1 minute, and after 5 minutes.
- Slack may temporarily disable event delivery if more than 95 percent of delivery attempts fail within 60 minutes.
- Socket Mode uses WebSockets, requires event ack by `envelope_id`, can maintain up to 10 connections, and payload distribution across connections is unspecified.
- Socket Mode apps are not currently allowed in the public Slack Marketplace.
- `conversations.history` and `conversations.replies` have stricter 2025 limits for new non-Marketplace commercially distributed apps outside the Marketplace: 1 request/minute and limit 15.
- `chat.postMessage` generally allows about 1 message/sec per channel and returns `channel`, `ts`, and the message object.
- Slack message `metadata` can be posted with messages, but metadata is accessible to workspace members/apps that can access the message, so it is not a secret store.

Sources:

- https://docs.slack.dev/apis/web-api/using-the-conversations-api/
- https://docs.slack.dev/reference/objects/conversation-object/
- https://docs.slack.dev/messaging/
- https://docs.slack.dev/reference/methods/chat.postMessage/
- https://docs.slack.dev/reference/methods/conversations.replies/
- https://docs.slack.dev/reference/methods/conversations.history/
- https://docs.slack.dev/reference/methods/chat.getPermalink/
- https://docs.slack.dev/surfaces/app-home/
- https://docs.slack.dev/reference/events/message/
- https://docs.slack.dev/apis/events-api/
- https://docs.slack.dev/apis/events-api/using-socket-mode/
- https://docs.slack.dev/authentication/verifying-requests-from-slack/
- https://docs.slack.dev/authentication/installing-with-oauth
- https://docs.slack.dev/authentication/using-token-rotation

## Slack "Topic" Model

Slack has three different things that can look like "topics":

1. Channel topic metadata.
   Not a route identity. It is mutable human-readable metadata.

2. Threads.
   A thread is the closest Slack equivalent to "one place for a team conversation". It is rooted at a parent message `ts` inside a conversation.

3. Channels.
   A channel can be a team room, but it has heavier setup, visibility and membership concerns.

So:

```text
Telegram team topic ~= provider-native topic thread id
Slack team topic ~= thread rooted by parent message ts inside an App Home DM or channel
```

Do not use Slack channel topic text for routing.

## Best Slack Route Container Options

1. App Home Messages tab or app DM, one thread per Agent Team.
   🎯 8   🛡️ 9   🧠 7   Approx 2500-4500 LOC for future Slack adapter.
   Recommended future default. Private user-app space, minimal channel setup, one parent message per team, replies stay in that thread. Use Home tab as a team selector/status dashboard.

2. User-selected Slack channel, one thread per Agent Team.
   🎯 7   🛡️ 8   🧠 7   Approx 3000-5200 LOC.
   Good for workspace-visible collaboration. Requires app membership, channel permissions, stronger privacy warnings, channel repair, and admin/user expectation controls.

3. One Slack channel per Agent Team.
   🎯 6   🛡️ 7   🧠 8   Approx 4000-7000 LOC.
   Clear but heavy. Channel lifecycle, invites, private/public visibility, Slack Connect, archive/rename/permission changes become product complexity.

Recommendation:

```text
Use option 1 as future Slack default.
Support option 2 later as explicit advanced/team-shared mode.
Avoid option 3 until customers explicitly need it.
```

## Why App Home DM Thread Is The Best Fit

Strengths:

- private between user and app
- no need to invite app into every project channel
- one parent message per Agent Team can act like a "topic header"
- `thread_ts` is a durable subroute candidate
- `chat.getPermalink` can link back to the thread/message
- Home tab can show team list, health, unread counts and "open thread" actions

Weaknesses:

- Slack thread UX is not the same as Telegram topic list
- user may reply outside a team thread in the app DM
- no native per-child-message reply reference like Telegram `reply_to_message`
- history fetch is rate-limited, so local event persistence is mandatory
- App Home setup depends on Slack app settings and scopes

Practical UX:

```text
Home tab: team list, status, connect/repair controls
Messages tab/DM: one parent message per team
Thread replies: actual lead/team conversation
```

## Provider Route Address

Current docs already avoid Telegram-specific names, but Slack shows we need one more split:

```text
ProviderConversationKey = outer Slack/Telegram/Discord/WhatsApp container
ProviderSubrouteKey = optional provider-native topic/thread/selector state
ProviderRouteAddress = accountBindingId + provider + conversationKey + subrouteKey? + routeGeneration
```

Mappings:

```text
Telegram private topic:
  conversationKey = botUserId + chat_id
  subrouteKey = message_thread_id
  providerMessageKey = chat_id + message_thread_id + message_id
  replyReference = reply_to_message.message_id

Slack app DM thread:
  conversationKey = enterprise_id? + team_id + channel_id
  subrouteKey = thread_ts
  providerMessageKey = team_id + channel_id + ts
  replyReference = thread_ts only, not exact child message

Slack channel thread:
  conversationKey = enterprise_id? + team_id/context_team_id + channel_id
  subrouteKey = thread_ts
  providerMessageKey = team_id + channel_id + ts
  replyReference = thread_ts only

Discord thread:
  conversationKey = guild_id? + channel_id
  subrouteKey = thread channel_id when using Discord threads
  providerMessageKey = channel_id + message_id
  replyReference = message_reference when type is DEFAULT

WhatsApp:
  conversationKey = phone_number_id + contact wa_id
  subrouteKey = none
  providerMessageKey = message_id
  replyReference = context.message_id
```

Core route binding chooses team scope from `ProviderRouteAddress`.

Core teammate routing uses `ProviderReplyReference` only when the provider can prove an exact prior provider message. Slack thread replies do not prove exact teammate target by themselves.

## Slack Reply Semantics

Telegram can route a reply to a specific teammate if `reply_to_message.message_id` resolves through `ExternalMessageLink`.

Slack cannot reliably do the same with normal thread replies:

```text
Slack thread reply says "this belongs to thread parent".
It does not say "this replies to teammate message X" in a Telegram-style way.
```

So Slack default routing should be:

```text
message in team thread -> route to lead
interactive button/action selecting teammate -> route to teammate
explicit command/mention syntax -> route to teammate after parser confirmation
normal thread reply without explicit target -> route to lead with thread context
```

This means `ProviderCapabilities` must include:

```text
supportsExactReplyReference: boolean
supportsThreadSubroutes: boolean
supportsInteractiveTargetSelection: boolean
```

Provider matrix update:

```text
Telegram:
  exact reply reference: yes
  team subroute: message_thread_id
  teammate direct route: yes, when reply_to_message resolves

Slack:
  exact reply reference: no for normal thread replies
  team subroute: thread_ts
  teammate direct route: only explicit UI/control selection

Discord:
  exact reply reference: yes for message_reference DEFAULT
  team subroute: thread channel_id
  teammate direct route: yes, when message_reference resolves

WhatsApp:
  exact reply reference: yes for context.message_id
  team subroute: none
  teammate direct route: yes, when context.message_id resolves
```

## Slack Ingress Transport Options

1. Slack Socket Mode local/private app.
   🎯 8   🛡️ 8   🧠 8   Approx 3000-5500 LOC.
   Good privacy and desktop-local story. User/workspace must create/install Slack app with Socket Mode/app-level token. Not Marketplace-friendly.

2. Hosted official Slack app with Events API HTTP.
   🎯 8   🛡️ 8   🧠 9   Approx 4500-8000 LOC.
   Best UX for install via OAuth. Backend sees plaintext. Slack requires fast 200; reliable desktop delivery likely needs encrypted/durable queue or honest async status flow.

3. Slash command only plus response URLs.
   🎯 6   🛡️ 6   🧠 5   Approx 1800-3200 LOC.
   Useful narrow command UX, not a full ongoing conversation connector.

Recommendation:

```text
Future Slack MVP should probably start with official hosted Slack app if product wants easy install.
But architecture must also support Socket Mode as a privacy/enterprise mode.
Do not copy Telegram's webhook ACK model directly to Slack HTTP Events.
```

## Slack ACK Policy Difference

Telegram official relay can reasonably try:

```text
provider 2xx after desktop durable ACK, bounded retry
```

Slack HTTP Events cannot use the same default safely:

- Slack expects `HTTP 200 OK` quickly.
- Slack retries are documented at nearly immediate, 1 minute and 5 minutes.
- Slack marks events failed on responses outside 200-series and may disable delivery under high failure rate.
- HTTP timeout reason is defined as taking longer than 3 seconds.

So provider-neutral core needs:

```text
ProviderIngressAckPolicy
```

Examples:

```text
telegram_webhook:
  ackTarget = local_durable_prepare_or_terminal_before_dispatch
  boundedNon2xxAllowed = true

slack_http_events:
  ackTarget = backend_durable_admission
  localDesktopDelivery = async_after_ack unless durable queue is enabled
  non2xxOnlyForAuthOrMalformedOrIntentionalRetry

slack_socket_mode_local:
  ackTarget = local_durable_prepare
  envelopeAckRequired = true
```

Key decision:

```text
Do not bake Telegram ACK semantics into HandleProviderUpdateUseCase.
Make ACK policy provider-adapter driven.
```

## Slack Outbound Policy

Slack `chat.postMessage` returns `channel`, `ts`, and message object.

Provider message link:

```text
providerMessageKey = team_id + channel + ts
thread parent = thread_ts when present, else ts
```

Outbound send rules:

- use `thread_ts` for team-thread replies
- avoid `reply_broadcast` by default
- use `mrkdwn=false` or carefully escaped formatting for plain text MVP
- do not put secrets or raw internal IDs into Slack message metadata
- store returned `channel` and `ts` before marking outbox sent
- no blind retry after provider request started, same as Telegram
- honor channel-level rate limits around 1 message/sec/channel

Slack `metadata` can help correlate app-generated messages, but because metadata is accessible to workspace members/apps with message access:

```text
metadata may contain opaque HMAC correlation ids
metadata must not contain local paths, team secrets, raw outbox ids, message text, tokens, or provider payloads
```

## Slack History And Local Persistence

Do not rely on fetching Slack history as the hot path.

Reasons:

- `conversations.history` and `conversations.replies` are rate-limited.
- New non-Marketplace commercially distributed apps outside Marketplace have much tighter 2025 limits.
- Slack events already provide the hot path.

Use history only for:

- activation proof
- repair
- user-requested backfill
- permalink/link verification

Core remains the same:

```text
provider event -> normalized inbound -> local durable conversation row -> local UI history
```

## Clean Architecture Impact

SOLID interpretation:

- SRP: Slack adapter maps Slack transport/models only. Core use cases decide route and delivery.
- OCP: Add Slack by adding `SlackProviderAdapter`, not by editing Telegram route code.
- LSP: All provider adapters must obey the same normalized contracts and state machine semantics.
- ISP: Split ports by capability so Slack does not implement Telegram topic methods.
- DIP: Core depends on `ProviderEventIngestPort`, `ProviderOutboundPort`, `ProviderRouteCapabilityPort`, not Slack SDKs.

Suggested provider adapter shape:

```text
ProviderAdapterDescriptor {
  providerId
  capabilities
  ingressAckPolicy
  routeContainerStrategies
  normalizeInbound(raw)
  extractRouteAddress(normalized)
  extractReplyReference(normalized)
  buildOutboundRequest(intent)
  classifySendResult(resultOrError)
  getPermalink(messageKey)
}
```

Suggested ports:

```text
ProviderEventIngressPort
ProviderOutboundPort
ProviderHistoryPort
ProviderPermalinkPort
ProviderCapabilityProbePort
ProviderTokenVaultPort
ProviderRateLimitPort
ProviderRouteRepairPort
```

Do not create:

```text
TelegramTopicService in core
SlackThreadService in core
if provider === "telegram" branches in use cases
provider-specific DTOs in renderer state
```

## TypeScript Slack Library Notes

Fresh npm checks on 2026-05-01:

```text
@slack/bolt latest 4.7.2, MIT, modified 2026-04-30
@slack/web-api latest 7.15.1, MIT, modified 2026-04-20
@slack/socket-mode latest 2.0.7, MIT, modified 2026-04-30
@slack/types latest 2.20.1, MIT, modified 2026-04-20
```

Recommendation:

- use `@slack/web-api` for outbound Web API calls
- use `@slack/socket-mode` or Bolt Socket Mode only in Slack adapter infrastructure, not core
- consider Bolt for hosted backend app if it owns Events API/OAuth complexity
- use `@slack/types` for adapter typing if it does not pull unwanted runtime weight

No dependency was installed in this pass.

## Architecture Decisions To Add Now

1. Rename mental model from `topic` to `route container/subroute` in core docs.
   🎯 9   🛡️ 10   🧠 4   Approx 300-700 LOC in future code, small docs change now.

2. Add provider capability matrix with exact reply reference vs thread-only reference.
   🎯 9   🛡️ 10   🧠 4   Approx 300-800 LOC in future code.

3. Add provider ingress ACK policy abstraction.
   🎯 8   🛡️ 10   🧠 7   Approx 800-1800 LOC in future code.

Recommendation:

```text
Do all three before implementing Telegram deeply.
They prevent Telegram-specific assumptions from becoming architectural debt.
```

## Open Risks

1. Slack thread UX as a Telegram topic replacement.
   🎯 7   🛡️ 8   🧠 6
   Needs prototype. Threads work technically, but user discoverability may need Home tab selector and "Open team thread" buttons.

2. Slack HTTP Events without plaintext queue.
   🎯 6   🛡️ 7   🧠 9
   Easy install conflicts with reliable desktop-local delivery. Hosted Slack probably needs encrypted queue or async status semantics.

3. Slack teammate routing.
   🎯 7   🛡️ 8   🧠 7
   Normal thread replies do not prove exact teammate target. Need interactive target controls or explicit syntax.

4. Slack Connect and channel ID changes.
   🎯 7   🛡️ 8   🧠 7
   Store workspace/context/team metadata and implement route refresh/tombstone policy.

5. Slack rate limits for history.
   🎯 8   🛡️ 9   🧠 5
   Do not rely on `conversations.replies` for live history. Persist local event history.

## Recommendation

Keep Telegram as MVP, but make the core Slack-ready now:

```text
ProviderRouteAddress = conversationKey + optional subrouteKey + routeGeneration
ProviderCapabilities says whether exact reply references exist
ProviderIngressAckPolicy differs per transport
Provider adapters own transport, auth, rate limits, provider DTOs and provider-specific repair
Core owns route decisions, delivery state, idempotency, outbox state and local visibility policy
```

This keeps Clean Architecture intact and avoids rewriting core when Slack arrives.
