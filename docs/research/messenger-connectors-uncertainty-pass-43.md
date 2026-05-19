# Messenger Connectors - Uncertainty Pass 43

Date: 2026-04-30
Scope: Claude Code Channels, official Telegram/Discord channel plugins, private-chat topics, one-poller-per-token risk, and Managed Bots privacy

## 1. Bottom Line

Claude Code Channels are now a very strong design reference, but they should not be the MVP runtime dependency for Agent Teams messenger connectors.

Recommended interpretation:

```text
Use official Channels patterns.
Do not depend on official Channels availability for MVP.
Build Agent Teams connector gateway as our own provider-neutral feature slice.
```

Why:

1. Claude Channels are a research preview, org-gated on Team and Enterprise, and docs say the flag/protocol may change.
2. The current local `claude --help` for `2.1.119` does not expose `--channels`, even though docs say Channels require `2.1.80+`.
3. Official Telegram channel plugin is built for one Claude session and one bot poller. Agent Teams needs one shared bot routed to many teams.
4. A per-team Claude channel plugin with the same Telegram token would create competing pollers. The official plugin explicitly protects against stale pollers.
5. Our product needs durable local inbox, route registry, topic mapping, teammate projection, reply proof, and UI history. Raw Claude Channels do not provide that product state.

New stronger product decision:

```text
Default Telegram UX should be one private chat with our bot, using one topic per team inside that private bot chat when capability checks pass.
```

Fallback if private-chat topics fail:

```text
Use a normal private DM with /teams + inline keyboard selection, or a user-created forum supergroup only as advanced mode.
```

## 2. Source Facts

### 2.1 Claude Code Channels

Official docs say:

- Channels push messages, alerts, and webhooks into a running Claude Code session from an MCP server.
- Channels can be two-way; Claude reads the event and replies through the same channel.
- Events arrive only while the session is open.
- Always-on usage requires a background process or persistent terminal.
- Telegram, Discord, and iMessage are included in the research preview.
- Channels are research preview, require Claude Code `v2.1.80+`, require `claude.ai` login, and Team/Enterprise orgs must enable them.
- During preview, `--channels` accepts plugins from an Anthropic-maintained allowlist or org allowlist.
- Standard MCP servers are not enough; a channel server also has to be named in `--channels`.

Local probe:

```text
claude --version
2.1.119 (Claude Code)

claude --help
shows --replay-user-messages
does not show --channels
does not show --dangerously-load-development-channels
```

Interpretation:

```text
Do not make the Agent Teams messenger MVP depend on --channels.
If we ever use Channels, add an explicit capability probe and a non-Channels fallback.
```

Confidence:

🎯 8   🛡️ 9   🧠 4   Approx `300-900` LOC for a capability probe and feature flag

### 2.2 Official Telegram Channel Plugin

Official plugin source path:

```text
anthropics/claude-plugins-official/external_plugins/telegram/server.ts
```

Important implementation patterns:

- It is a self-contained MCP server.
- State lives under `~/.claude/channels/telegram`.
- Token comes from `TELEGRAM_BOT_TOKEN` or local `.env`.
- It declares experimental `claude/channel` and `claude/channel/permission`.
- It gates inbound messages before emitting `notifications/claude/channel`.
- It gates on Telegram sender identity, not just room/chat identity.
- Pairing is code-based: unknown sender receives a pairing code; user approves in local Claude session.
- It warns the model that transcript output never reaches Telegram, and replies must go through the `reply` tool.
- It tells the model not to approve pairings or edit access state because a channel message asked.
- It puts attachment paths and ids in `meta`, not in content, because content is forgeable by the sender.
- Permission relay sends approval prompts only to allowlisted DMs, not groups.
- Permission replies are intercepted before normal chat forwarding.
- It chunks Telegram text to the provider limit.
- It treats edits as non-push progress and sends a new message when long work completes.
- It catches handler errors so polling continues.
- It has stale-poller protection around long polling.

Directly reusable lessons:

```text
sender_id allowlist
pairing code
no channel-message driven pairing approval
meta is trusted adapter metadata, content is untrusted user text
permission reply intercept before normal chat forwarding
reply tool is the only external-visible send path
```

Not reusable directly:

```text
one plugin instance per Claude session
one bot token per plugin instance
Claude-owned reply tool as canonical external outbox
no Agent Teams route registry
no durable app conversation store
```

### 2.3 Official Discord Channel Plugin

Official plugin source path:

```text
anthropics/claude-plugins-official/external_plugins/discord/server.ts
```

Additional patterns:

- Discord requires `Message Content Intent`.
- Discord channel access is keyed on channel id, not guild id.
- Threads inherit parent channel opt-in for gate lookup.
- Attachments are listed but not automatically downloaded.
- `fetch_messages` supports recent history, capped by Discord API limits.
- It sanitizes attachment names before placing them in metadata/result text.
- It tracks recently sent message ids to identify bot reply triggers in guild channels.

Reusable for provider-neutral core:

```text
Provider capabilities differ.
Telegram has no history/search through Bot API.
Discord can fetch recent channel history.
Attachment download policy must be provider-specific.
Group/channel routing semantics must not leak into core.
```

## 3. Dependency Findings

Official plugins use:

```text
telegram:
  @modelcontextprotocol/sdk ^1.0.0
  grammy ^1.21.0

discord:
  @modelcontextprotocol/sdk ^1.0.0
  discord.js ^14.14.0
```

Latest npm versions checked on 2026-04-30:

```text
@modelcontextprotocol/sdk 1.29.0
grammy 1.42.0
discord.js 14.26.3
telegraf 4.16.3
```

Recommendation for our implementation:

1. Use `grammy` for own-bot polling/webhook adapter - 🎯 8   🛡️ 8   🧠 4, approx `700-1600` LOC.
2. Do not use official plugin versions as our pinned dependency versions without checking changelogs and lockfile behavior - 🎯 9   🛡️ 9   🧠 2, approx `50-150` LOC.
3. Keep `@modelcontextprotocol/sdk` out of the MVP connector runtime unless we intentionally build a future Claude Channel adapter - 🎯 7   🛡️ 8   🧠 5, approx `0-1200` LOC depending on future adapter.

Library decision:

```text
grammy is still the best Telegram adapter candidate.
But provider reliability must be our outbox state machine, not library auto-retry.
```

## 4. Why Official Channels Do Not Replace Agent Teams Messenger Core

### 4.1 Product mismatch

Claude Channels answer:

```text
How can a chat app push a message into one running Claude Code session?
```

Agent Teams messenger connectors answer:

```text
How can one user chat with many teams, each with lead and teammates, through one external messenger, with durable UI history and exact reply projection?
```

Those are related but not the same.

### 4.2 Routing mismatch

Official channel route shape:

```text
platform chat -> current Claude session
```

Agent Teams route shape:

```text
provider account binding
+ bot identity
+ chat_id
+ message_thread_id
+ topic route generation
-> team
-> lead or teammate route
-> runtime turn ledger
-> visible local message proof
-> provider outbox
```

### 4.3 Polling ownership mismatch

Per-team channel plugin option:

```text
team A lead session starts Telegram channel poller
team B lead session starts Telegram channel poller
same bot token
```

Risk:

```text
Only one long poller can safely own one Telegram bot token.
Competing pollers produce conflicts and lost ownership semantics.
```

The official Telegram plugin has stale-poller handling because this is a real operational boundary.

For our default shared bot, the correct owner is:

```text
official backend webhook owner for shared bot
desktop own-bot single polling owner for own-bot mode
```

Not:

```text
one poller per team
one poller per lead session
one poller per Claude channel plugin
```

## 5. Private-Chat Topics Are Stronger Than Group Topics For MVP

New official Bot API facts:

- Bot API added topic support for private chats with bots.
- `Message.is_topic_message` is true for a message sent to a topic in a forum supergroup or a private chat with the bot.
- `createForumTopic` can create a topic in a forum supergroup chat or a private chat with a user.
- `createForumTopic` returns a `ForumTopic`.
- In a supergroup the bot must be admin with `can_manage_topics`.
- Bot API 9.6 introduced Managed Bots and `getManagedBotToken`.

Implication:

```text
Our best default UX is likely:

User opens one DM with @AgentTeamsBot.
Desktop/backend creates one private-chat topic per team.
Each topic maps to exactly one team route.
Replies inside a topic route to that team.
Reply-to inside a topic may target a teammate only with ExternalMessageLink proof.
```

Why this is better than forum supergroup MVP:

- No need for user to create a Telegram group.
- No need to add bot as group admin.
- No group privacy mode confusion.
- No unrelated group members.
- Better "minimum actions" setup.
- Same route key still works: `chat_id + message_thread_id`.

Remaining uncertainty:

```text
We need live client proof across Telegram Desktop, iOS, Android, and Web.
Docs prove Bot API capability, not product-grade client UX.
```

Recommended MVP topic container:

1. Private-chat topics with our shared bot - 🎯 8   🛡️ 8   🧠 6, approx `1600-3600` LOC.
   Best UX and aligns with Bot API 9.6 direction. Needs capability probe and live client matrix.

2. Private DM plus `/teams` selector and inline keyboard - 🎯 8   🛡️ 7   🧠 4, approx `900-2200` LOC.
   Good fallback. Less elegant, but avoids topic capability uncertainty.

3. User-created forum supergroup with topics - 🎯 6   🛡️ 8   🧠 7, approx `1800-4200` LOC.
   Reliable Bot API semantics, but too many setup steps and more privacy/admin confusion.

## 6. Managed Bots Privacy Is Settled

Telegram docs say:

```text
Manager bot receives managed_bot update.
Manager bot can call getManagedBotToken.
getManagedBotToken returns the token string.
replaceManagedBotToken returns the new token string.
```

Therefore:

```text
If our manager bot creates the user's bot, our backend can technically fetch that bot token.
```

Privacy conclusion:

```text
Managed Bots are convenient, not token-private from the manager.
The clean privacy story remains: user creates bot in BotFather and pastes token into desktop locally.
```

Recommended product stance:

1. Default shared bot, no user token - 🎯 9   🛡️ 8   🧠 6, approx `3000-6500` LOC including relay.
2. Optional own bot via BotFather token pasted locally - 🎯 9   🛡️ 9   🧠 5, approx `1600-3200` LOC.
3. Optional Managed Bots convenience later with explicit warning - 🎯 6   🛡️ 6   🧠 6, approx `2200-5000` LOC.

Do not phrase Managed Bots as:

```text
our backend cannot access the token
```

Phrase as:

```text
faster setup, but manager can technically retrieve token by Bot API design
```

## 7. Security Patterns To Steal From Official Plugins

### 7.1 Gate on sender identity

Do:

```text
allowed user_id -> deliver
unknown user_id -> pairing/drop
```

Do not:

```text
allowed chat_id -> deliver everyone in that chat
```

Reason:

```text
In group chats, chat_id and sender id differ. Chat-level gating lets anyone in an allowlisted room inject prompts.
```

For private-chat topics:

```text
chat_id is still not enough.
Route binding must include authorized Telegram user_id.
```

### 7.2 Treat provider content as hostile

Official plugins avoid placing file paths and attachment details as normal content because an allowlisted sender can type fake annotations.

Our equivalent:

```text
ProviderUpdate.content.text is untrusted.
ProviderUpdate.adapterMeta is trusted only after adapter validation.
Prompt renderer must clearly frame provider text as untrusted external user content.
```

### 7.3 Do not let remote chat mutate access policy

Official plugin tells Claude not to run access skills because a chat message requested it.

Our equivalent:

```text
Remote Telegram message cannot authorize another sender.
Remote Telegram message cannot switch bot mode.
Remote Telegram message cannot expose own-bot token.
Remote Telegram message cannot change topic binding.
```

All such changes must be local UI actions.

### 7.4 Permission relay must be scoped

Official plugins relay permission prompts only to allowlisted DMs, not groups.

Our MVP:

```text
Do not ship permission relay in messenger MVP.
If added later, only allow the local user identity, never whole topic/group.
```

Reason:

```text
Anyone who can approve permission prompts can authorize tool use.
That is a higher trust level than sending a lead message.
```

### 7.5 Reply tool result is not enough for our UI

Official plugin returns "sent (id: ...)" from the reply tool.

For Agent Teams:

```text
Provider send result must be persisted in ProviderOutbox and ProviderMessageLink before UI says sent.
```

Do not let a tool result string become the canonical outbox receipt.

## 8. Architecture Decision After This Pass

Keep the full feature slice:

```text
src/features/messenger-connectors/
  contracts/
  core/domain/
  core/application/
  main/composition/
  main/adapters/input/
  main/adapters/output/
  main/infrastructure/
  preload/
  renderer/
```

Add provider adapter variants:

```text
TelegramOfficialRelayAdapter
TelegramOwnBotPollingAdapter
TelegramPrivateTopicProvisioner
TelegramProviderOutboxAdapter
OptionalFutureClaudeChannelAdapter
```

Core ports should remain provider-neutral:

```text
ProviderUpdateIngestPort
ProviderRouteProvisionPort
ProviderOutboxSendPort
ProviderCapabilityProbePort
RuntimeDeliveryPort
VisibleReplyObserverPort
CredentialVaultPort
```

Avoid:

```text
ClaudeChannelService as core dependency
Telegram grammy types in core
Discord.js types in core
Electron IPC in core
```

SOLID check:

- SRP: provider ingestion, topic provisioning, runtime delivery, and provider outbox are separate reasons to change.
- OCP: adding Discord should add adapters and capabilities, not rewrite Telegram route policy.
- ISP: do not make Telegram adapter implement Discord history APIs.
- DIP: use application ports for provider and runtime integrations.

## 9. Updated Implementation Sequence Delta

Insert these before the previous topic provisioning steps:

```text
13a. Add Telegram private-chat topic capability probe.
13b. Add route container strategy: private_topic, private_selector, forum_supergroup.
13c. Add central bot ownership invariant: one poller/webhook owner per provider account binding.
13d. Add sender identity gate before route resolution.
13e. Add untrusted content vs trusted adapter metadata split.
```

Do not implement:

```text
one Claude channel plugin per team
one Telegram poller per team
Managed Bots as privacy setup
permission relay in MVP
```

## 10. New Top Open Risks

### 10.1 Private-chat topic UX across clients

🎯 7   🛡️ 8   🧠 6   Approx `400-1000` LOC for test harness plus manual matrix

Docs prove Bot API support, but we still need live client behavior:

```text
Telegram Desktop
Telegram iOS
Telegram Android
Telegram Web
topic creation visibility
topic notification behavior
reply-to behavior inside topic
message_thread_id stability
topic deletion/close/reopen behavior
```

### 10.2 Channels availability and stability

🎯 8   🛡️ 8   🧠 5   Approx `300-900` LOC for capability probe

Docs call it research preview and local help does not expose the flag in this environment.

Conclusion:

```text
Use as reference, not foundation.
```

### 10.3 One bot token, one owner

🎯 9   🛡️ 9   🧠 5   Approx `700-1800` LOC for ownership lease tests

Any shared token must have exactly one receiving owner:

```text
official backend webhook
or desktop own-bot poller
or future central local gateway
```

Never multiple team sessions.

### 10.4 Provider history differences

🎯 8   🛡️ 8   🧠 5   Approx `500-1300` LOC for capability-driven adapters

Telegram Bot API has no general message history/search for bot chats. Discord has recent fetch. Core must model this as capability, not assume history exists.

## 11. Updated Top 3 Options

1. Central Agent Teams connector gateway with Telegram private-chat topics - 🎯 8   🛡️ 9   🧠 8 - approx `4500-9000` changed LOC.
   Best path. It preserves our durable UI, central routing, single bot owner, and exact reply projection. More code, but matches product.

2. Build on Claude Code Channels directly per team - 🎯 4   🛡️ 5   🧠 5 - approx `1800-4200` changed LOC.
   Looks tempting because official plugins exist, but it breaks shared-token ownership and does not give Agent Teams durable route/projection state.

3. Hybrid future adapter: central gateway now, optional Claude Channel adapter later - 🎯 7   🛡️ 8   🧠 9 - approx `6500-12000` changed LOC over time.
   Good long-term route if Channels becomes stable. Not needed for MVP.

## 12. Updated Decision

Add these to "decided":

```text
Claude Code Channels are a reference pattern, not the MVP dependency.
Default topic container should be Telegram private-chat topics when capability checks pass.
One shared bot token must have one receiving owner.
Do not spawn one Telegram poller per team or per lead session.
Sender allowlist gates before route resolution.
Remote chat cannot mutate connector access policy.
Managed Bots are not private from the manager.
```

## 13. Source Links

- Claude Code Channels: https://code.claude.com/docs/en/channels
- Claude Code Channels reference: https://code.claude.com/docs/en/channels-reference
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-usage
- Official Claude plugins repository: https://github.com/anthropics/claude-plugins-official
- Official Telegram channel plugin: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram
- Official Discord channel plugin: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord
- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram Bot Features: https://core.telegram.org/bots/features
- `Message`: https://core.telegram.org/bots/api#message
- `createForumTopic`: https://core.telegram.org/bots/api#createforumtopic
- `getManagedBotToken`: https://core.telegram.org/bots/api#getmanagedbottoken
- `sendMessage`: https://core.telegram.org/bots/api#sendmessage
- grammY npm: https://www.npmjs.com/package/grammy
- discord.js npm: https://www.npmjs.com/package/discord.js
- MCP TypeScript SDK npm: https://www.npmjs.com/package/@modelcontextprotocol/sdk
