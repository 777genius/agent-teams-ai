# Messenger Connectors - Uncertainty Pass 33

Date: 2026-04-29
Scope: Telegram account binding, connect wizard authorization, official shared bot vs own bot privacy, route ownership, revocation, and anti-hijack rules

## Executive Delta

The next lowest-confidence area is not the Telegram topic API.

It is the authorization boundary:

```text
desktop install
-> pending Telegram binding
-> Telegram user/chat identity
-> active team route
-> provider topic creation
-> future inbound/outbound permission
```

If this is wrong, the feature can look correct but still have severe bugs:

```text
1. A forwarded /start link binds the wrong Telegram account.
2. A stale pairing code reactivates an old route.
3. A username change breaks identity or routes to the wrong person.
4. A copied desktop config gives another OS user access to a Telegram route.
5. A backend log leaks chat ids, start payloads, or own-bot tokens.
6. A route is activated before the desktop confirms the Telegram claim.
```

The recommended shape is:

```text
Desktop creates one-time pairing challenge
-> user opens t.me/our_bot?start=<nonce>
-> backend records Telegram claim
-> desktop shows "Telegram account X wants to connect"
-> user confirms in desktop
-> route becomes active
-> team topics are created or reconciled
```

Do not treat Telegram `/start <payload>` alone as authorization. It proves that the message came from some Telegram account through Telegram, but it does not prove that the account is the same human currently controlling the desktop app.

## Source Facts Rechecked

Telegram official facts checked on 2026-04-29:

- Deep links let bots receive a `start` parameter in private chats. The parameter can use `A-Z`, `a-z`, `0-9`, `_`, `-`; Telegram recommends base64url, and the parameter can be up to 64 characters.
- Bot links have the shape `https://t.me/<bot_username>?start=<parameter>`.
- Bot API `Message` has `chat`, optional `from`, optional `message_thread_id`, and `is_topic_message` for forum supergroups or private chats with the bot.
- Bot API `User.id` is the stable identifier. It may exceed 32 bits but has at most 52 significant bits. `username` is optional and must not be the primary identity.
- Bot API `Chat.id` has the same 52-bit warning. Store it as string or signed 64-bit safe numeric representation, not as a JS lossy number in persistence boundaries.
- Bot API `setWebhook.secret_token` causes Telegram to send `X-Telegram-Bot-Api-Secret-Token` on webhook requests. This verifies the webhook was set by us, not user identity.
- Bot API 9.6, April 3, 2026, added Managed Bots. The created managed bot token can be fetched using `getManagedBotToken`. This means Managed Bots do not provide a "token hidden from manager bot/backend" privacy story if our bot/backend is the manager.
- Telegram Mini Apps/Login-style data can be validated through HMAC with the bot token, and newer third-party validation can use Telegram Ed25519 signatures. This is useful for a web identity step, but it is more product/backend complexity than the default bot chat wizard needs.

Sources:

- https://core.telegram.org/bots/features#deep-linking
- https://core.telegram.org/api/links#bot-links
- https://core.telegram.org/bots/api#message
- https://core.telegram.org/bots/api#user
- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#recent-changes
- https://core.telegram.org/bots/api#managedbotcreated
- https://core.telegram.org/bots/api#keyboardbuttonrequestmanagedbot
- https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

Local code facts checked:

- `docs/FEATURE_ARCHITECTURE_STANDARD.md` says medium/large cross-process features should live in a full feature slice with `contracts`, `core/domain`, `core/application`, `main`, `preload`, and `renderer`.
- No obvious existing install-id or messenger-binding model was found in local searches.
- `ConfigManager` persists app config at `~/.claude/agent-teams-config.json`.
- `getAppDataPath()` returns app-owned data under Electron `userData` or a fallback app data directory, explicitly separate from `~/.claude`.
- `ApiKeyService` already has a useful encrypted-secret pattern: Electron `safeStorage` first, AES-256-GCM local fallback, file mode `0o600`, and masked list output. This is relevant for optional own-bot token storage.
- Current inbox architecture is based on `~/.claude/teams/{teamName}/inboxes/{memberName}.json`, with known race handling and message ids from earlier research.

Implication:

```text
Messenger connectors need their own binding/security sub-slice.
This should not be bolted onto Settings config as plain fields.
```

## Top 3 Binding Options

### 1. Desktop-originated deep link plus desktop confirmation

🎯 9   🛡️ 9   🧠 6   Approx change size: 2500-5500 LOC

Flow:

```text
1. Desktop generates an install identity and opens a connector setup session.
2. Desktop asks official backend for a one-time pairing challenge.
3. Backend stores only a challenge hash, selected capabilities, TTL, and desktop session id.
4. Desktop shows QR/link: https://t.me/our_bot?start=<nonce>
5. User opens link in Telegram.
6. Official bot receives /start <nonce>.
7. Backend validates nonce, marks challenge as telegram_claimed, records Telegram user/chat identity.
8. Backend pushes "claim received" to desktop control channel.
9. Desktop shows Telegram profile preview and asks for explicit confirm.
10. Only after confirm, backend activates binding and the desktop creates/reconciles team routes/topics.
```

Why this is best:

- The `/start` link is convenient.
- A stolen link is not enough because the desktop still must confirm the exact Telegram account claim.
- The route cannot become active while the user is away from desktop setup.
- It fits official shared bot default.
- It can reuse the same route model for own-bot later.

Main weaknesses:

- Requires a live desktop to complete binding.
- Requires a backend control channel for official bot mode.
- Backend will know Telegram chat id for official shared bot routing. This can be minimized and encrypted at rest, but not eliminated if backend sends messages through the shared bot.

Verdict:

```text
Use as default MVP wizard.
```

### 2. Bot-first short code entered into desktop

🎯 8   🛡️ 8   🧠 5   Approx change size: 1800-4000 LOC

Flow:

```text
1. User opens our bot manually or from a generic link.
2. Bot creates a short visible code for that Telegram chat.
3. User enters or pastes the code into desktop.
4. Desktop sends the code to backend through its authenticated setup session.
5. Backend matches Telegram claim with desktop session.
6. Desktop confirms and activates binding.
```

Why it is useful:

- Works when deep links are blocked, copied incorrectly, or opened on the wrong device.
- The Telegram chat is already known before desktop confirmation.
- Good fallback for enterprise environments where QR/deep link is unreliable.

Main weaknesses:

- More user effort.
- Short visible codes need strict TTL, rate limits, and replay protection.
- If the user pastes code into the wrong desktop install, desktop confirmation still protects against silent activation, but UX can be confusing.

Verdict:

```text
Keep as fallback, not the primary happy path.
```

### 3. Telegram Mini App or Login Widget based verification

🎯 7   🛡️ 8   🧠 8   Approx change size: 3500-7500 LOC

Flow:

```text
1. User opens a Telegram Mini App or Login Widget.
2. Web identity data is validated using Telegram HMAC or Ed25519 validation.
3. Backend links that verified Telegram identity to the user's app account or desktop setup session.
4. Bot chat binding is completed after confirmation.
```

Why it is attractive:

- Strong web identity story.
- Better if Agent Teams later has real cloud accounts, team membership, device management, and web admin.
- Can support "manage all connected Telegram devices" in a richer UI.

Main weaknesses:

- Too much product surface for MVP.
- Needs domain setup, web identity screens, auth expiry rules, and account/device policy.
- Still does not remove the need to bind a bot chat/topic route for messaging.

Verdict:

```text
Good later for cloud account management.
Do not use as default MVP unless Agent Teams already depends on cloud login.
```

## Explicitly Rejected Option

### `/start` link alone activates the route

🎯 4   🛡️ 4   🧠 3   Approx change size: 900-2000 LOC

This is easy, but unsafe.

Failure case:

```text
1. Desktop shows a setup QR.
2. User screenshots or forwards it.
3. Another Telegram account opens it first.
4. Backend binds that chat to the user's teams.
5. The wrong Telegram account receives team replies.
```

This option can be patched with TTL and rate limits, but it still has the wrong trust boundary.

## Recommended Binding State Machine

```text
unbound
  -> desktop_pending
  -> telegram_claimed
  -> desktop_confirmed
  -> active
  -> revoked
```

Terminal or side states:

```text
expired
cancelled
suspicious
conflict
provider_unavailable
desktop_offline
```

Rules:

- `desktop_pending`: challenge exists, but no Telegram user is associated yet.
- `telegram_claimed`: Telegram user/chat has sent the nonce, but no route is active yet.
- `desktop_confirmed`: user explicitly accepted the claim in desktop.
- `active`: route may receive inbound Telegram messages and send outbound replies.
- `expired`: TTL elapsed before confirmation. The `/start` payload must become useless.
- `cancelled`: desktop cancelled setup. Later Telegram updates with that nonce get a generic expired response.
- `suspicious`: multiple different Telegram users tried the same nonce, too many attempts, or mismatch with an already active binding.
- `conflict`: same Telegram account/chat is already bound in a way that conflicts with the selected route policy.
- `revoked`: route exists historically but is not allowed to deliver.

Important invariant:

```text
No MessengerRoute can become active unless a Telegram claim and a desktop confirmation refer to the same pairing challenge id.
```

## Pairing Challenge Shape

Provider-neutral domain model:

```ts
interface MessengerPairingChallenge {
  id: string;
  provider: 'telegram';
  mode: 'official-shared-bot' | 'own-bot';
  installId: string;
  desktopSessionId: string;
  challengeHash: string;
  challengeCreatedAt: string;
  challengeExpiresAt: string;
  state:
    | 'desktop_pending'
    | 'telegram_claimed'
    | 'desktop_confirmed'
    | 'active'
    | 'expired'
    | 'cancelled'
    | 'suspicious'
    | 'conflict'
    | 'revoked';
  claimedBy?: {
    providerUserIdHash: string;
    providerChatIdHash: string;
    displayNameSnapshot: string;
    usernameSnapshot?: string;
    claimedAt: string;
  };
  capabilities: {
    canReceiveTeamTopics: boolean;
    canSendExternalUserMessages: boolean;
    canIssueCommands: boolean;
  };
}
```

Nonce rules:

- Generate at least 128 bits of randomness.
- Encode base64url without padding.
- Stay under Telegram's 64-character `start` limit.
- Store only a keyed hash server-side, not the raw nonce.
- TTL should be 5-10 minutes.
- Single use after `telegram_claimed`, with idempotent handling for duplicate update delivery.
- Never log raw nonce.

## Identity Model

Provider-neutral route ownership:

```ts
interface MessengerAccountBinding {
  id: string;
  provider: 'telegram';
  mode: 'official-shared-bot' | 'own-bot';
  installId: string;
  providerAccountRef: {
    userIdHash: string;
    chatIdHash: string;
    rawChatIdStorageRef?: string;
  };
  displaySnapshot: {
    firstName?: string;
    lastName?: string;
    username?: string;
    languageCode?: string;
  };
  status: 'active' | 'revoked' | 'disabled' | 'provider_blocked_bot';
  createdAt: string;
  confirmedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}
```

Identity rules:

- Telegram `user.id` is identity.
- Telegram `chat.id` is delivery destination.
- Telegram `username` is display metadata only.
- Store ids as strings at persistence/API boundaries to avoid JS precision mistakes.
- Hash ids for logs and list views.
- For official shared bot, backend needs a usable chat id at send time. Use KMS/envelope encryption at rest and redact logs. Do not pretend the backend has zero access.
- For own-bot local mode, raw bot token and chat ids can stay local. This is the cleanest privacy story.

## Official Shared Bot Privacy Story

What is true:

```text
Our backend receives Telegram webhook updates.
Our backend sees enough Telegram identity to route the message.
Our backend needs enough delivery identity to call sendMessage through our shared bot.
```

What we can do:

```text
1. No durable plaintext message queue while desktop is offline.
2. Encrypt chat ids at rest.
3. Hash ids in logs and analytics.
4. Store minimal Telegram profile snapshots.
5. Keep message bodies out of backend durable storage in default mode.
6. If desktop is offline, send a clear offline notice instead of queueing plaintext.
```

What we cannot honestly claim:

```text
The official shared bot backend never sees Telegram metadata.
```

Recommended copy:

```text
Default bot is easiest: messages pass through Agent Teams relay while your desktop is online.
We do not store message bodies in the default relay queue.
For maximum privacy, connect your own bot locally.
```

## Managed Bots Privacy Recheck

Managed Bots are useful, but not for "token invisible to us" if our bot/backend is the manager.

Official docs say:

```text
ManagedBotCreated.bot token can be fetched using getManagedBotToken.
ManagedBotUpdated.bot token can be fetched using getManagedBotToken.
```

So the manager bot can fetch the created bot token.

This means:

```text
If our backend runs the manager bot, our backend can technically get the managed bot token.
```

Managed Bots can still be useful for convenience:

- Less copy/paste from BotFather.
- Better guided creation.
- Automatic suggested name/username.
- Token rotation through `replaceManagedBotToken`.

But the privacy label should be:

```text
Convenient customer-owned bot, managed by Agent Teams
```

not:

```text
Private token that Agent Teams cannot access
```

For the clean privacy option, user should create a bot in BotFather and paste token into desktop locally, or use a future flow where a locally running manager process receives the token directly and never sends it to our backend. That local-manager flow is probably too complex for MVP.

## Own-Bot Binding Flow

Own-bot mode still needs a Telegram account/chat binding.

Recommended own-bot flow:

```text
1. User creates bot in BotFather.
2. User pastes token into desktop.
3. Desktop validates getMe.
4. Desktop stores token using a SecretStoragePort based on ApiKeyService-style safeStorage/AES fallback.
5. Desktop checks getWebhookInfo.
6. If webhook exists, explain conflict and ask before deleteWebhook.
7. Desktop starts getUpdates long polling.
8. User sends /start to their own bot.
9. Desktop receives the update locally.
10. Desktop asks user to confirm the Telegram account/chat.
11. Desktop activates binding and creates topics/routes.
```

Edge case:

```text
getUpdates does not work while an outgoing webhook is set.
```

So never silently call `deleteWebhook` for an own bot. The bot may be used elsewhere.

## Route Activation Rules

After binding, route creation should be explicit:

```ts
interface MessengerRoute {
  id: string;
  bindingId: string;
  provider: 'telegram';
  teamId: string;
  teamIdentitySnapshot: {
    teamName: string;
    teamPath?: string;
    teamConfigHash?: string;
  };
  topicRef?: {
    providerChatIdHash: string;
    providerMessageThreadId: string;
    topicNameSnapshot: string;
    topicCreatedAt: string;
  };
  status: 'active' | 'disabled' | 'revoked' | 'needs_repair';
  createdAt: string;
  updatedAt: string;
}
```

Rules:

- Binding is account-level.
- Route is team-level.
- Topic is provider-level delivery state.
- One Telegram account can bind to multiple teams.
- One team route maps to one Telegram topic in that account's bot chat.
- Topic title is display metadata only. Never route by title.
- If topic id is missing or stale, mark `needs_repair` and create a new topic after user confirmation.

## Multi-Team and Multi-Account Policy

MVP policy:

```text
One Telegram account binding per desktop install.
Many team routes under that binding.
One topic per team route.
```

Later policy:

```text
Multiple Telegram accounts per install.
Each account can opt into selected teams.
Routes must include bindingId.
UI can show "Connected as @alice" per route.
```

Do not key route ownership only by `teamName`.

Use a stable team id or derived identity:

```text
teamId = persisted id if available
fallback = hash(canonical team path + creation marker)
teamName = mutable display snapshot
```

This is important because previous local research found many surfaces still use names like `teamName` and `memberName`.

## Threat Model and Required Controls

### Forwarded setup link or screenshot

Control:

```text
Desktop confirmation is mandatory.
```

The Telegram claim only moves challenge to `telegram_claimed`.

### Stale or replayed nonce

Controls:

```text
TTL 5-10 minutes
single-use challenge hash
state transition compare-and-swap
idempotent duplicate update handling
generic expired response
```

### Two Telegram users race the same nonce

Control:

```text
First claim locks the challenge.
Second distinct user marks suspicious or gets generic expired response.
Desktop must show the first claimed display name before confirm.
```

### Username changed

Control:

```text
Never use username for identity.
Update display snapshot from new messages.
```

### Wrong chat type

Control:

```text
Official MVP accepts only private chat with the bot.
Group/supergroup/channel starts are rejected unless a future group-mode route is explicitly built.
```

### Telegram user blocks bot

Control:

```text
Outbound send failure transitions binding or route to provider_blocked_bot / needs_attention.
Do not keep retrying indefinitely.
```

### Desktop offline after binding

Control:

```text
Default official mode has no durable plaintext backend queue.
Backend replies with offline notice or "desktop unavailable".
```

### Backend receives duplicate Telegram updates

Control:

```text
ProviderUpdateLedger keyed by provider + botMode + update_id.
Idempotent inbound message creation.
```

### Backend restart during claimed-but-unconfirmed pairing

Control:

```text
Persist pending challenge state with TTL.
Desktop reconnect asks for current challenge status.
```

### User reinstalls desktop

Control:

```text
Install identity is local.
If lost, existing bindings become orphaned until user reconnects.
Offer revoke from Telegram with /disconnect.
```

### Shared computer or copied config

Control:

```text
Store install secret under app data using OS secret storage where possible.
Copying JSON config alone should not authenticate a binding.
```

### Own-bot token leaked

Controls:

```text
SafeStorage/AES fallback
0o600 file permissions
masked list output
redacted logs
explicit token rotation and delete
```

### Managed bot token fetched by our backend

Control:

```text
Do not market Managed Bots as token-private.
Offer "own token locally" for maximum privacy.
```

## Security Storage Recommendation

Create feature-local ports:

```ts
interface MessengerInstallIdentityStore {
  getOrCreateInstallIdentity(): Promise<MessengerInstallIdentity>;
  rotateInstallSecret(reason: string): Promise<void>;
}

interface MessengerSecretStore {
  saveSecret(ref: string, plaintext: string): Promise<void>;
  readSecret(ref: string): Promise<string | null>;
  deleteSecret(ref: string): Promise<void>;
  getStatus(): Promise<SecretStorageStatus>;
}
```

Implementation:

- For local desktop, adapt the existing `ApiKeyService` encryption strategy.
- Do not import `ApiKeyService` directly into core.
- Keep plaintext secrets out of renderer contracts.
- Renderer gets masked status only.
- Main process owns token validation, storage, polling, and provider calls.

Storage location:

```text
App-owned data under getAppDataPath(), not ~/.claude/teams.
```

Reason:

```text
Messenger bindings are app integration state, not agent CLI/team project data.
```

## Backend Data Minimization for Official Bot

Backend tables should separate routing metadata from message payloads.

Minimum default mode:

```text
messenger_bindings
  binding_id
  provider
  install_id_hash
  telegram_user_id_hmac
  telegram_chat_id_ciphertext
  display_snapshot
  status
  created_at
  confirmed_at

messenger_routes
  route_id
  binding_id
  team_id_hash
  provider_thread_id
  status
  created_at
  updated_at

telegram_update_ledger
  bot_mode
  update_id
  update_type
  processed_at
  result_kind
```

Avoid in default mode:

```text
durable plaintext inbound bodies
durable plaintext outbound bodies
raw Telegram ids in logs
raw start payloads in logs
own-bot tokens on backend
```

If we later add encrypted queue:

```text
desktop public key
backend stores ciphertext only
desktop decrypts when online
outbound offline queue requires explicit user opt-in
```

## Connect Wizard UX

Recommended happy path:

```text
Settings -> Messenger -> Telegram -> Connect

Step 1: Choose mode
  Default: Agent Teams bot
  Advanced: My own bot

Step 2: Select teams
  All active teams by default, editable checklist

Step 3: Open Telegram
  QR + button, expires countdown

Step 4: Confirm
  "Telegram account @alice wants to connect"
  show first name, username, provider user id suffix/hash

Step 5: Topics
  create one topic per selected team
  show per-team success/needs repair
```

Failure UI:

- Link expired: one-click regenerate.
- Wrong Telegram account claimed: cancel and regenerate.
- Desktop offline during claim: bot says "finish setup on desktop".
- Topic creation failed: binding can still be active, route is `needs_repair`.
- Bot blocked: show reconnect instructions.

No hidden auto-activation.

## Clean Architecture Placement

Feature slice:

```text
src/features/messenger-connectors/
  contracts/
    index.ts
    messengerConnectorApi.ts
    telegramDtos.ts
  core/
    domain/
      bindingState.ts
      pairingChallenge.ts
      routePolicy.ts
      providerIdentity.ts
      visibilityPolicy.ts
    application/
      ports/
        MessengerBindingStore.ts
        MessengerSecretStore.ts
        MessengerProviderGateway.ts
        MessengerDesktopSessionGateway.ts
      StartPairingUseCase.ts
      ClaimPairingUseCase.ts
      ConfirmPairingUseCase.ts
      RevokeBindingUseCase.ts
      RepairRoutesUseCase.ts
  main/
    composition/
    adapters/
      input/
        messengerIpcHandlers.ts
        telegramWebhookRoutes.ts
      output/
        TelegramOfficialBotGateway.ts
        TelegramOwnBotGateway.ts
        FileMessengerBindingStore.ts
        ElectronMessengerSecretStore.ts
    infrastructure/
      telegram/
      storage/
      crypto/
  preload/
  renderer/
```

Important dependency rule:

```text
Telegram API specifics are adapter details.
Binding state, route state, replay prevention, and privacy policy are core/application rules.
```

## Tests To Add Before Shipping

Domain/application:

- `startPairing` creates a challenge with TTL and hashed nonce.
- `claimPairing` rejects unknown nonce.
- `claimPairing` rejects expired nonce.
- `claimPairing` is idempotent for duplicate same Telegram update.
- `claimPairing` marks suspicious for a different user racing the same nonce.
- `confirmPairing` fails if no Telegram claim exists.
- `confirmPairing` activates only the claimed binding.
- `cancelPairing` prevents later activation.
- `revokeBinding` disables routes.
- `routePolicy` never keys by username or topic title.

Adapter/integration:

- Telegram webhook verifies `secret_token`.
- Telegram update ledger dedupes `update_id`.
- `/start` in group/supergroup is rejected in MVP.
- JS persistence stores Telegram ids as strings.
- Raw nonce is not logged.
- Raw own-bot token is not sent to renderer.
- Own-bot `getWebhookInfo.url` conflict is surfaced before `deleteWebhook`.
- `safeStorage` unavailable path still encrypts with AES fallback and file mode is restrictive.

End-to-end scenarios:

- Happy path official bot connect.
- Forwarded link claimed by wrong Telegram account, desktop cancels, no route active.
- Link expires, user regenerates, old link stays dead.
- Two users race same link.
- Desktop restarts after Telegram claim and before confirm.
- User blocks bot after binding.
- User revokes binding from desktop.
- User sends `/disconnect` in Telegram.
- Team renamed after topic exists.
- Team route repair creates new topic without reusing title as identity.

## Decision Update

The best implementation decision after this pass:

```text
Default:
  official shared bot
  desktop-originated one-time deep link
  desktop confirmation required
  no durable plaintext backend message queue
  one topic per team route

Fallback:
  bot-first short code entry

Advanced privacy:
  own bot token pasted into desktop
  token stored locally
  local getUpdates polling

Later:
  encrypted backend queue
  Telegram Mini App/Login identity layer
  Managed Bots only as convenience, not as "token inaccessible to us"
```

Main open question left:

```text
Do we want one Telegram account per desktop install for MVP,
or allow multiple connected Telegram accounts immediately?
```

My recommendation:

🎯 9   🛡️ 8   🧠 4   Approx change size: +600-1200 LOC compared to account-agnostic routing

```text
Start with one account per install, but include bindingId in every route model.
That keeps MVP UX simple and leaves the data model ready for multi-account later.
```
