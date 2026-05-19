# Messenger Connectors Research Summary

Last updated: 2026-05-16
Status: living summary for the Telegram-first messenger connectors feature

Use this file as the short context entrypoint. Detailed research remains in:

- `docs/messenger-connectors-architecture.md`
- `docs/research/messenger-connectors-uncertainty-pass-36.md`
- `docs/research/messenger-connectors-uncertainty-pass-37.md`
- `docs/research/messenger-connectors-uncertainty-pass-38.md`
- `docs/research/messenger-connectors-uncertainty-pass-39.md`
- `docs/research/messenger-connectors-uncertainty-pass-40.md`
- `docs/research/messenger-connectors-uncertainty-pass-41.md`
- `docs/research/messenger-connectors-uncertainty-pass-42.md`
- `docs/research/messenger-connectors-uncertainty-pass-43.md`
- `docs/research/messenger-connectors-uncertainty-pass-44.md`
- `docs/research/messenger-connectors-uncertainty-pass-45.md`
- `docs/research/messenger-connectors-uncertainty-pass-46.md`
- `docs/research/messenger-connectors-uncertainty-pass-47.md`
- `docs/research/messenger-connectors-uncertainty-pass-48.md`
- `docs/research/messenger-connectors-uncertainty-pass-49.md`
- `docs/research/messenger-connectors-uncertainty-pass-50.md`
- `docs/research/messenger-connectors-uncertainty-pass-51.md`
- `docs/research/messenger-connectors-uncertainty-pass-52.md`
- `docs/research/messenger-connectors-uncertainty-pass-53.md`
- `docs/research/messenger-connectors-uncertainty-pass-54.md`
- `docs/research/messenger-connectors-uncertainty-pass-55.md`
- `docs/research/messenger-connectors-uncertainty-pass-56.md`
- `docs/research/messenger-connectors-uncertainty-pass-57.md`
- `docs/research/messenger-connectors-uncertainty-pass-58.md`
- `docs/research/messenger-connectors-uncertainty-pass-59.md`
- `docs/research/messenger-connectors-uncertainty-pass-60.md`
- `docs/research/messenger-connectors-uncertainty-pass-61.md`
- `docs/research/messenger-connectors-uncertainty-pass-62.md`
- `docs/research/messenger-connectors-uncertainty-pass-63.md`
- `docs/research/messenger-connectors-uncertainty-pass-64.md`
- `docs/research/messenger-connectors-uncertainty-pass-65.md`
- `docs/research/messenger-connectors-uncertainty-pass-66.md`
- `docs/research/messenger-connectors-uncertainty-pass-67.md`
- `docs/research/messenger-connectors-uncertainty-pass-68.md`
- `docs/research/messenger-connectors-uncertainty-pass-69.md`
- `docs/research/messenger-connectors-uncertainty-pass-70.md`
- `docs/research/messenger-connectors-uncertainty-pass-71.md`
- `docs/research/messenger-connectors-uncertainty-pass-72.md`
- `docs/research/messenger-connectors-uncertainty-pass-73.md`
- `docs/research/messenger-connectors-uncertainty-pass-74.md`
- `docs/research/messenger-connectors-uncertainty-pass-75.md`
- `docs/research/messenger-connectors-uncertainty-pass-76.md`
- `docs/research/messenger-connectors-uncertainty-pass-77.md`
- `docs/research/messenger-connectors-uncertainty-pass-78.md`
- `docs/research/messenger-connectors-uncertainty-pass-79.md`
- `docs/research/messenger-connectors-uncertainty-pass-80.md`
- `docs/research/messenger-connectors-uncertainty-pass-81.md`
- `docs/research/messenger-connectors-uncertainty-pass-82.md`
- `docs/research/messenger-connectors-uncertainty-pass-83.md`
- `docs/research/messenger-connectors-uncertainty-pass-84.md`
- `docs/research/messenger-connectors-uncertainty-pass-85.md`
- `docs/research/messenger-connectors-uncertainty-pass-86.md`
- `docs/research/messenger-connectors-uncertainty-pass-87.md`
- `docs/research/messenger-connectors-uncertainty-pass-88.md`
- `docs/research/messenger-connectors-uncertainty-pass-89.md`
- `docs/research/messenger-connectors-uncertainty-pass-90.md`
- `docs/research/messenger-connectors-uncertainty-pass-91.md`
- `docs/research/messenger-connectors-uncertainty-pass-92.md`
- `docs/research/messenger-connectors-uncertainty-pass-93.md`

Canonical note:

- This summary plus the top "Final Product Decision" and "Current implementation bridge" blocks in `docs/messenger-connectors-architecture.md` are current.
- Detailed research passes are historical working notes. If an older pass conflicts with this summary, use the latest summary decision and current port map.
- Older reply-capture notes that allow plain assistant text fallback are superseded for provider auto-send. MVP provider outbox requires `ExternalReplyProjectionIntent` with exact proof.
- Older storage notes that prefer a single JSON object, event-log store or NDJSON WAL default are implementation explorations. MVP storage is one logical `MessengerStateStorePort` plus `MessengerUnitOfWork`, backed by feature-owned file-locked versioned JSON physical tables. `VersionedJsonStore` and `JsonMemberWorkSyncStore` are reference patterns, not domain dependencies.
- Older Telegram SDK notes that recommend full grammY runtime, grammY-owned polling or grammY-owned send retries are superseded for MVP. MVP owns ACK, offset and outbox retry boundaries with raw `fetch` plus `@grammyjs/types`.
- Older topic-default notes should be read as "private topics are preferred only after capability, fixture and activation proof; selector mode is mandatory fallback".
- Older MCP `message_send` notes that describe the controller store as lacking atomic writes are partially outdated. Fresh code has `atomicFile`, exact `lookupMessage` and same-text `runtime_delivery` dedupe, but provider auto-send still requires connector proof ledger commit before `ExternalReplyProjectionIntent`.

## Product Decision

Build `messenger-connectors` as a full feature slice.

Default:

- Official shared Agent Teams Telegram bot.
- One Telegram private-chat topic per Agent Teams team only when capability checks, mutation policy, per-team activation proof and live client compatibility pass.
- Fallback route container: private DM with `/teams` selector; advanced forum supergroup remains a later explicit setup option, not MVP default fallback.
- No plaintext backend queue in MVP.
- If desktop is offline, bot replies honestly that desktop is offline.
- If desktop is online but a team is not deliverable, bot replies with precise local status.
- Backend may see plaintext transiently in webhook handling, but must not persist plaintext or log it.
- Backend may also see outbound plaintext transiently in official shared bot send proxy handling, but must not persist or queue it.
- If backend already dispatched plaintext to desktop and ACK is missing, do not reply "offline" for that provider update. Mark ambiguous ownership and let Telegram retry.
- ACK-missing retry is bounded in shared bot mode: after a small retry budget, send a truthful `delivery_unconfirmed` status and return 2xx to avoid poisoning the shared bot backlog.
- Telegram private-chat topics remain preferred, but they are default only after account capability proof, per-team activation proof, and live client compatibility evidence.
- Provider auto-send requires exact reply proof. Plain assistant text is local/manual-review only in MVP.
- Durable local messenger state uses one logical store/unit-of-work boundary. Feature-owned file-locked versioned JSON tables are an adapter detail; SQLite/NDJSON WAL are later adapters, not MVP defaults.

Optional privacy mode:

- User can connect their own Telegram bot token from BotFather.
- Own-bot token is stored locally using encrypted desktop storage.
- Desktop app uses `getUpdates` long polling for own-bot mode.
- Our backend never receives own-bot token or own-bot messages.

Managed Bots:

- Do not use as the privacy path.
- Telegram `getManagedBotToken` returns the token string to the manager bot.
- Managed Bots can be a future convenience flow only with a clear privacy warning.

## Current Recommended Architecture

Use a provider-neutral feature slice:

```text
src/features/messenger-connectors/
  contracts/
  core/
    domain/
    application/
  main/
    composition/
    adapters/
      input/
      output/
    infrastructure/
  preload/
  renderer/
```

Core owns:

- route decisions
- runtime turn state machine
- reply correlation policy
- external visibility policy
- text chunking policy
- provider outbox state machine
- durable conversation identity

Core must not own provider nouns such as Telegram topic, Slack thread, Discord thread or WhatsApp contact.
Use provider-neutral route identity and lifecycle:

```text
ExternalConversationKey = outer provider container
ProviderSubrouteKey = optional provider-native topic/thread/selector state
MessengerConnectionId = app-owned opaque connected provider account id, exposed as connectionId
TeamRouteBindingId = app-owned opaque team route id, exposed as teamRouteId
RouteGeneration = monotonically increasing generation for repair/reprovision
RelaySessionId = cloud relay stream/websocket session id, never exposed as connectionId
DeviceLeaseId = cloud relay lease granting one desktop permission to receive plaintext transiently
ProviderRouteAddress = messengerConnectionId + provider + conversationKey + subrouteKey? + routeGeneration
RouteEntryPointProvisioningPlan = provider-neutral route-container plan and fallback choice
RouteEntryPointProvisioningAttempt = durable provider mutation/provision attempt and result boundary
ExternalRouteEntryPoint = provider-visible root object for a route
RouteActivationProof = durable proof that this route generation is safe to use
TeamRouteBinding = TeamRouteBindingId + MessengerConnectionId + teamIdentityId + active ProviderRouteAddress/ExternalRouteEntryPoint + lifecycle
```

Use provider-neutral message/reply identity:

```text
ExternalMessageKey = provider message identity
ProviderReplyReference = optional pointer from current provider message to an older provider message
ExternalReplyTargetResolution = resolved target from ProviderReplyReference + ExternalMessageLink lookup
ExternalMessageLink = durable provider message <-> internal message/target link
ProviderControlPlaneDecision = pre-routing setup/repair/status/callback decision
MessengerRouteDecision = durable final route/control outcome plus reason
ProviderSendAttempt = durable provider request attempt and request_started boundary
ProviderSendResult = normalized provider send result or unknown state
ProviderDeliveryResolution = durable post-send outcome and next action
MessengerManualResolutionTask = explicit user/support action for ambiguous provider delivery
```

Pass 61 Slack-ready route mapping:

```text
Telegram private topic:
  conversationKey = botUserId + chat_id
  subrouteKey = message_thread_id

Slack app DM thread:
  conversationKey = enterprise_id? + team_id + channel_id
  subrouteKey = thread_ts

Slack channel thread:
  conversationKey = enterprise_id? + team_id/context_team_id + channel_id
  subrouteKey = thread_ts

WhatsApp:
  conversationKey = phone_number_id + contact wa_id
  subrouteKey = none
```

Provider adapters must declare capabilities:

```text
providerSurfaces
routeEntryPointKinds
supportsExactReplyReference
supportsThreadSubroutes
supportsInteractiveTargetSelection
ingressAckPolicy
formattingProfile
rateLimitPolicy
navigationCapabilities
historyBackfillPolicy
```

Main adapters own:

- Telegram webhook/long-poll adapters
- official relay transport
- official relay ACK client
- own-bot polling transport
- local TeamProvisioningService bridge
- native and OpenCode visible reply observers
- file-backed stores
- credential vault adapter

Fresh source alignment checked on 2026-05-16 against `dev` commit `2beb4dae`:

- The current feature standard and `src/features/CLAUDE.md` both confirm `src/features/messenger-connectors/` as the right home for this feature.
- The existing Fastify `HttpServer` is still the correct HTTP-first local app API boundary.
- Sensitive messenger routes still need feature-local Host, Origin, local session and CSRF checks because global CORS can be permissive in standalone mode.
- `recent-projects` remains the small HTTP adapter reference.
- `member-work-sync` is now the strongest fresh reference for a large cross-process feature composition root and a feature-owned file-locked JSON store.
- Messenger should copy the storage pattern behind its own `MessengerStateStorePort`; it should not couple core or repositories to `member-work-sync`.
- MCP `message_send` already exposes `relayOfMessageId` and returns a stop-after-delivery instruction, so it remains the intended reply action for exact Telegram auto-replies.
- Controller message storage has improved: atomic writes, exact `lookupMessage`, ambiguity rejection and same-text `runtime_delivery` dedupe are present.
- Controller message storage is still not the final proof boundary: no explicit MCP `messageId`/`idempotencyKey`, no controller-level file lock/readback verification on message writes, no terminal conflict for same `relayOfMessageId` with different text, and `TeamDataService.sendMessage()` still drops `relayOfMessageId` when calling the controller.
- `origin/dev` at `bfad861b` starts the Agent Teams MCP HTTP server for the OpenCode bridge by default and falls back to command-launch env if needed. This improves OpenCode `message_send` availability but does not remove the need for runtime capability evidence.
- `origin/dev` removed the `native_stale_in_progress` member-work-sync bypass, reinforcing that non-OpenCode/native runtime delivery must stay behind explicit capability/proof gates.
- `origin/dev` package changes do not add Telegram SDK, `zod`, SQLite, Redis, BullMQ, Bottleneck or `fast-check` to the desktop package.
- Rechecked after a new `git fetch origin dev` on 2026-05-16: `origin/dev` is still `bfad861b`; no new messenger-relevant code drift was found in HTTP registration, MCP `message_send`, controller message storage, `TeamDataService.sendMessage()`, feature standards or reference feature stores.

Renderer owns:

- connection wizard
- route/topic status
- health and repair UI
- manual review UI for unresolved replies

## Coherence Map

The feature hangs together through this chain:

```text
MessengerConnection
  -> ProviderCapabilities
  -> ProviderSurfaceModel
  -> RouteEntryPointProvisioningPlan
  -> RouteEntryPointProvisioningAttempt
  -> ExternalRouteEntryPoint
  -> ProviderRouteAddress
  -> RouteActivationProof
  -> TeamRouteBinding
  -> ProviderReplyReference
  -> ExternalReplyTargetResolution
  -> MessengerRouteDecision
  -> MessengerConversationEntry
  -> ExternalMessageLink
  -> MessengerRuntimeTurnLedger
  -> ExternalReplyProjectionIntent
  -> ProviderOutboxItem
  -> ProviderSendAttempt
  -> ProviderSendResult
  -> ProviderDeliveryResolution
```

Control-plane side branch:

```text
ProviderControlPlaneDecision
  -> durable control-plane effect/status
  -> stop before MessengerRuntimeTurnLedger unless the decision explicitly creates a status response
```

Manual-resolution side branch:

```text
ProviderDeliveryResolution
  -> MessengerManualResolutionTask when explicit user/support decision is needed
  -> new ProviderDeliveryResolution after action
```

Meaning:

- `MessengerConnection` is the installed provider account, bot mode and transport identity.
- `MessengerConnectionId` is the app-owned opaque id exposed as `connectionId`.
- `ProviderCapabilities` is the versioned capability/probe result for that connection.
- `ProviderSurfaceModel` tells the app what the provider can show or create.
- `RouteEntryPointProvisioningPlan` chooses the route container strategy, mutation policy and fallback.
- `RouteEntryPointProvisioningAttempt` records the provider mutation/probe boundary before any route can be active.
- `ExternalRouteEntryPoint` is the provider-visible object the user recognizes, such as a Telegram topic or Slack root message/thread.
- `ProviderRouteAddress` is the stable provider route identity.
- `RouteActivationProof` proves that this exact route generation can be used for runtime routing.
- `TeamRouteBindingId` is the app-owned opaque id exposed as `teamRouteId`.
- `TeamRouteBinding` maps that active route to an Agent Teams `teamIdentityId` and owns the route lifecycle.
- `ProviderReplyReference` is an optional pointer from the current provider message to an older provider message.
- `ExternalReplyTargetResolution` is the lookup result used by `TargetSelectionPolicy`.
- `ProviderControlPlaneDecision` can consume setup, repair, callback and status updates before runtime delivery.
- `MessengerRouteDecision` is the durable final route/control outcome for this provider update.
- `MessengerConversationEntry` is the local user-visible message row attached to a route.
- `ExternalMessageLink` stores provider message, internal message and route target mapping for previous-message lookup and current-message persistence.
- `MessengerRuntimeTurnLedger` owns local lead/team runtime admission and ambiguity.
- `ExternalReplyProjectionIntent` is the only source of provider auto-send.
- `ProviderOutboxItem` is the durable send intent created from projection proof.
- `ProviderSendAttempt` is the non-idempotent provider request boundary.
- `ProviderSendResult` is the normalized provider outcome: sent, known-not-sent, retryable-before-request, rate-limited or unknown.
- `ProviderDeliveryResolution` persists the post-send outcome: link, retry schedule, terminal failure, manual task or local-only.
- `MessengerManualResolutionTask` is the durable UX/support task for ambiguous delivery.

Routing rule:

```text
route provisioning plan chooses route container strategy
route provisioning attempt records provider mutation ownership and result boundary
route activation proof gates active team binding
team route binding chooses team
control-plane decision chooses consume-or-continue
reply target resolution chooses exact reply target from old-link proof
route decision chooses delivery/control outcome
conversation entry chooses local history/runtime row
message link records provider/internal/target mapping
runtime ledger chooses local execution ownership
reply projection intent chooses external send eligibility
provider outbox item chooses provider send ownership
provider send attempt chooses no-blind-retry boundary
provider send result chooses raw provider outcome
delivery resolution chooses sent/link, retry, terminal or manual task
```

Boundary glue:

- `MessengerConnection` is broader than `TeamRouteBinding`: connection answers "which provider account and transport?", binding answers "which Agent Team route under that connection?".
- `ProviderCapabilities` is broader than `ProviderSurfaceModel`: capabilities include surfaces plus ACK behavior, formatting, rate limits, history, navigation, exact replies, interaction support and provider quirks.
- `ProviderCapabilities` is not `RouteActivationProof`: capabilities say this account may support a container type, while activation proof says this exact route generation is usable.
- `RouteEntryPointProvisioningAttempt` is not an active route: provider create success, send success or selector render success only become routable after activation policy accepts the evidence.
- `ExternalRouteEntryPoint` is broader than `ProviderRouteAddress`: entrypoint is the provider-visible object and lifecycle, address is the normalized routing/idempotency key derived from it.
- `RouteActivationProof` is scoped to connection, route entrypoint, provider address and route generation. Stale proof cannot activate a repaired or recreated route.
- `TeamRouteBinding` routes only an active route generation with valid activation proof. Tombstoned, unknown or repair-required entrypoints stop before runtime delivery.
- `TeamRouteBinding` is broader than `ExternalReplyTargetResolution`: binding chooses team scope, reply target resolution chooses exact lead/teammate target from link proof.
- `ProviderReplyReference` is not a new route. It is an optional provider pointer that must resolve through `ExternalMessageLink` before it can affect `TargetSelectionPolicy`.
- `ProviderControlPlaneDecision` is a pre-delivery branch: consumed control-plane updates do not create runtime turns or provider outbox candidates.
- `MessengerRouteDecision` is broader than target selection: it stores deliver-to-lead, deliver-to-teammate, ambiguous, repair, setup, rejected and consumed outcomes with reason snapshots.
- `MessengerConversationEntry` is broader than provider proof: it is display/history plus local delivery context. It is not provider-send proof unless linked to a verified projection intent.
- `ExternalReplyProjectionIntent` is not a network attempt. It only proves that a local visible reply is eligible to leave the app.
- `ProviderOutboxItem` is not proof that a provider request started. It reserves provider send ownership and text chunks.
- `ProviderSendAttempt` owns the `request_started` boundary. After this boundary, lost results become `send_unknown` or `provider_send_unknown`, not blind retry.
- `ProviderSendResult` is adapter/backend evidence. `ProviderDeliveryResolution` is the feature-owned durable interpretation that updates links, retry schedule, terminal state or manual-resolution queue.
- `MessengerManualResolutionTask` is not provider delivery. It is the user's explicit next-action record for ambiguous or unknown provider delivery.
- `ProviderPermalinkPort` creates provider-native links. `ProviderNavigationPort` turns product actions such as open thread, repair and open desktop into navigation intents and may call permalink creation.
- `MessengerStateStorePort` and `MessengerUnitOfWork` are the transaction boundary. Partitioned JSON files are physical tables behind that boundary, not separate domain stores.

Current implementation bridge:

```text
1. Domain identity and capability models:
   MessengerProviderId, MessengerConnectionId, MessengerConnection,
   MessengerConnectionMode,
   ProviderCapabilities, ProviderSurfaceModel, ExternalConversationKey,
   ProviderSubrouteKey, ProviderRouteAddress, ExternalRouteEntryPoint,
   TeamRouteBindingId, TeamRouteBinding, RouteGeneration,
   RelaySessionId, DeviceLeaseId,
   ExternalMessageKey, ProviderReplyReference,
   ExternalReplyTargetResolution, ExternalMessageLink,
   MessengerRouteTarget.

2. Domain state models:
   ProcessedProviderUpdate, MessengerConversationEntry,
   RouteEntryPointProvisioningPlan, RouteEntryPointProvisioningAttempt,
   RouteActivationProof,
   ProviderControlPlaneDecision, MessengerRouteDecision,
   MessengerRuntimeTurnLedger,
   ExternalReplyProjectionIntent, ProviderOutboxItem,
   ProviderSendAttempt, ProviderSendResult,
   ProviderDeliveryResolution, MessengerManualResolutionTask.

3. Domain policies:
   ProviderControlPlaneClassifier policy,
   RouteContainerSelectionPolicy, RouteActivationPolicy,
   ReplyTargetResolutionPolicy, TargetSelectionPolicy,
   ProviderCapabilities policy, ProviderIngressAckPolicy,
   ProviderOutboxItem state machine, repair/tombstone policy,
   plaintext boundary policy.

4. Application ports:
   MessengerStateStorePort, MessengerUnitOfWork,
   MessengerConnectionRepository, ProcessedProviderUpdateRepository,
   RouteEntryPointRepository, RouteProvisioningAttemptRepository,
   RouteActivationProofRepository, TeamRouteBindingRepository,
   ProviderControlPlaneDecisionRepository, MessengerRouteDecisionRepository,
   MessengerConversationEntryRepository, ExternalMessageLinkRepository,
   MessengerRuntimeTurnLedgerRepository, LocalProjectionEffectRepository,
   ProviderOutboxItemRepository, ProviderSendAttemptRepository,
   ProviderDeliveryResolutionRepository,
   MessengerManualResolutionTaskRepository,
   TeamDirectoryPort, TeamRuntimeDeliveryPort,
   TeamConversationProjectionPort, TeamRuntimeEventPort,
   TeamLifecyclePort, MessengerRelayTransportPort,
   ProviderSurfacePort, ProviderRouteProvisioningPort,
   ProviderSendPort, ProviderIngressAckPolicyPort,
   ProviderInteractionPort, ProviderFormattingPort,
   ProviderRateLimitPort, ProviderPermalinkPort,
   ProviderNavigationPort, ProviderHistoryBackfillPort,
   CredentialVaultPort, MessengerEventPublisherPort,
   ClockPort, IdGeneratorPort, LoggerPort, RedactionPort.

5. Adapters:
   file-backed store, local HTTP input adapter,
   team directory/runtime/projection/lifecycle adapters,
   Telegram adapter, relay adapter, renderer HTTP client/DTO adapter.
```

Current name map:

```text
LinkUnifiedTelegramBotUseCase, LinkOwnTelegramBotUseCase
  -> ConnectMessengerUseCase with connection mode
AcceptRelayOfferUseCase, AcceptDesktopRelayOfferUseCase
  -> MessengerRelayTransportPort input adapter + HandleProviderUpdateUseCase
DeliverInboundToTeamUseCase, InjectInboundToLeadUseCase
  -> DeliverExternalInboundMessageUseCase + TeamRuntimeDeliveryPort
HandleProviderCallbackUseCase
  -> HandleProviderUpdateUseCase + ProviderInteractionPort + ProviderControlPlaneClassifier
RepairMessengerRouteUseCase
  -> RepairTeamRouteBindingUseCase
TeamMessagingPort, TeamRuntimeInjectionPort
  -> TeamRuntimeDeliveryPort
TeamVisibleMessagePort, TeamMessagePersistencePort
  -> TeamConversationProjectionPort
TeamRosterPort, TeamIdentityPort
  -> TeamDirectoryPort
MessengerSecretStorePort
  -> CredentialVaultPort
MessengerRelayPort
  -> MessengerRelayTransportPort
ProviderFormattingRenderer, ProviderOutboundSender
  -> ProviderFormattingPort, ProviderSendPort
syncTeamTopic, setTeamTopicEnabled, MessengerTeamBindingDto
  -> syncTeamRoute, setTeamRouteEnabled, MessengerTeamRouteDto
routeId in older public/API notes
  -> teamRouteId / TeamRouteBindingId when it means app-owned team route identity
routeId in older provider-routing notes
  -> ProviderRouteAddress + RouteGeneration when it means provider route identity
routeTeamId in older team identity notes
  -> teamIdentityId when it means the stable Agent Teams team identity
routeTeamId in older relay/queue notes
  -> teamRouteId / TeamRouteBindingId when it means an active provider route binding
accountBindingId in older notes
  -> MessengerConnectionId when it means a connected provider account in the desktop feature
providerAccountId in older relay notes
  -> MessengerConnectionId when it means the app-owned connected provider account
connectionId in older relay/websocket notes
  -> RelaySessionId when it means one live relay stream or websocket session
deviceLeaseId, leaseId, leaseEpoch, connectionEpoch in relay notes
  -> DeviceLeaseId plus RelaySessionId validation when it means plaintext-receiving desktop lease
```

Local app API decision:

- Use the existing Fastify `HttpServer` as the HTTP-first local app API boundary.
- Do not create a second local daemon/server for messenger connectors in MVP.
- Core must not import Electron, Fastify, IPC, Telegram SDKs, renderer state or concrete app services.
- HTTP REST/SSE is for UI, local control, health and review queue.
- MCP is for agent/runtime tools such as `message_send`, not for Telegram/backend transport.
- Electron IPC remains only for desktop shell actions and narrow compatibility bridges.
- Browser mode and Electron mode should converge on shared `contracts/api` DTOs.
- Protected messenger routes require local session auth, Host/Origin checks and CSRF for cookie-auth mutations.
- Protected messenger routes must use feature-local Fastify security hooks and cannot rely on global CORS alone.
- The local `HttpServer` is not the public Telegram webhook server; official shared bot still needs cloud relay.

## Canonical Flow

Route provisioning flow:

```text
MessengerConnection
-> ProviderCapabilities
-> ProviderSurfaceModel
-> RouteContainerSelectionPolicy
-> RouteEntryPointProvisioningPlan
-> persist RouteEntryPointProvisioningAttempt before provider mutation
-> provider creates root object or selector state
-> persist ExternalRouteEntryPoint and ProviderRouteAddress
-> provider probe or explicit selector confirmation
-> RouteActivationPolicy
-> persist RouteActivationProof
-> activate TeamRouteBinding for this routeGeneration
```

Create success alone never activates a route. The same rule applies to Telegram private topics, Slack root-message threads and selector fallback routes.

```text
Telegram update
-> normalize provider update
-> durable ProcessedProviderUpdate
-> ProviderControlPlaneClassifier
-> ProviderControlPlaneDecision
-> if consumed: durable control-plane effect/status and stop before runtime delivery
-> resolve ExternalRouteEntryPoint and TeamRouteBinding
-> extract ProviderReplyReference
-> ExternalMessageLink lookup for previous provider message, if any
-> ExternalReplyTargetResolution
-> TargetSelectionPolicy
-> durable MessengerRouteDecision
-> durable MessengerConversationEntry inbound
-> save inbound ExternalMessageLink for current provider message
-> MessengerRuntimeTurnLedger pending
-> local runtime delivery to lead/team
-> correlated visible reply read-back verified
-> durable MessengerConversationEntry outbound
-> ExternalReplyProjectionIntent
-> ProviderOutboxItem
-> ProviderSendAttempt leased
-> ProviderSendAttempt request_started
-> provider adapter or official relay calls Telegram sendMessage
-> ProviderSendResult
-> ProviderDeliveryResolution
-> if sent: outbound ExternalMessageLink stores provider message ids
-> if unknown: MessengerManualResolutionTask
```

Do not use renderer state, newest feed row, or plain assistant text as the canonical projection source.

Conversation-entry rule:

- `MessengerConversationEntry` is local display/history and runtime context.
- Provider-originated inbound entries never enqueue provider outbox.
- Outbound entries become provider-send candidates only after read-back verification creates `ExternalReplyProjectionIntent`.
- `ExternalMessageLink` remains the source of exact provider reply mapping, not conversation row text.

Reply-reference rule:

- `ProviderReplyReference` is read from the current inbound provider message.
- It may resolve only through `ExternalMessageLinkRepository`.
- Missing, stale, tombstoned or cross-route reply references become ambiguous, repair or selector states.
- A normal un-replied message in a valid team route still routes to lead by default.
- Saving the current inbound `ExternalMessageLink` happens after route decision and local entry creation; it must not be confused with the previous-message lookup.

Route-decision rule:

- A non-consumed provider update gets exactly one durable `MessengerRouteDecision`.
- Retries reuse the stored decision unless a referenced team/member/route generation is explicitly tombstoned or repaired.
- `MessengerRouteDecision` stores the reason snapshot: route binding, route generation, control-plane classification, reply target resolution and target policy outcome.
- Control-plane consumed updates do not create `MessengerRuntimeTurnLedger`, `ExternalReplyProjectionIntent` or `ProviderOutboxItem`.

Provider-send rule:

- `ExternalReplyProjectionIntent` proves external send eligibility, not provider delivery.
- `ProviderOutboxItem` owns deterministic outbound id, chunking, formatting profile, target route and intended reply target.
- `ProviderSendAttempt` records lease owner, attempt id, request phase, request_started timestamp and provider/relay request id.
- Auto-retry is allowed only before `request_started`, after provider rate limits, or after failures classified as retryable-before-request.
- After `request_started`, missing result becomes `send_unknown` or `provider_send_unknown`, never automatic duplicate send.
- `ProviderDeliveryResolution` is the only place that converts a send result into link creation, retry scheduling, terminal provider state or manual-resolution task.
- Manual resolution actions must write a new `ProviderDeliveryResolution`; they must not mutate provider send history in place.

## Data Movement And Stability Contract

Official shared bot inbound:

```text
Telegram webhook plaintext
-> backend process memory only
-> metadata-only claim ledger
-> desktop main-process relay stream
-> desktop MessengerStateStore `MessengerConversationEntry` plaintext row
-> LeadTurnGate
-> lead stdin or teammate inbox
```

Official shared bot outbound:

```text
local visible reply
-> local read-back verification
-> ExternalReplyProjectionIntent
-> ProviderOutboxItem
-> ProviderSendAttempt
-> backend process memory only while sending
-> Telegram sendMessage
-> backend metadata result cache
-> desktop stores provider message_id
```

Own bot mode:

```text
desktop getUpdates/sendMessage directly with Telegram
our backend sees no own-bot token and no own-bot message plaintext
```

Renderer/browser UI:

```text
may see user-visible conversation text after local commit
must not receive bot tokens, relay refresh credentials, raw provider update bodies,
backend auth secrets, or official relay plaintext before local persistence
```

Reliability promises:

- Inbound official shared bot is at-least-once provider delivery plus idempotent local processing.
- Inbound ACK target is desktop durable local prepare or terminal non-delivery status.
- Outbound official shared bot is durable local outbox plus at-most-one automatic provider send attempt after `request_started`.
- Telegram `sendMessage` result loss becomes `send_unknown` or `provider_send_unknown`, not blind retry.
- Provider auto-send requires `ExternalReplyProjectionIntent`.
- No exact proof means manual review, repair state or local-only display.

Top stability option:

🎯 9   🛡️ 9   🧠 7   Approx 2200-4600 LOC on top of current plan

```text
Honest durable contract with explicit unknown states.
```

## Send Unknown Repair Contract

Decision from pass 54:

```text
send_unknown is not a retry state.
send_unknown becomes manual_resolution_required.
```

Manual resolution states:

```text
manual_resolution_required
-> marked_sent_linked
-> marked_sent_unlinked
-> user_checked_not_sent_retry_queued
-> duplicate_send_approved_queued
-> external_send_cancelled
```

Manual resolution model:

```text
ProviderSendResult
-> ProviderDeliveryResolution
-> MessengerManualResolutionTask when user/support decision is needed
-> user action
-> new ProviderDeliveryResolution
```

Safe UI actions:

- `Link by Telegram reply`
- `Mark sent without link`
- `I checked Telegram, retry`
- `Send duplicate anyway`
- `Keep local only`

Forbidden default action:

```text
Plain "Retry" for send_unknown.
```

Provider link consequences:

- `marked_sent_linked` restores `ExternalMessageLink` and future reply-to routing.
- `marked_sent_unlinked` marks delivery as manually sent but cannot restore exact reply-to routing.
- `duplicate_send_approved_queued` creates a new outbox item with `duplicateOfOutboxId`.
- `external_send_cancelled` keeps local history only and terminally blocks provider send.
- Every manual action records actor, timestamp, reason, previous resolution id and resulting resolution id.

Multi-part rule:

```text
If any part becomes send_unknown, stop later unsent parts until that part is manually resolved.
```

Top repair option:

🎯 9   🛡️ 9   🧠 6   Approx 1200-2800 LOC

```text
Local manual resolution queue with explicit actions.
```

## Sent Link Recovery

Decision from pass 55:

```text
In MVP, "Mark sent with link" should be implemented as "Link by Telegram reply".
```

Why:

- Telegram message-link docs cover public/private groups and channels.
- Private message-link syntax uses a `channel` parameter described as channel or supergroup ID.
- Telegram link IDs use MTProto format, not Bot API format.
- Default private bot-chat topics are not a safe pasted-link dependency until live fixtures prove support.
- Bot API `reply_to_message` gives the original message for replies in the same chat and message thread.

Repair flow:

```text
send_unknown
-> user replies in Telegram to the maybe-sent message with /sent <code>
-> repair handler verifies signed token, sender, chat and thread
-> handler reads reply_to_message.message_id
-> ExternalMessageLink is restored
-> state becomes marked_sent_linked
```

Classifier order:

```text
1. connector repair command with signed token
2. connector setup/control commands
3. normal route/topic/team message
```

Pass 56 stricter classifier order:

```text
1. provider admission and sender identity gate
2. connector repair command classifier
3. connector setup/control command classifier
4. callback/probe handler
5. normal topic/team route resolver
6. lead/teammate delivery
```

Repair token requirements:

- at least 128 bits entropy
- base64url display, roughly 22 chars
- store digest, not raw token
- scope to messengerConnectionId, teamRouteId, outboxId, outboxAttemptId and expected chat/thread
- default TTL 15 minutes, maximum 60 minutes

Accepted repair commands:

```text
/sent <code>
/sent@<bot_username> <code>
```

Rules:

- command must be first token
- bot username suffix must match when present
- `reply_to_message.message_id` must exist and be greater than zero
- accepted and rejected repair commands are consumed by connector control plane
- repair commands never reach lead stdin or teammate inbox
- accepted repair command can be best-effort deleted after local commit

Pass 57 cleanup rules:

- cleanup is not part of repair correctness or security
- `deleteMessage` is expected to work for fresh incoming private-topic repair commands, but fixture proof is still required before promising it in UX
- local repair commit happens before provider cleanup
- cleanup state is metadata-only and must not store raw command text, raw token, message text, or provider payload JSON
- cleanup failures are classified and surfaced in desktop health UI, not delivered to lead/team
- `deleteMessages` is a future batch-sweeper option, not required for MVP

Top repair-command pipeline option:

🎯 9   🛡️ 10   🧠 6   Approx 900-1800 LOC

```text
Pre-routing repair command control plane.
```

Pasted Telegram link parser scope:

- allowed for public username links that map to a known chat
- allowed for `t.me/c` links that map to a known supergroup/channel route
- not allowed for private bot-chat topics in MVP
- raw `message_id` alone is rejected

Top option:

🎯 8   🛡️ 9   🧠 6   Approx 900-2000 LOC

```text
Telegram reply-challenge repair.
```

## Topic Model

Decision:

- One Telegram topic per Agent Teams team when the Telegram topic route container is active.
- Preferred default container is the user's private chat with our bot, not a user-created forum group.
- Topic routes to team only after capability, activation and live-client proof.
- Reply-to routes to a specific teammate or lead only when `ExternalMessageLink` proves the target.
- If reply mapping is missing, stale, tombstoned or ambiguous, do not infer by newest row or visible text. Normal un-replied team-topic messages route to lead; ambiguous replies require repair/selector confirmation.
- Teammate messages to the user can be forwarded into the same team topic when route-linked and external-safe.

Important:

```text
Telegram topic title is not identity.
ExternalConversationKey is messengerConnectionId + telegram + botUserId + chat_id.
ProviderSubrouteKey is message_thread_id.
ProviderRouteAddress is messengerConnectionId + telegram + conversationKey + subrouteKey + routeGeneration.
ExternalMessageKey is messengerConnectionId + telegram + botUserId + chat_id + message_thread_id? + message_id.
```

Topic route activation:

```text
draft
-> capability_checking
-> provisioning
-> topic_created_unverified
-> probe_pending
-> active
```

`active` requires capability check, persisted topic creation result, persisted send probe, and either recent account-level topic proof or inbound proof from the same thread.

Pass 50 stricter release gate:

🎯 8   🛡️ 9   🧠 7   Approx 1200-2600 LOC on top of earlier topic work

```text
Private-chat topics are preferred default only after:
  account getMe capability proof
  live client compatibility fixture
  per-team route activation proof
```

Minimum client fixture matrix:

```text
Telegram Desktop latest stable
Telegram iOS latest stable
Telegram Android latest stable
Telegram Web latest stable
```

If fixture evidence is missing or failed:

```text
Use private DM selector mode as default.
Offer topics as advanced/beta only with explicit user opt-in.
```

Do not activate from:

- topic title
- `getMe.has_topics_enabled` alone
- `createForumTopic` success alone
- `sendMessage` success alone
- callback data without signed nonce and stored probe message link
- unknown topic id
- missing `message_thread_id`

Pass 58 stricter default gate:

```text
privateTopicDefaultAllowed =
  token_valid &&
  getMe.has_topics_enabled === true &&
  officialBotAllowsUserTopicMutation === false &&
  accountCompatibilityEvidenceFresh === true &&
  teamRouteActivationProof === active
```

Top defaulting policy:

🎯 8   🛡️ 10   🧠 7   Approx 1500-3000 LOC

```text
Strict private-topic gate with selector fallback.
```

If `allows_users_to_create_topics=true`:

- official shared bot should be fixed before private topics are default
- own-bot mode can warn and offer selector fallback or guided BotFather setup
- unknown topics still never route to runtime

## Telegram Topic Route Registry

Mandatory for topic mode:

```text
ExternalRouteEntryPoint
ProviderRouteAddress
RouteEntryPointProvisioningAttempt
RouteActivationProof
TeamRouteBinding
ProviderRouteTombstone
```

Route binding key:

```text
ProviderRouteAddress = messengerConnectionId + telegram + conversationKey(botUserId + chat_id) + subrouteKey(message_thread_id) + routeGeneration
```

Rules:

- Store `message_thread_id` as durable provider subroute identity.
- Store topic title only as display snapshot.
- Keep tombstones for replaced/deleted route generations.
- If inbound thread matches a tombstone, do not deliver to the team.
- If inbound thread is unknown, treat as setup/control traffic.
- If `message_thread_id` is absent in topic mode, handle only control commands.
- `external_reply` must not target a teammate. Only same-chat same-thread `reply_to_message` plus `ExternalMessageLink` can target teammate.

Recommended activation option:

🎯 8   🛡️ 9   🧠 5   Approx 900-1800 LOC

```text
One-time account-level topic confirmation plus per-team send probe.
```

Pass 50 activation proof kinds:

```text
callback_same_thread:
  callback message is full Message with expected chat_id + message_thread_id

callback_probe_message_link:
  callback message is Message or InaccessibleMessage
  chat_id + message_id match stored probe message
  signed nonce matches stored probe

inbound_same_thread:
  user sends text in the topic with expected chat_id + message_thread_id
```

Recommended repair option:

🎯 8   🛡️ 9   🧠 6   Approx 900-1800 LOC

```text
Tombstone old route, create a new generation, send optional reconnect notice.
```

Recommended route container option from pass 43:

🎯 8   🛡️ 8   🧠 6   Approx 1600-3600 LOC

```text
Private-chat topics with our shared bot as the default topic container.
```

Fallback route container:

🎯 8   🛡️ 7   🧠 4   Approx 900-2200 LOC

```text
Private DM plus /teams selector and inline keyboard when private topics are unavailable.
```

## Provider Identity And Reply-Link Contract

Decision from pass 45:

```text
TeamRouteBinding chooses team scope.
ExternalRouteEntryPoint chooses provider-visible route root.
ExternalReplyTargetResolution chooses reply target.
ExternalMessageLink stores provider/internal/target mapping.
MessengerRuntimeTurnLedger chooses local runtime ownership.
ProviderOutboxItem chooses provider send ownership.
```

Provider identities must stay separate:

```text
ProviderUpdateKey:
  idempotency for inbound transport admission

ExternalConversationKey:
  durable external conversation or route container

ExternalMessageKey:
  durable external message identity

ProviderReplyReference:
  provider-specific pointer from a new inbound message to an older provider message
```

Hard rule:

```text
Never route to a teammate from text, topic title, sender name, quote text, latest feed row, or timestamp alone.
Only route to a teammate when a provider reply reference resolves through ExternalMessageLink.
```

Telegram-specific rules:

- `ProviderRouteAddress` plus active `TeamRouteBinding` chooses team in topic mode.
- `message_thread_id` supplies the Telegram `ProviderSubrouteKey`.
- `reply_to_message.message_id` can choose a teammate only after `ExternalMessageLink` lookup.
- `external_reply` never chooses teammate in MVP.
- `callback_query.data` is not proof by itself.
- Callback setup confirmation needs signed nonce, allowed `from.id`, stored probe record, and stored probe provider message metadata.
- `message_id=0` creates no `ExternalMessageLink` and is not a reply target.

Provider matrix:

```text
Telegram:
  conversation = botUserId + chat_id
  subroute = message_thread_id
  reply reference = reply_to_message in same chat/thread

Slack:
  conversation = team_id/context_team_id + channel_id
  subroute = thread_ts when using app-DM or channel threads
  reply reference = thread_ts only for normal thread replies, not exact child message

Discord:
  conversation = channel_id
  thread = channel object with its own channel_id
  reply reference = message_reference DEFAULT only
  forward reference is display/context only

WhatsApp:
  conversation = phone_number_id + contact wa_id
  reply reference = context.message_id
  no native team-topic container
```

Slack-specific routing rule:

```text
Slack normal thread replies route to lead by default.
Slack teammate routing requires explicit interactive target selection, explicit command syntax, or another proven provider reference.
Do not infer teammate target from thread text, display name, latest Slack message, or Slack parent thread alone.
```

## Slack Future Provider Research

Pass 61 decision:

```text
Slack is feasible if core models route container/subroute instead of Telegram topics.
Best future default is App Home Messages tab or app DM with one thread per Agent Team.
```

Slack route container options:

1. App Home Messages tab or app DM, one thread per Agent Team.
   🎯 8   🛡️ 9   🧠 7   Approx 2500-4500 LOC for future Slack adapter.
   Recommended future default.

2. User-selected Slack channel, one thread per Agent Team.
   🎯 7   🛡️ 8   🧠 7   Approx 3000-5200 LOC.
   Good advanced/team-shared mode.

3. One Slack channel per Agent Team.
   🎯 6   🛡️ 7   🧠 8   Approx 4000-7000 LOC.
   Heavy lifecycle/admin overhead.

Slack ingress transport options:

1. Slack Socket Mode local/private app.
   🎯 8   🛡️ 8   🧠 8   Approx 3000-5500 LOC.
   Privacy-friendly, but user/workspace setup is harder and Marketplace distribution is not available for Socket Mode apps.

2. Hosted official Slack app with Events API HTTP.
   🎯 8   🛡️ 8   🧠 9   Approx 4500-8000 LOC.
   Best install UX, but backend sees plaintext and Slack's 3-second ACK expectation makes no-queue desktop delivery harder than Telegram.

3. Slash command only plus response URLs.
   🎯 6   🛡️ 6   🧠 5   Approx 1800-3200 LOC.
   Not enough for full ongoing conversation.

Slack provider facts that affect architecture:

- Slack conversations cover public channels, private channels, DMs, MPIMs and shared channels.
- Slack thread identity is `channel + thread_ts`.
- Slack message identity is `channel + ts`.
- Slack channel topic text is mutable metadata, not route identity.
- Slack App Home has a private app-user Messages tab.
- Slack HTTP Events should get quick `HTTP 200 OK`; retry schedule is documented but failure-heavy apps can be disabled.
- Slack Socket Mode requires `envelope_id` ACK and can distribute payloads across up to 10 open connections.
- Slack `conversations.history` and `conversations.replies` are too rate-sensitive for the live hot path.
- Slack `chat.postMessage` has no documented client idempotency key and generally allows about 1 message/sec per channel.
- Slack message metadata is not secret and must contain only opaque non-sensitive correlation data.

Slack library checks from 2026-05-01:

- `@slack/bolt` latest `4.7.2`, MIT, modified 2026-04-30.
- `@slack/web-api` latest `7.15.1`, MIT, modified 2026-04-20.
- `@slack/socket-mode` latest `2.0.7`, MIT, modified 2026-04-30.
- `@slack/types` latest `2.20.1`, MIT, modified 2026-04-20.

No Slack dependency is installed now.

Pass 62 Slack UX decision:

```text
Slack Home tab is dashboard/control.
Slack Messages tab or app DM is the private conversation container.
One Slack root message per Agent Team.
One Slack thread under that root message per Agent Team.
Thread replies route to lead by default.
Teammate routing needs explicit target selection.
Top-level app-DM messages are selector/control-plane only.
```

Slack default UX inside Slack:

- User opens the `Agent Teams` app in the Slack sidebar.
- Home tab shows grouped Agent Teams by project/workspace, route health, last activity and actions.
- Actions include `Open thread`, `Open desktop`, `Pause`, `Repair` and `Message teammate`.
- Messages tab or app DM contains one root message per Agent Team.
- The root message is the Slack equivalent of a Telegram topic header.
- The actual chat is in the Slack thread under that root message.
- New Agent Team creates a new root message/thread.
- Archived Agent Team tombstones the route generation and keeps history readable.
- Home tab reads our local canonical messenger state; Slack thread history is optional backfill, not the render source of truth.

Slack UX options:

1. Home dashboard plus Messages tab/app DM, one root message/thread per Agent Team.
   🎯 8   🛡️ 9   🧠 7   Approx 2500-4500 LOC.
   Recommended future Slack default.

2. App DM only with `/teams` selector and one thread per Agent Team.
   🎯 7   🛡️ 8   🧠 5   Approx 1800-3200 LOC.
   Simpler, but less discoverable and weaker repair/status UX.

3. User-selected Slack channel with one thread per Agent Team.
   🎯 7   🛡️ 8   🧠 7   Approx 3000-5200 LOC.
   Good future shared/advanced mode, not the private default.

Additional provider abstractions from pass 62:

- `ProviderSurfaceModel`: private chat, topic, app home, app DM, channel, thread, modal, buttons and menus.
- `RouteEntryPointRepository`: provider-created entrypoints such as Telegram topic, Slack root message, Discord thread, WhatsApp selector state.
- `ExternalRouteEntryPoint`: provider root object for an Agent Team route, with conversation key, optional subroute key, provider message key, route generation and tombstone state.
- `ProviderInteractionPort`: Telegram callback query, Slack Block Kit action/modal, Discord component interaction, WhatsApp button/list response.
- `TargetSelectionPolicy`: lead-by-default, teammate-by-explicit-target, team selector, repair/setup and ambiguous.
- `ProviderFormattingPort`: Telegram plain text, Slack mrkdwn/Block Kit, Discord markdown and WhatsApp text/template-safe output.
- `ProviderRateLimitPort`: provider-specific throttling keys and retry behavior.
- `ProviderPermalinkPort`: optional provider link creation for repair/open-in-provider UX.
- `ProviderHistoryBackfillPort`: optional recovery/backfill, never live hot path.
- `ProviderInstallMode`: official hosted app, local Socket Mode, own bot, OAuth bot token, app-level token, unified relay.
- `ProviderMessageMetadataPolicy`: only opaque provider-visible metadata.
- `ProviderControlPlaneClassifier`: `/teams`, `/sent`, setup, repair, pause and top-level selector messages before route delivery.

Slack UX edge cases:

- Home tab has a 100 block limit, so many teams need grouping/pagination.
- `conversations.replies` can be severely rate-limited for new non-Marketplace commercial apps, so local canonical state must drive UI/history.
- Deleted root message or `thread_not_found` means `repair_required`, not silent recreation.
- Slack docs note AI app mode can replace Messages with Chat/History tabs; core must depend on route entrypoints and conversations, not literal tab labels.
- Slack message metadata is not secret; store only opaque ids/hashes.
- Hosted Slack HTTP Events need fast 2xx, so no-plaintext-queue Slack semantics differ from Telegram.

Pass 63 visual Slack model:

```text
Slack sidebar app
  -> Home tab: index/dashboard/control
  -> Messages tab or app DM: private conversation shelf
  -> Thread pane: actual per-team chat room
```

Visual meaning:

- Home tab is where the user finds teams and sees status.
- Messages/app DM contains stable root messages, one per Agent Team.
- A root message is a door into the team thread, not the chat itself.
- Thread replies are the actual user-to-lead conversation.
- Normal replies stay inside threads, so top-level app DM does not become noisy.
- `Open thread` can use provider permalinks/deep links where available.

Architecture adequacy verdict from pass 63:

```text
The architecture is sufficient if route entrypoints and provider surfaces are implemented as first-class core contracts before Telegram networking.
```

Required separation:

```text
Provider update/input
  -> ProviderInboundNormalizer
  -> ProviderControlPlaneClassifier
  -> RouteEntryPointResolver
  -> TargetSelectionPolicy
  -> TeamDeliveryUseCase

Internal visible message/reply
  -> ExternalReplyProjectionIntent
  -> ProviderFormattingPort
  -> ProviderRateLimitPort
  -> ProviderSendPort
  -> ExternalMessageLinkRepository
```

Architecture corrections from pass 63:

- `ExternalRouteEntryPoint` is mandatory, not optional.
- `ProviderSurfaceModel` is pure capability/configuration data, not renderer UI.
- `ProviderIngressAckPolicy` must stay separate from route policy because Telegram, Slack HTTP Events and Slack Socket Mode ACK differently.
- `ProviderNavigationPort` can wrap Slack permalinks, Telegram repair links and future provider deep links.
- Avoid a giant provider port; use small ports and wire provider bundles in the composition root.
- MVP should use one canonical `MessengerStateStorePort` and `MessengerUnitOfWork`; recommended physical storage is partitioned versioned JSON with a unit-of-work journal, replaceable by SQLite later.

Architecture options:

1. Capability-bundle plus small ports.
   🎯 9   🛡️ 9   🧠 7   Approx 1200-2500 LOC.
   Recommended.

2. Full provider plugin framework now.
   🎯 6   🛡️ 8   🧠 9   Approx 3000-6000 LOC.
   Too heavy before Telegram MVP proves lifecycle.

3. Telegram-first core and retrofit Slack later.
   🎯 5   🛡️ 5   🧠 3   Approx 300-700 LOC now, but likely 2500-5000 LOC later.
   Fast now, high future rewrite risk.

Pass 64 consistency audit:

- Fixed unconditional Telegram topic wording.
- Fixed stale/missing reply routing wording.
- Fixed storage wording: partitioned versioned JSON behind `MessengerStateStorePort` and `MessengerUnitOfWork`, SQLite later.
- Expanded provider capability list beyond the earlier minimal set.
- Added canonical notes so historical research-pass language does not override the living summary.

Pass 65 consistency audit:

- Tightened the top product decision topic gate to include mutation policy, per-team activation proof and live client compatibility.
- Replaced remaining missing-link fallback-to-lead language with ambiguous plus repair/selector confirmation.
- Replaced old ACK-timeout/offline wording after plaintext dispatch with bounded non-2xx retry plus `delivery_unconfirmed`.
- Replaced old provider-god-port wording with explicit provider small ports.
- Rechecked local API, storage, Slack route model, own-bot privacy and provider abstractions.

Pass 66 organic structure audit:

- Added a coherence map from `ProviderSurfaceModel` to `ProviderOutbox`.
- Standardized current vocabulary around `ExternalRouteEntryPoint` and `TeamRouteBinding`.
- Aligned store names to `team-route-bindings.json` and `teamRouteBindings`.
- Aligned top architecture outbox names to `ProviderOutbox`.
- Clarified that partitioned JSON files are MVP physical table files behind `MessengerStateStorePort` and `MessengerUnitOfWork`.
- Rechecked that product, provider, local runtime and provider outbox concepts form one responsibility chain.

Pass 67 implementation bridge:

- Added first-slice bridge from the coherence map to concrete domain models, domain policies, application ports and adapters.
- Rechecked that product, domain, ports and storage are now connected enough for implementation.
- Current recommendation: start coding contracts/domain and tests from the bridge.

Pass 68 boundary glue audit:

- Extended the coherence map so it starts at `MessengerConnection` and `ProviderCapabilities`, not only at `ProviderSurfaceModel`.
- Clarified adjacent boundaries: connection vs route binding, capabilities vs surface model, entrypoint vs route address, team binding vs message link, permalink vs navigation, and logical store vs physical JSON tables.
- Rechecked against `docs/FEATURE_ARCHITECTURE_STANDARD.md`: core remains side-effect-free, HTTP/Fastify/Electron stay in adapters, and `contracts/api` DTOs remain the cross-process boundary.
- Current verdict: the docs are internally coherent enough to start implementation if the first slice creates these contracts before any Telegram networking code.

Pass 69 conversation-entry audit:

- Added `MessengerConversationEntry` so local user-visible history is separate from reply proof and provider outbox.
- Clarified that inbound provider-originated entries never enqueue provider outbox.
- Added `MessengerConversationEntryRepository` behind `MessengerStateStorePort` and `MessengerUnitOfWork`.

Pass 70 reply-reference audit:

- Added `ProviderReplyReference` and `ExternalReplyTargetResolution`.
- Split previous-message reply lookup from current-message link persistence.
- Clarified that missing or stale explicit provider reply references become ambiguous/repair/selector, not lead fallback.

Pass 71 route-decision audit:

- Added `ProviderControlPlaneDecision` and `MessengerRouteDecision`.
- Clarified that setup, repair, callback and status commands can be consumed before runtime delivery.
- Clarified that retry/recovery reuses the stored route/control decision instead of recomputing from current UI state.

Pass 72 provider-send boundary audit:

- Added `ProviderSendAttempt` and `ProviderSendResult`.
- Clarified that `ProviderSendAttempt.request_started` is the no-blind-retry boundary, not `ProviderOutboxItem`.
- Clarified official shared-bot send behavior with desktop plaintext ownership and backend metadata-only result cache.

Pass 73 delivery-resolution audit:

- Added `ProviderDeliveryResolution` and `MessengerManualResolutionTask`.
- Clarified that `ProviderSendResult` is adapter/backend evidence, while delivery resolution is the feature-owned outcome.
- Clarified that manual actions append a new resolution and do not mutate send history in place.

Pass 74 route-activation lifecycle audit:

- Added `RouteEntryPointProvisioningPlan`, `RouteEntryPointProvisioningAttempt` and `RouteActivationProof`.
- Clarified that provider capability and provider create success are not active route proof.
- Clarified that `TeamRouteBinding` may route only an active route generation with valid activation proof.
- Aligned Telegram topics, Slack root-message threads and selector fallback routes under the same route provisioning flow.

Pass 75 route identity and store-table audit:

- Replaced old Telegram-specific conversation identity wording with `ExternalConversationKey` plus `ProviderSubrouteKey`.
- Replaced the old topic-specific provisioning-attempt name with provider-neutral `RouteEntryPointProvisioningAttempt`.
- Aligned physical and logical store lists with route activation, route/control decisions, provider send attempts and manual resolution tasks.

Pass 76 message-identity and projection naming audit:

- Replaced current-summary `ProviderMessageKey` wording with canonical `ExternalMessageKey`.
- Clarified that `ProviderOutboxItem`, not a vague provider outbox bucket, owns provider send work.
- Aligned the physical store name `conversation-entries.json` with logical `conversationEntries` and `MessengerConversationEntry`.

Pass 77 external-message-link naming audit:

- Aligned physical `external-message-links.json`, logical `externalMessageLinks`, and `ExternalMessageLinkRepository`.
- Replaced current-summary adapter-specific message-link wording with `ExternalMessageLink`.
- Clarified that explicit provider-link proof means a durable `ExternalMessageLink`, not an adapter-specific link type.

Pass 78 repository-port naming audit:

- Aligned repository names with domain records and logical tables: `MessengerConversationEntryRepository`, `ProviderOutboxItemRepository`, `MessengerManualResolutionTaskRepository`.
- Added missing first-slice repositories for processed updates, control-plane decisions, route decisions, runtime turns and local projection effects.
- Clarified that repositories sit behind `MessengerStateStorePort` and `MessengerUnitOfWork`; they are not separate transaction owners.

Pass 79 use-case naming audit:

- Replaced broad use-case names with record-aligned orchestration names: `ListMessengerConversationEntriesUseCase`, `CreateExternalReplyProjectionIntentUseCase`, `EnqueueProviderOutboxItemUseCase`, `DrainProviderOutboxItemsUseCase`, `ResolveProviderDeliveryUseCase`.
- Clarified that provider sends are not performed by reply-capture use cases; they move through projection intent, outbox item, send attempt and delivery resolution.
- Aligned the top use-case list with the canonical responsibility chain.

Pass 80 provider-port boundary audit:

- Added explicit `ProviderRouteProvisioningPort` and `ProviderSendPort` to the current implementation bridge.
- Replaced broad provider bot API wording with small provider ports in the lower SOLID section.
- Renamed old outbox-state-machine wording to `ProviderOutboxItem state machine` so policy naming matches the domain record.
- Clarified that `ProviderControlPlaneClassifier` is a pure core policy over normalized inbound data, not a provider adapter port.

Pass 81 current-name and team-port coherence audit:

- Split broad `TeamMessagingPort` current wording into `TeamDirectoryPort`, `TeamRuntimeDeliveryPort`, `TeamConversationProjectionPort`, `TeamRuntimeEventPort` and `TeamLifecyclePort`.
- Added a current name map so older research names such as `DeliverInboundToTeamUseCase`, `InjectInboundToLeadUseCase`, `TeamVisibleMessagePort`, `MessengerRelayPort` and `MessengerSecretStorePort` do not compete with the current bridge.
- Replaced current-summary provider renderer/sender naming with `ProviderFormattingPort`, `ProviderRateLimitPort` and `ProviderSendPort`.

Pass 82 local API boundary coherence audit:

- Replaced IPC-primary wording in the current architecture plan with `registerMessengerConnectorsHttp()` on the existing Fastify `HttpServer`.
- Clarified that Electron preload/IPC is shell-only and must not duplicate messenger data/control DTOs.
- Added the security rule that protected messenger routes need feature-local Host, Origin, local session and CSRF enforcement because global `HttpServer` CORS is not a sufficient safety boundary.

Pass 83 public API route naming audit:

- Replaced current renderer API `syncTeamTopic` and `setTeamTopicEnabled` with provider-neutral `syncTeamRoute` and `setTeamRouteEnabled`.
- Replaced current DTO name `MessengerTeamBindingDto` with `MessengerTeamRouteDto`.
- Changed local route namespace from `/api/messenger/routes` to `/api/messenger/team-routes` and clarified that `teamRouteId` is app-owned and opaque, never a provider thread/topic id.

Pass 84 identifier taxonomy audit:

- Added explicit `MessengerConnectionId`, `TeamRouteBindingId` and `RouteGeneration` to the current domain vocabulary.
- Clarified that public `connectionId` serializes `MessengerConnectionId` and public `teamRouteId` serializes `TeamRouteBindingId`.
- Added mapping rules for older `routeId` wording so it cannot be confused with provider route ids or provider-native thread/topic ids.

Pass 85 relay identifier taxonomy audit:

- Added explicit `RelaySessionId` and `DeviceLeaseId` to separate product connection identity from cloud relay transport identity.
- Clarified that old relay/websocket `connectionId` wording means `RelaySessionId`, not public `MessengerConnectionId`.
- Updated current relay frame wording so desktop ACKs echo `relaySessionId` plus `deviceLeaseId`, while UI/API `connectionId` remains `MessengerConnectionId`.

Pass 86 cross-document coherence audit:

- Replaced current-looking storage, relay and identity examples that still used `accountBindingId` or generic `routeId` with `messengerConnectionId` and `teamRouteId`.
- Added mapping for older relay `providerAccountId` wording so relay offers cannot drift away from `MessengerConnectionId`.
- Clarified that metadata-only plaintext claim lanes are serialized per `MessengerConnectionId`, while per-team ordering remains a `TeamRouteBindingId` concern.

Pass 87 policy coherence audit:

- Clarified that plain assistant text may become local history or manual-review candidate, but it is not eligible for Telegram auto-send in MVP.
- Clarified that provider auto-send starts only from `ExternalReplyProjectionIntent` with exact `relayOfMessageId`, explicit provider link or exact sidecar proof.
- Reworded official relay transport as main-process HTTP streaming with SSE wire format plus HTTPS/POST ACK, not renderer `EventSource`.

Pass 88 organic coherence audit:

- Replaced current-looking plain assistant fallback recommendations with local/manual-review candidate wording.
- Reconciled storage guidance around one logical `MessengerStateStorePort` plus `MessengerUnitOfWork`, backed by sharded `VersionedJsonStore` physical tables.
- Marked NDJSON WAL and SQLite as later storage adapters, not the MVP default.
- Replaced current-looking WebSocket-primary relay recommendations with main-process HTTP streaming/SSE-wire plus HTTPS POST as MVP, WSS as fallback.
- Removed current-looking old identity fields such as `routeId`, `teamBindingId`, `desktopLeaseId` and `botConnectionId` from active examples in the architecture doc.

Pass 89 organic coherence audit:

- Reconciled Telegram route-container wording: private topics are preferred after proof, while private DM selector is the mandatory fallback/default when proof is missing.
- Reconciled Telegram SDK guidance: raw `fetch` plus `@grammyjs/types` is the MVP default; grammY runtime/helper usage cannot own ACK, offset or outbox retry semantics.
- Replaced a stale inaccessible-reply rule with ambiguous/repair behavior so explicit provider replies without link proof do not fall back to lead.

Pass 90 fresh-code alignment audit:

- Rechecked the architecture against fresh `dev` commit `2beb4dae`, including the updated feature standard, `src/features/CLAUDE.md`, `HttpServer`, `recent-projects` HTTP registration and the new `member-work-sync` slice.
- Confirmed `src/features/messenger-connectors/` remains the correct full feature slice shape.
- Confirmed the existing Fastify `HttpServer` remains the right local API boundary, while messenger routes still need feature-local Host, Origin, session and CSRF protections.
- Updated storage wording from sharded `VersionedJsonStore` as the named MVP implementation to feature-owned file-locked versioned JSON physical tables behind `MessengerStateStorePort`.
- Marked `VersionedJsonStore` and `JsonMemberWorkSyncStore` as reference patterns, not domain dependencies.
- Confirmed the root desktop package has no direct Telegram SDK, `zod`, SQLite, Redis, BullMQ, Bottleneck or `fast-check` dependency today; raw `fetch` plus planned `@grammyjs/types` remains the MVP Telegram adapter plan.

Pass 91 MCP message proof fresh-code audit:

- Rechecked fresh `mcp-server/src/tools/messageTools.ts`, `agent-teams-controller/src/internal/messageStore.js`, `agent-teams-controller/src/internal/atomicFile.js`, `TeamDataService.sendMessage()` and `TeamInboxWriter`.
- Confirmed `message_send` already carries `relayOfMessageId`, `source`, `leadSessionId`, `attachments` and `taskRefs`.
- Confirmed controller message storage now has atomic writes and same-text `runtime_delivery` dedupe for `relayOfMessageId/from/to/text`.
- Confirmed exact `lookupMessage(messageId)` exists and intentionally does not resolve by `relayOfMessageId`.
- Confirmed older "no atomic write" notes are partially stale, but the main proof conclusion is unchanged: the MCP tool result is advisory, destination-store readback plus connector proof ledger commit is required before provider auto-send.
- Confirmed `TeamDataService.sendMessage()` still does not pass `relayOfMessageId` into `controller.messages.sendMessage()`, so app-service message paths cannot be used as connector reply proof until fixed.

Pass 92 origin/dev freshness audit:

- Rechecked `origin/dev` at `bfad861b`, four commits ahead of local `dev`.
- Found no direct changes to messenger docs, Telegram SDK dependencies, local Fastify `HttpServer`, MCP `message_send` schema, controller `messageStore`, or `TeamDataService.sendMessage()` relay pass-through.
- Noted that OpenCode bridge now starts Agent Teams MCP HTTP by default, which improves but does not guarantee `message_send` availability for connector auto-replies.
- Noted that `member-work-sync` removed `native_stale_in_progress`; native/non-OpenCode runtime automatic delivery should remain capability-gated.
- Noted that recent-projects removed `filesystemState`, so messenger should treat recent-projects as architecture-shape reference only.

Current conflict-resolution rule:

```text
Living summary + top Final Product Decision + Current implementation bridge + Current name map are current.
Detailed passes are historical working notes.
If older pass text conflicts with the summary, use the latest summary decision.
Older WebSocket-first relay notes are historical; MVP relay is main-process HTTP streaming/SSE-wire plus HTTPS/POST ACK.
Older plain-assistant fallback notes are historical for provider auto-send; exact proof is required.
Older single-JSON, event-log, NDJSON-default or direct `VersionedJsonStore`-as-domain-store notes are historical; feature-owned file-locked versioned JSON behind `MessengerStateStorePort` is current MVP.
Older grammY-runtime notes are historical for MVP; raw fetch plus @grammyjs/types is current.
Older private-topic-default notes require the strict proof gate; otherwise selector mode is current.
Older controller-message-store notes before pass 91 are historical where they claim no atomic write exists; current code has atomic writes and same-text runtime_delivery dedupe, but no provider-grade proof without connector ledger.
Older runtime-capability notes before pass 92 should be read with the fresher OpenCode MCP HTTP default in mind: OpenCode `message_send` availability is easier to establish, but still must be capability evidence, not a global provider assumption.
```

Recommended option:

🎯 9   🛡️ 10   🧠 6   Approx 1400-3000 LOC

```text
Strict link-table routing in provider-neutral core.
```

Rejected option:

🎯 3   🛡️ 3   🧠 2   Approx 300-800 LOC

```text
Feed-based inference by newest row, visible sender prefix, or timestamp.
```

## Private-Chat Topic Capability Contract

Private-chat topics are the preferred default, but only after provider capability proof, live compatibility evidence, and per-team activation proof.

Account capability states:

```text
unknown
-> token_validated
-> topic_mode_missing
-> topic_mode_ready
-> topic_mode_ready_user_topics_allowed
-> topic_mode_broken
```

Topic activation requires:

```text
getMe.has_topics_enabled === true
createForumTopic(private chat, team name) persisted
sendMessage(chat_id, message_thread_id, probe) persisted
callback or inbound message confirms same thread, or callback matches stored probe message id plus signed nonce
```

Important corrections from pass 44:

- `allows_users_to_create_topics=true` is a warning or stricter setup policy, not route identity.
- Unknown `message_thread_id` never routes to lead.
- `closeForumTopic` and `reopenForumTopic` are not private-topic MVP operations.
- Private topic repair uses tombstone, local repair, delete/recreate when approved, or selector fallback.
- `direct_messages_topic_id` is separate from `message_thread_id`; MVP uses `message_thread_id`.

Important corrections from pass 50:

- `CallbackQuery.message` can be `InaccessibleMessage`, so callback confirmation needs stored probe-message fallback.
- Topic fixture data must be sanitized shape/ids/booleans only, not message text, captions, file names, screenshots with user content, tokens or auth headers.
- There is no documented safe route recovery from topic title; if route state is lost, require repair or selector fallback.
- Send failures for invalid thread/topic should tombstone or mark `repair_required`, not blindly recreate on every failure.

Important corrections from pass 58:

- Private topics are the preferred route container, not an unconditional default.
- `has_topics_enabled=true` proves API capability only; it does not prove route activation or client UX.
- `allows_users_to_create_topics=true` is route-container entropy and blocks default private-topic rollout for the official bot.
- Existing active routes can continue if fixture evidence later becomes stale, but new default private-topic provisioning should pause.
- Own-bot private topics require the same proof chain or selector fallback.

Top capability policy:

🎯 8   🛡️ 10   🧠 7   Approx 1500-3000 LOC

```text
Strict private-topic gate with selector fallback.
```

Top release policy:

🎯 8   🛡️ 9   🧠 7   Approx 900-1800 LOC

```text
Topics default only after live matrix passes; otherwise selector mode default.
```

Top unknown-topic policy:

🎯 9   🛡️ 9   🧠 4   Approx 400-900 LOC

```text
Unknown topic handles setup/help only and never routes to runtime.
```

## Runtime Turn Model

Mandatory:

```text
MessengerRuntimeTurnLedger
```

Why:

- Existing lead relay batches inbox messages.
- Messenger needs one durable external turn at a time per route for MVP.
- Reply projection must be correlated by id, not by timing.

MVP policy:

- Per-route FIFO.
- One active messenger runtime turn per route.
- Two different teams can process independently.
- Plain assistant text is local-only.
- Telegram projection requires a correlated visible reply.

## Runtime Acceptance And Reply Proof

Decision from pass 41:

```text
stdin.write callback is not runtime delivery proof.
```

Proof ladder for Claude lead:

```text
stdin_write_accepted_by_os
-> replay_user_message_observed
-> prompt_marker_indexed_in_transcript
-> visible_reply_persisted
-> provider_outbox_created
```

Recommended Claude lead spike:

🎯 8   🛡️ 8   🧠 5   Approx 500-1100 LOC

```text
Add --replay-user-messages and correlate replayed user events by external marker.
```

Recommended durable proof:

🎯 8   🛡️ 9   🧠 7   Approx 1500-3400 LOC

```text
Transcript marker scan after prePromptCursor plus stdout replay.
```

Important:

- `relayLeadInboxMessages()` is not the messenger external turn engine.
- It batches messages, uses in-memory `leadRelayCapture`, and can persist unkeyed replies.
- Messenger needs a one-turn durable ledger and active turn lock.
- OpenCode watchdog is the model to copy, not a direct dependency.
- `MessengerRuntimeTurnLedger` is separate from provider outbox.
- Runtime retries and Telegram send retries have different rules.
- `--replay-user-messages` is useful, but it is not a drop-in flag for the current parser.
- Current stdout `type=user` handling must classify app prompt replay before permission parsing.
- Transcript marker proof needs a forward append observer, not the existing UI feed extractor.

Pass 42 concrete replay requirement:

🎯 8   🛡️ 9   🧠 5   Approx 500-1200 LOC

```text
Add RuntimeStdoutUserMessageClassifier before existing type=user permission/teammate parsing.
```

Pass 42 concrete capability requirement:

🎯 8   🛡️ 9   🧠 6   Approx 900-2200 LOC

```text
Capability-gate --replay-user-messages with help check plus exact stream-json launch-shape probe.
```

## Runtime Acceptance, Lead Turn Gate, And Reply Ownership

Decision from pass 46:

```text
Messenger runtime turns need a shared per-team LeadTurnGate.
An external-only idle check is not enough.
```

Local probe:

```text
Claude Code 2.1.119 with --replay-user-messages emitted:
1. system/init
2. type=user replay event with isReplay=true
3. assistant event
4. result success event
```

Observed replay event carried:

```text
type=user
message.role=user
session_id
uuid
timestamp
isReplay=true
```

Current Agent Teams launch already uses:

```text
--input-format stream-json
--output-format stream-json
--verbose
```

Current Agent Teams launch does not yet use:

```text
--replay-user-messages
```

Important meaning:

```text
replay_user_message_observed is stronger than stdin.write callback,
but it is still not enough to prove a later reply belongs to the external turn
unless a shared lead-turn gate prevents interleaving.
```

Required shared lead-turn kinds:

```text
ui_user
external_messenger
post_compact_reminder
gemini_hydration
legacy_inbox_relay
system_recovery
```

Recommended gate option:

🎯 9   🛡️ 9   🧠 8   Approx 1500-2800 LOC

```text
Shared per-team LeadTurnGate around all lead stdin writes.
```

Fallback option:

🎯 7   🛡️ 7   🧠 6   Approx 700-1300 LOC

```text
External-only gate plus collision detection.
```

Rejected option:

🎯 4   🛡️ 4   🧠 3   Approx 250-600 LOC

```text
Simple leadActivityState === idle check before external stdin.write.
```

MVP reply projection from pass 46:

```text
Auto-send to Telegram only explicit user-directed replies with exact turn correlation.
Visible assistant text without exact relay/link proof is manual review or local-only.
```

Allowed auto-send candidates:

```text
SendMessage(to=user) or SendMessage(recipient=user) with connector-attached relayOfMessageId
message_send(to=user) with relayOfMessageId
teammate -> user inbox row with relayOfMessageId or explicit ExternalMessageLink
```

Required stdout classifier order:

```text
1. app prompt replay with isReplay=true and known turn marker
2. runtime permission/control messages
3. tool_result blocks
4. teammate message blocks
5. unknown user stdout
```

Permission relay decision:

```text
Do not relay tool permissions through Telegram in the first messenger MVP.
```

## Reply Correlation Ranking

Strongest to weakest:

1. `relayOfMessageId == turn.localInboxMessageId`
2. `conversationId == turn.conversationId` and matching route
3. active native messenger turn sidecar with exactly one active candidate
4. manual review

Do not use as default:

- timestamp proximity only
- same sender only
- same route only
- text similarity only
- newest `TeamMessageFeedService` row

Automatic Telegram reply rule:

```text
Auto-send only from a durable visible app message with exact relayOfMessageId or explicit ExternalMessageLink.
```

Candidate only:

- plain assistant text;
- native `SendMessage(to="user")` without connector-attached `relayOfMessageId`;
- `message_send` without `relayOfMessageId`;
- route/timestamp/newest-feed inference.

Recommended reply projection option:

🎯 9   🛡️ 9   🧠 6   Approx 900-2200 LOC

```text
Require exact relayOfMessageId or explicit provider link for auto-send.
```

## External Reply Projection Intent

Decision from pass 51:

```text
ProviderOutboxItem is created only from ExternalReplyProjectionIntent.
```

Accepted proof kinds:

```text
exact_relay_of_message_id
explicit_provider_message_link
native_sendmessage_sidecar_exact_turn
manual_user_approved
```

MVP auto-send allowed:

- `message_send(to=user)` with `relayOfMessageId` equal to the active external turn local inbound id.
- native `SendMessage` only when a sidecar binds it to exactly one active messenger turn and injects the exact `relayOfMessageId` before local persistence.
- teammate-to-user row with exact `relayOfMessageId` or explicit `ExternalMessageLink`.
- manual user-approved unresolved candidate.

MVP auto-send forbidden:

- plain assistant text
- `lead_process` without exact proof
- feed-inferred `relayOfMessageId`
- newest row or timestamp/text matching
- `message_send` without relay/link proof
- native `SendMessage(to=user)` without sidecar proof

State machine:

```text
candidate_observed
-> local_visible_message_verified
-> provider_outbox_queued

candidate_observed
-> manual_review_required

candidate_observed
-> rejected_no_exact_proof
```

Top option:

🎯 9   🛡️ 10   🧠 7   Approx 1800-3600 LOC

```text
Exact proof intent only.
```

## Current Highest-Risk Local Contract

⚠️ Native `SendMessage` has an internal field mismatch.

Prompt/canonical contract:

```text
to
summary
message
```

Current capture path:

```text
recipient
content
summary
```

Pass 51 concrete local finding:

```text
hasCapturedVisibleSendMessage() and captureSendMessages() still read recipient/content,
while lead prompts require to/message.
Native SendMessage(to="user") currently persists without relayOfMessageId.
```

Decision:

```text
Before Telegram E2E, normalize both shapes at capture boundary and add tests.
```

Recommended fix:

🎯 9   🛡️ 9   🧠 3   Approx 180-420 LOC

```text
to = input.to ?? input.recipient
message = input.message ?? input.content
summary = input.summary
```

Conflict rule:

```text
If canonical and legacy fields both exist and disagree, reject provider auto-send and require manual review.
```

## Local Metadata Pass-Through Gap

`TeamDataService.sendMessage()` currently accepts `relayOfMessageId` through `SendMessageRequest`, but does not pass it into `controller.messages.sendMessage()`.

Lower layers already support it:

- `TeamInboxWriter` persists `relayOfMessageId`.
- `agent-teams-controller` persists `relayOfMessageId`.
- `agent-teams-controller` treats `relayOfMessageId` as explicit delivery context for `message_send`.

Required early fix:

🎯 10   🛡️ 10   🧠 2   Approx 30-90 LOC

```text
Pass relayOfMessageId through TeamDataService.sendMessage() and add a focused test.
```

## MCP Gap

`message_send` currently exposes `relayOfMessageId`, but not:

```text
conversationId
replyToConversationId
```

Lower stores already preserve both fields. Cross-team MCP already exposes both.

Decision:

🎯 9   🛡️ 9   🧠 2   Approx 80-220 LOC

```text
Add optional conversationId and replyToConversationId to MCP message_send.
```

## Telegram Provider Rules

Official facts that matter:

- `Update.update_id` is transport admission identity, not message identity.
- Telegram stores incoming updates until received, but not longer than 24 hours.
- A single `Update` has at most one optional payload field.
- `Message.message_id` is unique inside chat, but can be `0` in specific scheduled cases.
- `Message.reply_to_message` is only for replies in the same chat and message thread.
- `Message.external_reply` may come from another chat or forum topic.
- `CallbackQuery.message` is `MaybeInaccessibleMessage`.
- `CallbackQuery.data` is not proof by itself.
- Bot API 9.3 added private-chat topic fields and private-chat `message_thread_id` send support.
- Bot API 9.4 added `createForumTopic` for private chats and `allows_users_to_create_topics`.
- Bot API 9.6 added Managed Bots, but Managed Bots are not required for private-chat topics.
- Bot API `Message.is_topic_message` covers topics in forum supergroups and private chats with bots.
- `User.has_topics_enabled` and `User.allows_users_to_create_topics` are returned only in `getMe`.
- `ForumTopic` contains `message_thread_id`, which is the provider route identity candidate.
- `sendMessage` returns the sent `Message`.
- `sendMessage.text` is 1-4096 chars after entities parsing.
- `sendMessage.message_thread_id` targets a topic in forum supergroups and private chats of bots with forum topic mode enabled.
- `sendMessage.reply_parameters` can point at the provider message being replied to.
- `getUpdates` and webhooks are mutually exclusive for one bot token.
- `getUpdates` confirms updates by moving offset higher than the processed `update_id`.
- Webhook retries happen on non-2xx.
- Webhook `secret_token` must be verified.
- `createForumTopic` can create topics in private chats with users.
- `editForumTopic`, `deleteForumTopic`, and `unpinAllForumTopicMessages` are supported for private topics.
- `deleteForumTopic` can delete a topic and its messages in a private chat with a user.
- `closeForumTopic` and `reopenForumTopic` should not be required for private-topic MVP because current docs describe them for forum supergroups.
- Bot API `Message` lists topic created/edited/closed/reopened service fields, but no clear topic-deleted service field.
- `direct_messages_topic_id` is not the same as `message_thread_id`; MVP uses `message_thread_id`.
- `getManagedBotToken` returns the token string.
- Inline Bot API method calls in webhook responses do not return success/result to the app.

MVP Telegram policy:

- Use explicit outbound worker, not inline webhook responses.
- Prefer private-chat topics over forum supergroup setup.
- Use signed callback data plus stored probe metadata for setup probes.
- Always call `answerCallbackQuery` for callback buttons.
- Plain text only, no `parse_mode`.
- Split outbound text at around 3900 chars.
- Store every returned provider `message_id`.
- First chunk replies to inbound provider message when possible.
- If reply target fails, retry once without `reply_parameters` but keep `message_thread_id`.
- `sendChatAction` is only progress indicator.
- `sendMessageDraft` is not MVP.

Package check:

```text
grammy 1.42.0
@grammyjs/types 3.26.0
```

Local package inspection confirms support for:

```text
createForumTopic
message_thread_id
direct_messages_topic_id
has_topics_enabled
allows_users_to_create_topics
```

Official Claude Telegram channel plugin does not implement topic routing. Use its security patterns, not its product model.

## Claude Code Channels Reference

Claude Code Channels are useful as a design reference, not the MVP dependency.

Official Channels facts:

- Channels are MCP servers that push events into a running Claude Code session.
- Channels can be two-way through a reply tool.
- Telegram, Discord, and iMessage plugins exist in the research preview.
- Events only arrive while the session is open.
- Always-on usage requires a background process or persistent terminal.
- Channels require `claude.ai` login, and Team/Enterprise orgs must enable them.
- During research preview, channel plugins are allowlist-gated and the flag/protocol may change.

Local probe:

```text
Claude Code 2.1.119 shows --replay-user-messages in help.
Claude Code 2.1.119 does not show --channels in help.
```

Official plugin patterns to copy:

- Gate on sender identity, not chat id.
- Use pairing codes for allowlist bootstrap.
- Remote chat cannot approve pairing or mutate access policy.
- Put trusted adapter metadata in meta, not in user content.
- Intercept permission replies before normal chat forwarding.
- Keep reply sending behind an explicit reply tool/outbox path.
- Do not relay permission prompts to groups by default.

Agent Teams decision:

```text
Do not spawn one Claude Channel plugin per team.
Do not spawn one Telegram poller per lead session.
One provider account binding must have one receiving owner.
```

Recommended option:

🎯 8   🛡️ 9   🧠 8   Approx 4500-9000 LOC

```text
Central Agent Teams connector gateway with Telegram private-chat topics.
```

Rejected MVP option:

🎯 4   🛡️ 5   🧠 5   Approx 1800-4200 LOC

```text
Build directly on Claude Code Channels per team.
```

Reason:

```text
It is tempting because official plugins exist, but it breaks shared-token ownership and does not provide Agent Teams durable route/projection state.
```

## Official Shared Bot Relay

Decision:

- Desktop must initiate outbound connection to our backend.
- Do not require a public server on the user's machine.
- Existing local `HttpServer` is localhost UI/API infrastructure, not the Telegram relay.
- Recommended MVP relay transport: main-process HTTP streaming using SSE wire format plus HTTPS/POST ACK uplink.
- WebSocket is a good later option, but not required for the first reliable MVP.
- Runtime must not start after local persist alone. Desktop starts runtime only after backend accepts the local durable ACK.
- SSE `Last-Event-ID` is resume metadata, not delivery proof.

ACK rule:

```text
Telegram webhook returns 2xx only after:
1. desktop local durable commit ACK, or
2. backend sends a terminal provider-visible status such as offline or unsupported.
```

Stricter desktop gate:

```text
claim_received
-> local_prepared
-> ack_accepted
-> runtime_queue_pending
```

`runtime_queue_pending` is impossible before `ack_accepted`.

Important distinction:

```text
no connected desktop before dispatch = offline
claim sent but ACK missing = ambiguous ownership
```

Do not send offline status after a claim was already dispatched to desktop.

Duplicate retry rule:

```text
Telegram retry with same providerUpdateKey:
  if desktop already has local_prepared row, desktop returns duplicate_local ACK
  backend can then return webhook 2xx
```

Backend may persist only non-plaintext metadata:

```text
providerUpdateKey
messengerConnectionId
relaySessionId
deviceLeaseId
claimId
state
timestamps
HMAC payload digest
reason codes
provider status message ids
```

Do not persist:

- text
- captions
- file names
- raw Telegram update JSON
- plain/unsalted payload hashes

Recommended relay option:

🎯 8   🛡️ 9   🧠 8   Approx 3200-6200 LOC with backend, desktop, tests, docs

```text
Main-process HTTP streaming/SSE-wire downlink + HTTPS/POST ACK + no plaintext queue + metadata-only claim ledger.
```

Recommended SSE client option:

🎯 8   🛡️ 9   🧠 6   Approx 1200-2600 LOC

```text
Main-process fetch stream plus eventsource-parser.
```

Package check:

```text
eventsource-parser 3.0.8, MIT, checked 2026-04-30.
```

Do not run the official relay from renderer `EventSource`.

Pass 48 hardened relay contract:

```text
Telegram webhook
-> backend verifies secret and sender identity
-> backend creates metadata-only claim
-> backend dispatches plaintext claim over main-process relay stream
-> desktop durably prepares local state
-> desktop ACKs local_prepared or duplicate_local
-> backend accepts ACK and returns Telegram webhook 2xx
-> desktop starts local runtime only after ack_accepted
```

Backend relay connection:

```text
GET /v1/messenger/relay/events
Authorization: Bearer <short-lived relay access token>
X-Agent-Teams-Device-Id: <device id>
X-Agent-Teams-App-Version: <version>
Last-Event-ID: <metadata resume id, optional>
```

ACK endpoint:

```text
POST /v1/messenger/relay/claims/{claimId}/ack
```

ACK kinds:

```text
local_prepared
duplicate_local
rejected_terminal
rejected_retryable
unsupported_update
busy_retryable
```

Recommended timeout defaults:

```text
desktop local prepare: 3000-5000 ms
backend webhook ACK wait: 7000-9000 ms
SSE heartbeat: 15000-30000 ms
connection stale: 2 missed heartbeats + transport close
```

Pass 49 bounded retry policy:

🎯 8   🛡️ 9   🧠 8   Approx 1800-3600 LOC on top of pass 48

```text
If plaintext was dispatched but ACK is missing:
  return non-2xx only for a bounded retry budget
  redispatch duplicate claim to connected desktop when possible
  accept duplicate_local/local_prepared ACK if desktop already saved the update
  after budget expires, send delivery_unconfirmed status and return 2xx
```

Recommended initial retry budget:

```text
backend ACK wait: 8000 ms default, configurable 5000-9000 ms
max Telegram attempts for one provider update: 3
max unconfirmed window: 120000 ms
same-binding lane wait: 1000-2000 ms
```

Provider-visible status classes:

```text
desktop_offline: only before plaintext dispatch
delivery_unconfirmed: after dispatch without ACK
team_not_ready: route/team cannot currently accept Telegram traffic
unauthorized_sender: Telegram account is not connected
```

Claim-ledger retention recommendation:

```text
ack_accepted / terminal_offline / terminal_unsupported: 7 days hot metadata
terminal_delivery_unconfirmed / repair_required: 30 days or until repair
device credential audit metadata: 90 days
aggregate metrics without payload identifiers: 180 days
```

Concurrency policy:

```text
Backend can accept multiple Telegram webhook requests globally.
Plaintext claims are serialized per messengerConnectionId.
For shared bot setWebhook max_connections should start around 10 or 20, then be tuned.
```

Relay credential policy:

🎯 8   🛡️ 9   🧠 7   Approx 1200-2600 LOC

```text
Device-bound relay credential in desktop vault,
exchanged for short-lived access tokens for SSE and ACK calls.
```

Recommended credential setup UX from pass 49:

🎯 8   🛡️ 9   🧠 6   Approx 1200-2400 LOC

```text
Device-code style pairing with verification_uri_complete when available:
desktop opens browser, still shows user_code, user approves named desktop,
main process stores refresh credential in vault, renderer sees masked status only.
```

Privacy boundary in official shared bot mode:

```text
Backend may persist claim ids, route ids, state, timestamps, HMAC payload digest,
provider status message ids, error codes and payload size bucket.

Backend must not persist raw update JSON, message text, captions, file names,
contact/location data, plain payload hash, bot token or desktop refresh token plaintext.
```

Pass 59 strict relay checkpoints:

```text
T0 telegram_webhook_received
T1 backend_metadata_claim_persisted
T2 plaintext_claim_dispatched_to_desktop_stream
T3 desktop_local_prepare_committed_and_read_back
T4 backend_ack_accepted
T5 runtime_delivery_started
```

Rules:

- Telegram 2xx requires T4, or terminal non-delivery before T2.
- T1 and T2 are not delivery proof.
- `Last-Event-ID` is resume metadata, not ACK proof.
- Runtime delivery starts only after T4.
- If T2 happened and ACK is missing, status is `delivery_unconfirmed`, not `desktop_offline`.

Top relay ACK option:

🎯 8   🛡️ 10   🧠 8   Approx 1800-3800 LOC

```text
Strict durable ACK before Telegram 2xx, bounded retry, delivery_unconfirmed.
```

## Official Bot Result Caches

Official shared bot mode needs backend metadata caches because desktop does not have the official bot token.

Required caches:

```text
OfficialProviderSendResultCache
OfficialTopicProvisionResultCache
```

Rules:

- Cache key is a desktop-supplied request id.
- Backend stores provider metadata only, not plaintext.
- Backend must persist provider result before responding success to desktop.
- If Telegram success may have happened before cache persist, mark unknown and do not blind retry.

Pass 60 outbound checkpoints:

```text
S0 desktop_outbox_prepared
S1 backend_send_request_admitted
S2 backend_metadata_request_persisted
S3 telegram_send_started
S4 telegram_send_result_received
S5 backend_result_metadata_persisted
S6 desktop_result_applied
```

Rules:

- S2 allows duplicate desktop requests to dedupe.
- S3 is the no-blind-retry boundary.
- S4 without S5 is ambiguous.
- Backend may respond `sent` only after S5.
- Desktop may mark provider outbox `sent` only after S6.
- Same `desktopRequestId` with different HMAC payload digest is a conflict.
- Exact reply sends should use `reply_parameters.allow_sending_without_reply=false`.
- Inline webhook Bot API calls are not used for official outbound because the app needs returned provider message ids.

Top official outbound option:

🎯 9   🛡️ 9   🧠 7   Approx 1400-3000 LOC

```text
Desktop request id plus backend metadata result cache.
```

Outbound send states:

```text
pending
-> send_in_flight
-> sent

send_in_flight
-> send_unknown
```

Topic provisioning states:

```text
not_started
-> create_in_flight
-> created

create_in_flight
-> provision_unknown
```

Recommended official outbound strategy:

🎯 9   🛡️ 9   🧠 6   Approx 1100-2400 LOC

```text
Desktop-owned plaintext outbox plus backend metadata result cache.
```

Recommended official topic provisioning strategy:

🎯 8   🛡️ 9   🧠 7   Approx 1400-3000 LOC

```text
Backend result cache plus desktop route binding ACK.
```

## Provider Outbox

Mandatory state machine:

```text
queued
-> sending
-> sent

queued
-> rate_limited
-> queued

sending
-> ambiguous

sending
-> failed_retryable
-> queued

sending
-> failed_terminal
```

Key rule:

```text
Telegram has no documented idempotency key on sendMessage.
Network timeout after sending must become ambiguous, not blind auto-retry.
```

Recommended:

🎯 9   🛡️ 9   🧠 5   Approx 900-1800 LOC

## Crash Consistency And Store Boundaries

Decision from pass 47:

```text
Critical messenger state should live behind one feature-owned canonical store boundary for MVP.
Partitioned JSON files are physical table files, but not independent transactional ownership.
MessengerUnitOfWork owns cross-table atomicity/recovery.
```

Recommended MVP:

🎯 9   🛡️ 9   🧠 7   Approx 1800-3600 LOC

```text
Canonical MessengerStateStorePort plus partitioned JSON tables and idempotent side-effect sagas.
```

Alternative:

🎯 7   🛡️ 10   🧠 8   Approx 2600-5200 LOC plus packaging work

```text
SQLite feature database with real transactions.
```

Why not default SQLite now:

```text
node:sqlite is available locally on Node 22.21.1 but prints ExperimentalWarning.
better-sqlite3 latest is 12.9.0, MIT, modified 2026-04-12, but it adds native Electron packaging surface.
```

Critical rule:

```text
Do not write processed update, route decision, runtime turn, local projection and outbox as unrelated files.
Either update one canonical store atomically or use an explicit receipt/recovery plan.
```

Logical tables inside canonical state:

```text
connections
processedUpdates
teamRouteBindings
routeEntryPoints
routeTombstones
provisionAttempts
routeActivationProofs
controlPlaneDecisions
routeDecisions
conversationEntries
externalMessageLinks
runtimeTurns
localProjectionEffects
providerOutbox
providerSendAttempts
providerDeliveryResolutions
manualResolutionTasks
relayClaims
repairTasks
```

Side-effect destinations:

```text
inboxes/*.json
sentMessages.json
Telegram/backend provider API
Lead stdin
```

Rules for side effects:

- Create a deterministic side-effect intent in `MessengerStateStore` first.
- Use deterministic target message ids.
- Perform the side effect.
- Read back and verify.
- Mark committed only after verification.
- On recovery, retry missing side effects and mark existing matching rows committed.
- If target row exists with same id but incompatible payload, create repair task.
- Never enqueue provider outbox before local visible reply is verified.

Crash recovery highlights:

```text
processed update before route/runtime:
  should be impossible in one canonical unit of work

local projection pending + target row missing:
  retry local write

local projection pending + target row exists:
  verify and mark committed

stdin_write_completed + no replay/result:
  ambiguous_after_injection, no auto-reinject

reply persisted + no outbox:
  enqueue outbox once after verifying reply/link

provider send started + no result:
  provider_send_unknown, no blind retry
```

Existing app stores are not canonical provider state:

- `sentMessages.json` is capped at 200 rows.
- sent-message persistence can log-and-swallow errors.
- `TeamMessageFeedService` can synthesize `relayOfMessageId` by timing/text.
- UI feed cache can be stale.
- old inbox rows may lack stable explicit message ids.

Therefore:

```text
Existing stores are projection destinations and UI inputs.
MessengerStateStore is the provider-routing source of truth.
```

## Store Boundaries

Use feature-owned logical tables for messenger state.

MVP canonical store boundary:

```text
MessengerStateStorePort
MessengerUnitOfWork
```

Recommended MVP physical implementation:

```text
messenger-connectors/
  connections.json
  team-route-bindings.json
  route-entrypoints.json
  route-tombstones.json
  provision-attempts.json
  route-activation-proofs.json
  control-plane-decisions.json
  route-decisions.json
  relay-ack-ledger.json
  official-send-requests.json
  external-message-links.json
  processed-updates.json
  runtime-turns.json
  conversation-entries.json
  local-projection-effects.json
  provider-outbox.json
  provider-send-attempts.json
  provider-delivery-resolutions.json
  manual-resolution-tasks.json
  provider-result-cache.json
  unit-of-work-journal.json
```

Do not expose that physical choice to core or provider adapters. SQLite can replace partitioned JSON later behind the same store/unit-of-work boundary.

Logical tables:

```text
connections
teamRouteBindings
routeEntryPoints
routeTombstones
provisionAttempts
routeActivationProofs
controlPlaneDecisions
routeDecisions
relayAckLedger
officialSendRequests
externalMessageLinks
processedUpdates
runtimeTurns
conversationEntries
localProjectionEffects
providerOutbox
providerSendAttempts
providerDeliveryResolutions
manualResolutionTasks
providerResultCache
```

Do not use as canonical messenger state:

- `sentMessages.json`, capped at 200 rows
- `TeamMessageFeedService`, UI projection
- renderer Zustand state
- Telegram topic title

Additional pass 45 local contract notes:

- `TeamInboxWriter`, `TeamInboxReader`, and `TeamSentMessagesStore` preserve `relayOfMessageId`, `conversationId`, and `replyToConversationId`.
- `TeamDataService.sendMessage()` still accepts `relayOfMessageId` but does not pass it into `controller.messages.sendMessage()`.
- `InboxMessage.source` has no `external_messenger_inbound`, `external_messenger_outbound`, or `external_messenger_status` value yet.
- `TeamMessageFeedService` can link passive user reply summaries by timing/text, so it must stay UI projection only.

## Best Current Implementation Sequence

1. Create feature skeleton and contracts.
2. Add research summary as living index.
3. Add `messenger-connectors/contracts/api.ts` DTOs shared by HTTP, renderer and IPC adapters.
4. Add local HTTP security middleware for protected messenger routes: Host, Origin, local session and CSRF.
5. Add `registerMessengerConnectorsHttp()` on the existing Fastify `HttpServer`.
6. Add data movement contract types: sensitive plaintext, metadata-only records, local UI DTOs, provider ids.
7. Add backend no-plaintext schema guards and log canary tests before relay code.
8. Fix `TeamDataService.sendMessage()` `relayOfMessageId` pass-through and tests.
9. Add native `SendMessage` normalization and tests.
10. Add MCP `message_send` conversation field pass-through and tests.
11. Add provider-neutral domain models and state machines.
12. Add `MessengerCanonicalStateV1`.
13. Add `MessengerStateStorePort`.
14. Add `VersionedJsonMessengerStateStore` behind the canonical store port.
15. Add `MessengerUnitOfWork` for atomic logical-table updates.
16. Add deterministic id builders and payload hash helpers.
17. Add `LocalProjectionEffect` state machine and verifier.
18. Add recovery scanner for pending projections, unresolved runtime turns and ambiguous sends.
19. Add outbound prompt ledger for stdin writes.
20. Add `RuntimeStdoutUserMessageClassifier`.
21. Add `--replay-user-messages` capability probe.
22. Add `LeadTranscriptAppendObserver`.
23. Add MessengerRuntimeTurnLedger.
24. Add Telegram topic capability probe and route registry.
25. Add Telegram private-chat topic capability probe.
26. Add Telegram private-topic default gate: capability, mutation-policy, fixture and route-activation proof.
27. Add Telegram topic compatibility evidence model and sanitized fixture harness.
28. Add per-team topic activation proof with callback/inbound proof kinds.
29. Add TelegramBotAccountCapabilityProbe and TelegramTopicModePolicy.
30. Add route container strategy: private_topic, private_selector, forum_supergroup.
31. Add provider-neutral `ProviderRouteAddress`, `RouteEntryPointProvisioningPlan`, `RouteEntryPointProvisioningAttempt`, `ExternalRouteEntryPoint`, `RouteActivationProof`, and `TeamRouteBinding` with conversationKey, optional subrouteKey and routeGeneration.
32. Add provider capability matrix: exact reply reference, thread subroutes, interactive target selection and ingress ACK policy.
33. Add `ProviderSurfaceModel` and `RouteEntryPointRepository` so Slack root-message threads and Telegram topics share one core shape.
34. Add `ProviderInteractionPort` and `TargetSelectionPolicy` before routing any provider button/menu/callback traffic.
35. Add `ProviderFormattingPort`, `ProviderRateLimitPort`, `ProviderPermalinkPort` and `ProviderHistoryBackfillPort`.
36. Add central bot ownership invariant: one poller/webhook owner per provider account binding.
37. Add sender identity gate before route resolution.
38. Add untrusted content vs trusted adapter metadata split.
39. Add unknown-topic setup/help policy.
40. Add provider-neutral route activation, provisioning ledger, repair policy, and tombstone tests.
41. Add fallback selector mode with short-lived active team selection.
42. Add `ProviderIdentityNormalizer` and `ProviderReplyReferenceResolver`.
43. Add `ExternalMessageLinkRepository` and link-state tests.
44. Add provider-origin loop-prevention policy.
45. Add edit/delete/tombstone policy.
46. Add relay ACK gate: local_prepared does not start runtime until ack_accepted.
47. Add official-bot provider send result cache and topic provision result cache.
48. Add shared per-team `LeadTurnGate` around all lead stdin writes.
49. Add active turn lock for messenger runtime turns.
50. Add Claude lead prompt marker injector.
51. Add `--replay-user-messages` capability probe and team launch fixture.
52. Add `RuntimeStdoutUserMessageClassifier` before existing `type=user` parsing.
53. Add replay marker observer and transcript marker observer.
54. Add `ExternalReplyProjectionIntent` with proof-kind policy.
55. Add visible reply observer requiring exact `relayOfMessageId`, explicit provider link, or native sidecar exact-turn proof.
56. Add local visible reply write/read-back verification before provider outbox.
57. Add reply projection policy with explicit-send-only auto-send and manual review for plain assistant text.
58. Add runtime ambiguous-after-injection recovery state and UI model.
59. Add Telegram transport gateway with text-only send.
60. Add provider outbox with ambiguous state.
61. Add `send_unknown` manual resolution queue and explicit repair actions.
62. Add `Link by Telegram reply` sent-confirmation repair flow.
63. Add pre-routing `TelegramRepairCommandClassifier`.
64. Add `TelegramRepairTokenStore` with digest-only storage and TTL.
65. Add `TelegramRepairCleanupPort`, `RepairCommandCleanupTask` and cleanup error classifier for post-commit command deletion.
66. Add provider link parser only for public/supergroup/forum route containers.
67. Add multi-part unknown pause/resume policy.
68. Add `OfficialRelayProtocol` contracts: claim, ACK, duplicate, status and version fields.
69. Add backend metadata-only claim ledger and no-plaintext persistence guard tests.
70. Add relay device credential vault using the existing safeStorage/AES fallback pattern.
71. Add main-process HTTP streaming/SSE-wire relay client and HTTPS/POST ACK client.
72. Add backend webhook secret verification, sender identity gate and account binding resolution.
73. Add claim dispatch with per-MessengerConnectionId plaintext serialization.
74. Add webhook ACK deadline behavior: accepted ACK -> 2xx, ACK missing -> non-2xx.
75. Add duplicate Telegram retry handling with `duplicate_local` ACK.
76. Add bounded retry budget and terminal `delivery_unconfirmed` provider status.
77. Add provider-update vs webhook-attempt ledger split.
78. Add relay crash-window recovery tests around T1-T5 checkpoints.
79. Add relay metrics and redaction tests for logs/traces/support bundles.
80. Add official provider send result cache keyed by desktop request id, with no-blind-retry crash-window tests.
81. Add official outbound reply-parameter policy with `allow_sending_without_reply=false` by default.
82. Add relay health and ambiguous ownership recovery UI.
83. Add own-bot polling mode.
84. Add renderer connection wizard and health/repair UI.

## Top Open Risks

1. Native `SendMessage` actual stream shape.
   🎯 8   🛡️ 9   🧠 3   Need fixture/proof and normalizer. Local code currently prompts `to/message` but captures `recipient/content`.

2. Telegram private-chat topics across Telegram clients.
   🎯 8   🛡️ 9   🧠 7   API support is clear enough for the preferred design; strict default gate and sanitized live fixture matrix are still required before broad default rollout.

3. Official shared bot desktop relay ACK semantics.
   🎯 9   🛡️ 10   🧠 8   Telegram 2xx only after backend-accepted desktop durable ACK or terminal non-delivery before plaintext dispatch; SSE and Last-Event-ID are not ACK proof.

4. Claude lead runtime acceptance proof.
   🎯 8   🛡️ 8   🧠 8   Local CLI 2.1.119 replay probe works; still need Agent Teams launch fixture, prompt marker scan, and parser fixtures.

5. Exact launch-shape behavior of `--replay-user-messages`.
   🎯 7   🛡️ 8   🧠 6   Current team launch already has stream-json plus verbose; still need adding replay in the real team bootstrap/MCP path.

6. Stdout `type=user` classification after replay is enabled.
   🎯 8   🛡️ 9   🧠 5   Must classify app prompt replay with `isReplay=true` and known marker before permission/tool_result/teammate parsing.

7. Exact automatic reply proof for current native lead path.
   🎯 8   🛡️ 9   🧠 7   MVP should auto-send only explicit user-directed replies with exact `relayOfMessageId` or provider link; visible assistant text stays manual-review/local-only.

8. Active turn interleaving with existing lead prompts and relay jobs.
   🎯 9   🛡️ 9   🧠 8   Needs shared `LeadTurnGate` around UI sends, external messenger, post-compact reminders, Gemini hydration, legacy relay, and system recovery.

9. `TeamDataService.sendMessage()` `relayOfMessageId` pass-through.
   🎯 10   🛡️ 10   🧠 2   Concrete adapter gap before messenger reply projection can rely on UI/manual messages.

10. Provider outbound ambiguity.
   🎯 9   🛡️ 9   🧠 5   Need explicit `ambiguous` state and manual repair.

11. Teammate-to-user external projection policy.
   🎯 7   🛡️ 8   🧠 6   Send only when route-linked and external-safe.

12. Topic registry repair.
   🎯 8   🛡️ 9   🧠 6   Current recommendation: route generations, tombstones, and repair_required before reprovisioning.

13. Claim ACK missing after desktop received plaintext.
   🎯 9   🛡️ 9   🧠 6   Treat as ambiguous ownership, not offline; return non-2xx only within bounded retry budget, accept `duplicate_local`, then send `delivery_unconfirmed` and return 2xx.

14. Topic provisioning result lost after provider success.
   🎯 7   🛡️ 8   🧠 7   Official mode should use a backend result cache keyed by desktop provisionRequestId.

15. Official provider send result lost after Telegram success.
   🎯 9   🛡️ 9   🧠 7   Use desktop request id and backend metadata cache; S3 is the no-blind-retry boundary and S4 without S5 becomes `send_unknown`.

16. Claude Code Channels availability and stability.
   🎯 8   🛡️ 8   🧠 5   Use as reference only for MVP because docs mark it research preview and local help does not expose `--channels`.

17. One bot token with multiple receiving owners.
   🎯 9   🛡️ 9   🧠 5   Never run one Telegram poller per team or lead session; use one backend webhook owner or one desktop own-bot poller.

18. Private-chat topic UX across clients.
   🎯 6   🛡️ 8   🧠 6   Bot API supports it, but user-visible topic UX must be fixture-proven before topics are default.

19. CallbackQuery shape inside private bot-chat topics.
   🎯 7   🛡️ 8   🧠 5   Official `MaybeInaccessibleMessage` means activation must support stored probe-message fallback, not only `message_thread_id`.

20. Private-topic deleted-thread error descriptions.
   🎯 6   🛡️ 8   🧠 4   Need live provider responses before final terminal-error classifier.

21. Durable store boundary.
   🎯 9   🛡️ 9   🧠 7   Use one canonical `MessengerStateStore` for MVP; existing app stores are side-effect destinations.

22. Provider identity collapse.
   🎯 9   🛡️ 10   🧠 6   Keep update id, conversation id, message id, and reply reference as separate core types.

23. Provider-origin loop prevention.
   🎯 9   🛡️ 10   🧠 5   Provider inbound rows must never become provider outbox candidates.

24. Edit/delete behavior after runtime delivery.
   🎯 8   🛡️ 9   🧠 5   Append correction/tombstone instead of mutating delivered prompt text.

25. Future Discord route UX.
   🎯 6   🛡️ 7   🧠 7   Need product decision between DM selector and configured guild/thread mode.

26. WhatsApp practicality.
   🎯 7   🛡️ 7   🧠 8   No native team-topic container; keep as future selector-mode adapter.

27. Future Slack route abstraction.
   🎯 8   🛡️ 9   🧠 7   Slack has conversations and threads, not Telegram-style private topics; core needs route container/subroute plus capability-driven exact reply semantics.

28. Slack App Home thread discoverability.
   🎯 7   🛡️ 8   🧠 6   Home tab must make root threads easy to find, but root-thread history lives in Messages/app DM and Home tab has a 100 block limit.

29. Slack top-level DM misrouting.
   🎯 9   🛡️ 10   🧠 5   App-DM top-level text must be selector/control-plane only; routing it to the newest team would be a high-risk ambiguity bug.

30. Provider abstraction overfit.
   🎯 7   🛡️ 8   🧠 6   Add surface, route-entrypoint and interaction policies now, but avoid a generic plugin framework before Telegram MVP proves the lifecycle.

31. Shared LeadTurnGate regression risk.
   🎯 8   🛡️ 9   🧠 8   Architecturally needed, but touches a large service with UI sends, reminders, hydration, relay and result handling.

32. Visible assistant fallback semantics.
   🎯 6   🛡️ 7   🧠 5   Convenient, but can leak internal narration. Keep manual-review or local-only in MVP.

33. Permission relay through messenger.
   🎯 6   🛡️ 8   🧠 7   Official Channels pattern exists, but trust, audit and exact-verdict UX are not designed yet.

34. Partitioned JSON store vs SQLite.
   🎯 8   🛡️ 9   🧠 7   Current recommendation is partitioned versioned JSON behind `MessengerStateStorePort` first; SQLite is stronger but adds native/Electron packaging risk.

35. Local sent-message verification path.
   🎯 7   🛡️ 8   🧠 5   Existing sent persistence can log-and-swallow errors, so messenger needs read-back verification by deterministic message id.

36. Cross-store crash windows.
   🎯 9   🛡️ 9   🧠 7   Must use `LocalProjectionEffect` and recovery scanner so inbox/sent/provider side effects are idempotent.

37. Store compaction thresholds.
   🎯 7   🛡️ 8   🧠 4   Need local retention policy that never removes unresolved links, outbox rows, turns or repair tasks.

38. Exact webhook ACK deadline.
   🎯 7   🛡️ 8   🧠 5   Current estimate is 8000 ms default backend wait, configurable 5000-9000 ms; real Telegram staging metrics still needed.

39. Relay credential issuance and revocation UX.
   🎯 8   🛡️ 9   🧠 6   Current recommendation is RFC 8628-style device-code pairing with `verification_uri_complete`; exact account UI still needs design.

40. Backend claim-ledger retention.
   🎯 7   🛡️ 8   🧠 5   Must retain enough metadata for retries/audit without accidentally becoming a user-message shadow store.

41. Shared-bot per-binding backpressure under high traffic.
   🎯 7   🛡️ 8   🧠 7   Recommended policy is global concurrent webhooks plus per-binding serialized plaintext claims and 1000-2000 ms same-binding wait; needs load tests.

42. Privacy proof for official shared bot.
   🎯 8   🛡️ 9   🧠 6   Need automated tests that fail on plaintext persistence/logging of raw update, text, caption, token, authorization and provider bodies.

43. Telegram retry timing.
   🎯 6   🛡️ 8   🧠 5   Official docs do not publish exact webhook timeout/retry schedule; staging must measure retry intervals, pending_update_count and last_error_message.

44. `delivery_unconfirmed` product behavior.
   🎯 7   🛡️ 8   🧠 6   Technically safer than `offline`, but UX must prevent users from blindly resending duplicate-sensitive messages.

45. Claim-ledger retention defaults.
   🎯 7   🛡️ 8   🧠 5   Proposed hot metadata windows are 7 days for terminal success/offline/unsupported and 30 days for unconfirmed/repair; final values need support/privacy review.

46. Topic compatibility fixture coverage.
   🎯 6   🛡️ 9   🧠 6   Need maintained fixture evidence for Telegram Desktop, iOS, Android and Web before marking private topics production-default.

47. Topic route activation proof.
   🎯 8   🛡️ 9   🧠 6   Current recommendation supports callback same-thread, callback probe-message link and inbound same-thread proof; implementation must reject create/send-only activation.

48. Topic deletion and lost route repair.
   🎯 6   🛡️ 8   🧠 5   Send failures can drive repair, but there is no safe title-based route recovery and no reliable deleted-topic inbound event to depend on.

49. Native `SendMessage(to=user)` sidecar correctness.
   🎯 7   🛡️ 9   🧠 7   Native user-directed messages currently lack exact `relayOfMessageId`; auto-send needs sidecar exact-turn proof or must stay manual review.

50. Plain assistant text leak risk.
   🎯 9   🛡️ 10   🧠 4   Never project plain assistant text to Telegram by default; it may contain narration, status, or internal coordination.

51. Local projection verification before provider outbox.
   🎯 9   🛡️ 9   🧠 6   Provider outbox should be queued only after deterministic local row write and read-back verification.

52. `ExternalReplyProjectionIntent` ownership.
   🎯 9   🛡️ 10   🧠 7   A dedicated intent avoids provider sends from UI feed, timing, newest-row inference, or swallowed side-effect writes.

53. Outbound `send_unknown` UX.
   🎯 8   🛡️ 9   🧠 6   Pass 54 makes the state machine clear; exact final copy and link-entry UX still need product design.

54. Backend plaintext log/schema enforcement.
   🎯 8   🛡️ 9   🧠 6   Needs branded plaintext types, metadata-only schemas, redaction tests and log canaries.

55. Real Telegram webhook retry timing.
   🎯 6   🛡️ 8   🧠 5   Telegram documents retry on non-2xx but not exact retry timing; staging metrics are required.

56. Relay checkpoint over-trusting transport.
   🎯 9   🛡️ 10   🧠 5   Do not treat SSE write, open socket, EventSource reconnect or `Last-Event-ID` as durable delivery; only backend-accepted desktop ACK gates Telegram 2xx and runtime start.

57. Future multi-device and hosted web control.
   🎯 6   🛡️ 8   🧠 8   Current lease model can scale, but hosted web needs account auth, device pairing, lease ownership and audit.

58. Manual sent without provider link.
   🎯 7   🛡️ 8   🧠 5   Useful escape hatch, but exact reply-to routing for that Telegram message remains unavailable.

59. Multi-part unknown repair.
   🎯 7   🛡️ 8   🧠 6   Later parts must pause after an unknown part; exact UX for continuing unlinked chains still needs polish.

60. Telegram message-link repair in private bot-chat topics.
   🎯 5   🛡️ 7   🧠 5   Official link docs cover groups/channels; use reply-challenge repair for private bot-chat topics until fixtures prove pasted links.

61. Repair command leakage into normal routing.
   🎯 9   🛡️ 10   🧠 6   Repair command classifier must run before topic/team routing so `/sent <code>` never reaches lead stdin or teammate inbox.

62. Repair command deletion in private bot-chat topics.
   🎯 8   🛡️ 9   🧠 4   Bot API allows deleting incoming private-chat messages, `message_id` is unique in chat, and `deleteMessage` needs no thread id; exact private-topic fixture proof is still required.

63. Cleanup overpromising privacy.
   🎯 9   🛡️ 9   🧠 3   Deletion is UX cleanup, not security; one-time digest-stored tokens and route-scoped consumption must be safe even if Telegram keeps the command visible.

64. Private-topic default over-enables.
   🎯 8   🛡️ 10   🧠 7   `has_topics_enabled` alone is not enough; default needs mutation-policy, fixture and per-route activation proof or selector fallback.

65. Official outbound blind retry duplicate.
   🎯 9   🛡️ 9   🧠 7   Telegram `sendMessage` has no documented client idempotency key; timeout after provider request started becomes `send_unknown`, not auto-retry.

## What Is Decided

- Default official shared bot.
- Optional private own-bot mode.
- No Managed Bots as privacy story.
- One topic per team when the Telegram topic route container is active.
- Preferred Telegram route container is private-chat topics with our bot.
- Private-chat topics require `getMe` capability gate.
- Private-chat topics require live compatibility evidence before default rollout.
- Private-chat topics require a strict default gate, not just `has_topics_enabled=true`.
- Official shared bot private-topic default requires user topic mutation disabled.
- Own-bot private topics require the same proof chain or selector fallback.
- `has_topics_enabled=false` blocks topic provisioning.
- Unknown topic never routes to lead.
- Close/reopen are not private-topic MVP operations.
- Fallback selector mode is mandatory.
- Claude Code Channels are a reference pattern, not the MVP dependency.
- One provider account binding has one receiving owner.
- Do not spawn one Telegram poller per team or per lead session.
- Sender identity gates before route resolution.
- Remote chat cannot mutate connector access policy.
- Topic title is not identity.
- `message_thread_id` is durable route identity.
- Topic route activation needs proof, not just create success.
- Topic route activation needs persisted probe proof, not just send success.
- Callback route activation must support `MaybeInaccessibleMessage` by matching stored probe chat/message id plus signed nonce.
- If private-topic fixture evidence is missing or failed, selector mode is the default route container.
- Unknown/tombstoned topics do not route to lead.
- Missing `message_thread_id` is control/setup traffic in topic mode.
- Topic repairs create new route generations and keep tombstones.
- Provider update id and provider message id are separate.
- TeamRouteBinding chooses team scope.
- ExternalReplyTargetResolution chooses reply target from `ExternalMessageLink` proof.
- ExternalMessageLink stores provider/internal/target mapping.
- Reply text and quote text are display only.
- Telegram `external_reply` is not teammate-routeable in MVP.
- Telegram callback probe confirmation needs signed nonce and stored probe record.
- Provider-originated inbound rows never enqueue provider outbox.
- Edits after runtime delivery append correction rather than mutating delivered prompt text.
- Deleted/unavailable provider messages tombstone links but do not delete internal history.
- Reply-to can target teammate when provider link proves it.
- Teammate messages use the same team topic with a sender prefix when external-safe.
- Future Slack default is Home tab dashboard/control plus Messages tab or app DM root-thread per Agent Team.
- Slack Home tab is not canonical chat history.
- Slack top-level app-DM text is selector/control-plane traffic, not lead traffic.
- Slack normal thread replies route to lead by default.
- Slack teammate routing requires explicit target selection or exact provider reference.
- Core needs route entrypoint and surface abstractions before Slack, so Telegram topics stay adapter-specific.
- No plaintext durable backend queue in MVP.
- If desktop offline, say offline.
- Text-only Telegram MVP.
- MessengerRuntimeTurnLedger is mandatory.
- `stdin.write` callback is not runtime delivery proof.
- Claude lead should use `--replay-user-messages` plus transcript marker scan when replay capability is proven.
- `--replay-user-messages` must be classified before existing stdout `type=user` permission parsing.
- App-originated prompt replays must not be treated as runtime-native permission or teammate messages.
- Transcript marker proof needs a forward append observer, not the UI feed extractor.
- Active turn coordination must wrap all stdin writes, not only Telegram writes.
- Shared `LeadTurnGate` is required before Telegram E2E.
- `--replay-user-messages` replay event is acceptance proof, not reply ownership proof.
- App replay must contain a local prompt marker and must be classified before permission parsing.
- MVP Telegram auto-send should require explicit user-directed reply with exact relay/link proof.
- Visible assistant text without exact proof is manual review or local-only in MVP.
- Tool permission relay through Telegram is not MVP.
- `TeamDataService.sendMessage()` must pass `relayOfMessageId` through before connector reply projection relies on it.
- `relayLeadInboxMessages()` is not the messenger external turn engine.
- Provider outbox ambiguity is mandatory.
- Official relay ambiguous ownership state is mandatory.
- Desktop runtime must not start until backend accepts the local durable ACK.
- Official shared bot relay uses main-process HTTP streaming/SSE-wire downlink plus HTTPS/POST ACK uplink for MVP.
- Official shared bot relay uses a metadata-only backend claim ledger, not a plaintext backend queue.
- Official shared bot webhook success requires backend-accepted desktop durable ACK, or terminal non-delivery before plaintext dispatch.
- Once plaintext has been dispatched to desktop, that update is no longer eligible for an offline status.
- ACK missing after dispatch returns non-2xx to Telegram and stays ambiguous until duplicate/local ACK or terminal policy.
- ACK-missing retry is bounded: after retry budget expires, backend sends `delivery_unconfirmed` and returns 2xx.
- Recommended initial retry budget is 3 Telegram attempts or 120000 ms, with 8000 ms default ACK wait.
- `delivery_unconfirmed` is the correct provider-visible state after dispatch without ACK; it is not offline.
- `Last-Event-ID` is metadata resume state, not proof of desktop durable commit.
- SSE stream write/open socket is not proof of desktop durable commit.
- Relay crash windows T1-T5 require duplicate-safe recovery tests.
- Official relay plaintext is only allowed in backend request memory and active relay write buffers.
- Official outbound plaintext is only allowed in desktop local stores, backend send-proxy memory and active Telegram request buffers.
- Renderer cannot open the official relay stream, access relay credentials, or receive raw provider updates.
- Renderer/browser UI may receive normalized user-visible conversation DTOs after local commit.
- Relay credentials are device-bound and stored via the existing safeStorage/AES fallback vault pattern.
- Recommended relay credential setup is device-code style browser pairing with `verification_uri_complete` when available.
- Backend must verify webhook secret and sender identity before dispatching plaintext to desktop.
- Official shared bot plaintext claims are serialized per account binding.
- Backend claim ledger should split provider-update records from webhook-attempt records.
- Initial claim-ledger hot retention: 7 days for accepted/offline/unsupported, 30 days for unconfirmed/repair-required.
- Relay observability must be claim-id/metric based and must not include raw provider payload or user content.
- Official provider sends require backend metadata result cache keyed by desktop request id.
- Official provider sends may return `sent` to desktop only after provider metadata is persisted in the backend result cache.
- Official provider send `provider_request_started` is the no-blind-retry boundary.
- Official exact replies should use `reply_parameters.allow_sending_without_reply=false` unless the user explicitly approves detached send.
- Official topic provisioning requires backend metadata result cache keyed by provisionRequestId.
- Official topic provisioning result is not route activation proof by itself.
- Provider success before result-cache persist becomes `send_unknown` or `provision_unknown`, not auto-retry.
- Existing local Fastify `HttpServer` is the HTTP-first local app API boundary for messenger connectors.
- Protected messenger HTTP routes require local session auth, Host/Origin checks and CSRF for cookie-auth mutations.
- Local `HttpServer` is not the public Telegram webhook server.
- Electron IPC is not the primary messenger UI API; it remains for desktop shell actions and narrow compatibility bridges.
- MCP is for agent/runtime tools, not for Telegram/backend transport.
- Automatic Telegram replies require exact `relayOfMessageId` or explicit provider link.
- Plain assistant text is not projectable by default.
- Native `SendMessage(to="user")` is not Telegram-safe unless connector capture context attaches exact `relayOfMessageId`.
- Provider auto-send is created only from `ExternalReplyProjectionIntent`.
- `TeamMessageFeedService` inferred links are not provider-send proof.
- Native `SendMessage` needs a shared normalizer and exact sidecar proof before Telegram auto-send.
- OpenCode watchdog is the model to copy, not a direct dependency.
- `TeamMessageFeedService` is not the provider projection source.
- Critical connector state uses one canonical `MessengerStateStore` in MVP.
- Named connector stores are logical tables inside canonical state, not independent transactional files.
- Existing inbox/sent files are side-effect destinations, not provider-routing truth.
- Every local projection needs deterministic target message id, read-back verification and recovery.
- `ProviderOutboxItem` is created only after local visible reply projection is verified.
- Provider send started without durable result becomes `provider_send_unknown`, not auto-retry.
- `send_unknown` and `provider_send_unknown` are honest repair states, not hidden retry loops.
- `send_unknown` enters manual resolution, not auto-retry.
- Plain "Retry" is not a valid default action for `send_unknown`.
- `Mark sent without link` is allowed but does not restore exact provider reply link.
- `Link by Telegram reply` is the MVP path for `marked_sent_linked`.
- Pasted Telegram message links are not the default repair path for private bot-chat topics.
- Repair commands are pre-routing control-plane updates, not team messages.
- Repair command tokens are one-time, short-lived, digest-stored and scoped to route/outbox/chat/thread.
- Accepted and rejected repair commands are consumed and never delivered to lead/team.
- Repair command deletion is best-effort after local repair commit.
- Repair command cleanup is not a privacy/security boundary.
- Repair command cleanup stores metadata only and never stores raw command text or raw repair tokens.
- `deleteMessages` may be used later for cleanup batching, but MVP uses simple per-message `deleteMessage`.
- `Send duplicate anyway` requires explicit user approval and creates `duplicateOfOutboxId`.
- Multi-part outbound pauses after the first unknown part.
- SQLite is a future storage adapter option, not the default MVP dependency.
- Core route identity is provider-neutral route container plus optional subroute, not Telegram-specific topic semantics.
- Slack future default should be App Home Messages tab or app DM with one thread per Agent Teams team.
- Slack normal thread replies route to lead by default; teammate routing requires explicit target selection or a provider-proven exact reply reference.
- Slack HTTP Events ACK policy must not copy Telegram's desktop-ACK-before-provider-2xx policy by default.
- Slack message metadata is not secret and may contain only opaque non-sensitive correlation data.

## What Is Not Decided Yet

- Exact final webhook ACK deadline after staging Telegram metrics.
- Exact `delivery_unconfirmed` copy and desktop repair flow after ACK-missing retry budget expires.
- Exact final backend metadata claim-ledger retention window after support/privacy review.
- Exact relay credential account UI, device list, rotation and revocation UX.
- Exact production `setWebhook.max_connections` value and per-binding backpressure thresholds.
- Exact UX for `send_unknown` and `provision_unknown` repair.
- Exact user-facing copy for `provider_send_unknown` and possible duplicate warning.
- Exact provider message-link input/parsing UX for `Mark sent with link`.
- Exact live fixture for Telegram reply-challenge repair inside private bot-chat topics.
- Exact quiet-vs-visible invalid repair command UX.
- Exact repair token TTL after usability testing.
- Exact live fixture result for `deleteMessage` on incoming repair commands in private bot-chat topics.
- Whether multi-part Telegram messages ship in MVP or are deferred.
- Exact live-client behavior for private-chat topics on Telegram Desktop, iOS, Android, and Web.
- Exact product threshold for promoting private topics from gated default to unconditional default, if that ever happens.
- Exact callback shape in Telegram private-chat topics when clients age, messages are deleted, or message becomes inaccessible.
- Exact topic deletion/rename error classifiers from real Telegram responses.
- Exact UX copy for one-time account-level topic confirmation.
- Whether own-bot setup deletes existing webhook automatically or asks confirmation.
- Whether manual approval UI ships in MVP or only unresolved health state.
- Whether media support is text-only forever in official mode or added through encrypted queue later.
- Exact future Slack delivery mode: hosted official OAuth app, local/private Socket Mode app, or both.
- Exact Slack UX prototype for App Home team selector plus one thread per Agent Teams team.
- Exact Slack Home tab grouping/pagination layout for many Agent Teams.
- Exact Slack root-message Block Kit layout and update policy.
- Exact Slack hosted reliability mode if desktop is offline and no plaintext backend queue exists.
- Exact Slack teammate-target UX: interactive buttons, command syntax, mention parser, or all lead-by-default.
- Exact Slack Connect/channel-id repair behavior after live fixtures.
- Exact future Discord route container choice.
- Exact future WhatsApp route UX and compliance scope.
- Exact transcript cursor implementation for Claude lead JSONL.
- Exact timeout and retry thresholds for prompt marker observation.
- Exact compatibility impact of `--replay-user-messages` on the real Agent Teams stream-json parser.
- Exact launch-shape behavior of `--replay-user-messages` with current team bootstrap and MCP config.
- Exact `LeadTurnGate` migration plan for existing UI sends, post-compact reminders, Gemini hydration and legacy relay.
- Exact native `SendMessage` stream-json shape after fixture capture.
- Whether native `SendMessage` sidecar proof ships in MVP or only MCP `message_send` proof ships first.
- Exact account-level vs per-team canonical messenger store path.
- Exact local retention/compaction thresholds for processed updates, links, turns and send attempts.
- Exact future SQLite migration timing, if message volume makes JSON store too heavy.

## Source Links

- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram Bot API changelog: https://core.telegram.org/bots/api-changelog
- Telegram API deep links: https://core.telegram.org/api/links
- `User`: https://core.telegram.org/bots/api#user
- `getMe`: https://core.telegram.org/bots/api#getme
- `Message`: https://core.telegram.org/bots/api#message
- `CallbackQuery`: https://core.telegram.org/bots/api#callbackquery
- `MaybeInaccessibleMessage`: https://core.telegram.org/bots/api#maybeinaccessiblemessage
- `ForumTopic`: https://core.telegram.org/bots/api#forumtopic
- `sendMessage`: https://core.telegram.org/bots/api#sendmessage
- `ReplyParameters`: https://core.telegram.org/bots/api#replyparameters
- Telegram making requests when getting updates: https://core.telegram.org/bots/api#making-requests-when-getting-updates
- `getUpdates`: https://core.telegram.org/bots/api#getupdates
- `setWebhook`: https://core.telegram.org/bots/api#setwebhook
- `getWebhookInfo`: https://core.telegram.org/bots/api#getwebhookinfo
- Telegram getting updates: https://core.telegram.org/bots/api#getting-updates
- `createForumTopic`: https://core.telegram.org/bots/api#createforumtopic
- `editForumTopic`: https://core.telegram.org/bots/api#editforumtopic
- `deleteForumTopic`: https://core.telegram.org/bots/api#deleteforumtopic
- `getManagedBotToken`: https://core.telegram.org/bots/api#getmanagedbottoken
- `ResponseParameters`: https://core.telegram.org/bots/api#responseparameters
- `MessageEntity`: https://core.telegram.org/bots/api#messageentity
- `deleteMessage`: https://core.telegram.org/bots/api#deletemessage
- `deleteMessages`: https://core.telegram.org/bots/api#deletemessages
- `sendChatAction`: https://core.telegram.org/bots/api#sendchataction
- `sendMessageDraft`: https://core.telegram.org/bots/api#sendmessagedraft
- Claude Code headless mode: https://code.claude.com/docs/en/headless
- TDLib `createForumTopic`: https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1create_forum_topic.html
- WHATWG server-sent events: https://html.spec.whatwg.org/dev/server-sent-events.html
- MDN server-sent events: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- MDN Set-Cookie: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie
- OWASP CSRF Prevention Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- eventsource-parser npm: https://www.npmjs.com/package/eventsource-parser
- RFC 8628 OAuth 2.0 Device Authorization Grant: https://datatracker.ietf.org/doc/html/rfc8628
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- OpenTelemetry Semantic Conventions: https://opentelemetry.io/docs/concepts/semantic-conventions/
- p-queue npm: https://www.npmjs.com/package/p-queue
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-usage
- Claude Agent SDK streaming input: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- Claude Code Channels: https://code.claude.com/docs/en/channels
- Claude Code Channels reference: https://code.claude.com/docs/en/channels-reference
- Official Telegram channel plugin: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram
- Official Discord channel plugin: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord
- Discord Message Resource: https://docs.discord.com/developers/resources/message
- Discord Gateway Intents: https://docs.discord.com/developers/events/gateway
- Discord Threads: https://docs.discord.com/developers/topics/threads
- Slack Conversations API: https://docs.slack.dev/apis/web-api/using-the-conversations-api/
- Slack Conversation object: https://docs.slack.dev/reference/objects/conversation-object/
- Slack Messaging overview: https://docs.slack.dev/messaging/
- Slack `chat.postMessage`: https://docs.slack.dev/reference/methods/chat.postMessage/
- Slack `conversations.replies`: https://docs.slack.dev/reference/methods/conversations.replies/
- Slack `conversations.history`: https://docs.slack.dev/reference/methods/conversations.history/
- Slack `chat.getPermalink`: https://docs.slack.dev/reference/methods/chat.getPermalink/
- Slack App Home: https://docs.slack.dev/surfaces/app-home/
- Slack Block Kit: https://docs.slack.dev/block-kit/
- Slack Block Kit button element: https://docs.slack.dev/reference/block-kit/block-elements/button-element/
- Slack `message` event: https://docs.slack.dev/reference/events/message/
- Slack Events API: https://docs.slack.dev/apis/events-api/
- Slack Socket Mode: https://docs.slack.dev/apis/events-api/using-socket-mode/
- Slack request verification: https://docs.slack.dev/authentication/verifying-requests-from-slack/
- Slack OAuth install: https://docs.slack.dev/authentication/installing-with-oauth
- Slack token rotation: https://docs.slack.dev/authentication/using-token-rotation
- Meta WhatsApp Cloud API message send reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
- grammY npm: https://www.npmjs.com/package/grammy
- @grammyjs/types npm: https://www.npmjs.com/package/@grammyjs/types
- @slack/bolt npm: https://www.npmjs.com/package/@slack/bolt
- @slack/web-api npm: https://www.npmjs.com/package/@slack/web-api
- @slack/socket-mode npm: https://www.npmjs.com/package/@slack/socket-mode
- @slack/types npm: https://www.npmjs.com/package/@slack/types
- SQLite transactional docs: https://www.sqlite.org/transactional.html
- SQLite WAL docs: https://www.sqlite.org/wal.html
- Node `node:sqlite` docs: https://nodejs.org/api/sqlite.html
- better-sqlite3 npm: https://www.npmjs.com/package/better-sqlite3
- sqlite3 npm: https://www.npmjs.com/package/sqlite3
