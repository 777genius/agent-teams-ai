# Messenger Connectors - Uncertainty Pass 34

Date: 2026-04-29
Scope: official shared bot relay transport, webhook ACK semantics, desktop online detection, no durable plaintext backend queue, and local commit guarantees

## Executive Delta

The weakest reliability boundary is:

```text
Telegram webhook
-> Agent Teams backend
-> online desktop relay session
-> durable local inbound message
-> lead/team routing
```

The core problem:

```text
If backend returns HTTP 2xx to Telegram before the desktop durably commits the message,
then a crash, reconnect, or dropped ACK can lose the user message forever.
```

Because the default product decision is "no durable plaintext backend queue", the backend cannot solve this by storing pending message bodies until desktop returns.

So the default official-bot rule should be:

```text
Return success to Telegram only after one of these is true:

1. Desktop ACKed that it durably committed the inbound message locally.
2. Backend handled the update terminally, for example no desktop is online and an offline notice was sent.
3. Backend intentionally rejects the webhook attempt so Telegram retries later.
```

This is the exact bridge that must be designed as a protocol, not as a best-effort event bus.

## Source Facts Rechecked

Telegram official facts checked on 2026-04-29:

- Bot API has two mutually exclusive update delivery modes: `getUpdates` and webhooks.
- Incoming updates are stored on Telegram servers until the bot receives them, but not longer than 24 hours.
- `getUpdates.offset` confirms updates when the offset is greater than their `update_id`.
- `Update.update_id` is useful for ignoring repeated updates or restoring sequence if webhook updates are out of order.
- `setWebhook.max_connections` controls the maximum simultaneous HTTPS connections Telegram may use for webhook delivery.
- On webhook delivery, unsuccessful requests are retried for a reasonable number of attempts.
- `WebhookInfo.pending_update_count`, `last_error_date`, and `last_error_message` expose webhook backlog/error state.
- `setWebhook.secret_token` adds `X-Telegram-Bot-Api-Secret-Token` to webhook requests.

Transport facts checked on 2026-04-29:

- Node.js v22 has a stable native WebSocket client API.
- Node.js v22 does not provide a built-in WebSocket server, so a Node backend still needs a server library.
- WebSocket is full-duplex over one connection, which fits `offer -> ACK -> control` flows.
- Server-Sent Events are one-way server-to-client. Client ACKs require a separate HTTP request.
- SSE supports `id` and reconnection behavior through EventSource, but it is still one-way.
- Existing repo already uses Fastify 5.7.4. `@fastify/websocket` 11.2.0 is the current npm package for WebSocket support and is built on `ws@8`.
- Snyk lists `ws@8.20.0` as published March 21, 2026, latest, with no direct vulnerabilities in its database at lookup time.

Sources:

- https://core.telegram.org/bots/api#getting-updates
- https://core.telegram.org/bots/api#update
- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#getwebhookinfo
- https://nodejs.org/learn/getting-started/websocket
- https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
- https://www.npmjs.com/package/%40fastify/websocket
- https://security.snyk.io/package/npm/ws/8.20.0

Local code facts checked:

- Existing `HttpServer` is Fastify-based and binds to `127.0.0.1` by default for local app/browser API.
- Existing `src/main/http/events.ts` implements SSE for local UI clients, with keepalive comments every 30 seconds.
- That SSE stream has no durable event id/resume model and no client-to-server ACK path. It is fine for local UI refresh, not for Telegram relay commit.
- The repo already has good local durability patterns:
  - `VersionedJsonStore.updateLocked()`
  - `atomicWriteAsync`
  - `withFileLock`
  - runtime delivery journals with payload hash, pending/committed states, idempotency keys
- These patterns are directly relevant to the desktop-local inbound store and delivery ledger.

Implication:

```text
Do not reuse the existing local SSE event broadcaster as the official bot relay.
Build a dedicated MessengerRelay protocol.
```

## Top 3 Relay Architecture Options

### 1. Desktop outbound WebSocket with local-commit ACK

🎯 9   🛡️ 8   🧠 7   Approx change size: 4000-8500 LOC

Shape:

```text
desktop main process
  opens WSS connection to Agent Teams relay backend
  authenticates install/binding/session
  sends route inventory hash and heartbeat

backend
  receives Telegram webhook
  resolves binding/route/topic
  sends inbound offer over WebSocket
  waits for desktop local-commit ACK
  returns Telegram 2xx only after commit ACK
```

Why this is best:

- WebSocket is bidirectional, so `offer -> ack -> cancel -> repair -> heartbeat` stays on one connection.
- Desktop can use Node 22 native WebSocket client with no new desktop dependency.
- Backend can use Fastify + `@fastify/websocket` if cloud backend is Node/Fastify.
- It supports real online presence, route inventory sync, and backpressure.
- It avoids backend durable plaintext message bodies.

Weaknesses:

- Needs a real protocol, not just "send JSON over socket".
- Needs careful ACK timeout and reconnect behavior.
- Backend still holds plaintext in memory during the webhook attempt.
- Active-session ACK timeout is ambiguous: desktop might have committed but ACK was lost.

Verdict:

```text
Use this for default official shared bot.
```

### 2. SSE downlink plus HTTPS ACK uplink

🎯 7   🛡️ 7   🧠 6   Approx change size: 3500-7000 LOC

Shape:

```text
desktop opens EventSource/SSE to backend
backend pushes inbound offers over SSE
desktop POSTs /ack for local commit
desktop POSTs heartbeat/inventory separately
```

Why it is attractive:

- SSE is simple and HTTP-friendly.
- Browser/EventSource has reconnect behavior.
- This resembles the repo's local `/api/events` pattern.

Weaknesses:

- SSE is one-way, so ACKs and heartbeats need extra HTTP calls.
- Correlating SSE offer with POST ACK is more complex under reconnect.
- Existing local SSE implementation lacks durable event ids and Last-Event-ID resume.
- Browser SSE connection limits matter for renderer use. Desktop main process can avoid browser limits, but the protocol is still less direct than WebSocket.

Verdict:

```text
Acceptable fallback if WebSocket is blocked by enterprise proxies.
Not the primary implementation.
```

### 3. Desktop polling/long-polling relay

🎯 6   🛡️ 6   🧠 4   Approx change size: 2200-5000 LOC

Shape:

```text
desktop polls backend for pending inbound updates
backend returns message bodies if any
desktop commits locally and POSTs ACK
```

Why it is attractive:

- Easier to reason about than long-lived sockets.
- Works in many locked-down networks.
- Simple to implement initially.

Weaknesses:

- To avoid message loss, backend must hold pending plaintext while waiting for poll.
- If backend refuses durable plaintext queue, polling becomes either lossy or high-frequency.
- Latency is worse.
- Online/offline state becomes fuzzy.

Verdict:

```text
Not recommended for default no-plaintext-queue mode.
Can be a diagnostics fallback, not the main relay.
```

## Future Reliability Option

### Durable encrypted backend queue

🎯 8   🛡️ 9   🧠 9   Approx change size: 7000-14000 LOC

Shape:

```text
desktop publishes public encryption key during binding
backend stores only ciphertext message bodies
desktop decrypts when online
backend can survive restarts and desktop offline windows
```

This is the right advanced/premium reliability mode, but it is not the MVP default.

Why:

- Key rotation is non-trivial.
- Device loss/reinstall can make queued messages undecryptable.
- Multi-device routing becomes harder.
- Attachments need a separate encrypted blob policy.
- User copy must explain exactly who can decrypt what.

## Recommended Default Protocol

### High-level flow

```text
Telegram -> Backend webhook
  1. verify webhook secret_token
  2. dedupe update_id metadata
  3. resolve binding/route/topic
  4. check active desktop relay session
  5. if no healthy session: send offline notice, return 2xx
  6. if healthy session: offer update to desktop
  7. desktop validates route and commits local inbound message
  8. desktop ACKs local commit
  9. backend returns 2xx to Telegram
```

The backend durable metadata ledger may store:

```text
provider
bot mode
update_id
route id
binding id
attempt count
status
timestamps
error class
payload hash
```

It should not store in default mode:

```text
raw message body
raw Telegram chat id in logs
raw Telegram user id in logs
attachment file bodies
bot tokens
```

### Webhook ACK invariant

```text
Telegram 2xx means:
  Agent Teams either got the message durably into desktop local storage,
  or intentionally terminal-handled it, for example offline notice.
```

Telegram non-2xx means:

```text
Agent Teams has not accepted responsibility for the update.
Telegram may retry the same update later.
```

This must be an explicit code invariant.

## Active Session Definition

Do not define "online" as "there is a socket object".

Define it as:

```ts
interface MessengerRelaySession {
  sessionId: string;
  installId: string;
  bindingId: string;
  authenticatedAt: string;
  lastHeartbeatAt: string;
  lastPongAt: string;
  routeInventoryHash: string;
  protocolVersion: number;
  status: 'ready' | 'stale' | 'draining' | 'closed';
}
```

A session is healthy only if:

```text
status == ready
authenticated install secret is valid
binding is active
route inventory hash is current or compatible
last pong is recent
desktop protocol version is supported
no newer session has stolen the lease
```

Suggested timing:

```text
ping interval: 15s
stale after: 45s
hard close after: 75s
inbound offer ACK deadline: 3-8s
```

Use jitter for reconnect:

```text
initial reconnect: 1s
max reconnect: 30s
jitter: 20-40 percent
```

## Single Active Session Lease

MVP should allow one active relay session per binding.

Rule:

```text
New authenticated session for the same bindingId steals the lease.
Old session transitions to draining/closed and cannot ACK new offers.
```

Why:

- Prevents two desktop processes writing the same Telegram update to different local stores.
- Avoids split-brain if user launches two app instances.
- Keeps support/debugging simpler.

Later multi-device mode can use:

```text
bindingId + deviceId + route assignment
```

But do not start there.

## Inbound Offer Envelope

Provider-neutral envelope:

```ts
interface MessengerInboundOffer {
  type: 'messenger.inbound.offer';
  protocolVersion: 1;
  deliveryId: string;
  provider: 'telegram';
  bindingId: string;
  routeId: string;
  orderingKey: string;
  providerUpdateId: string;
  providerMessageId?: string;
  providerMessageThreadId?: string;
  providerDate?: string;
  receivedAt: string;
  expiresAt: string;
  payloadHash: string;
  payload: MessengerInboundPayload;
}
```

Payload:

```ts
interface MessengerInboundPayload {
  kind: 'text' | 'command' | 'unsupported';
  text?: string;
  replyTo?: ProviderMessageLink;
  sender: {
    providerUserIdHash: string;
    displayNameSnapshot: string;
    usernameSnapshot?: string;
  };
}
```

Desktop ACK:

```ts
type MessengerInboundAck =
  | {
      type: 'messenger.inbound.ack';
      deliveryId: string;
      status: 'committed';
      localMessageId: string;
      localCommitHash: string;
      committedAt: string;
    }
  | {
      type: 'messenger.inbound.ack';
      deliveryId: string;
      status: 'duplicate_committed';
      localMessageId: string;
      committedAt: string;
    }
  | {
      type: 'messenger.inbound.ack';
      deliveryId: string;
      status: 'rejected_terminal' | 'rejected_retryable';
      reasonCode: string;
      detail?: string;
    };
```

## Desktop Local Commit Rules

Desktop must ACK `committed` only after:

```text
1. Provider update id was deduped locally.
2. Route binding is still active.
3. Message payload passed visibility/safety validation.
4. Message was written to a local durable inbound store.
5. Local store fsync/atomic-write equivalent completed as far as our platform layer supports.
```

Recommended stores:

```text
MessengerDesktopInboundStore
  durable provider update payloads after acceptance

MessengerLocalDeliveryLedger
  tracks delivery from inbound store to lead/team inbox

MessengerProviderUpdateLedger
  dedupes providerUpdateId locally
```

Do not ACK based on:

```text
renderer state update
toast notification shown
in-memory queue push only
lead process prompt accepted but not persisted
```

## Backend Webhook Decision Matrix

### No active session

```text
send offline notice
return Telegram 2xx
record metadata: terminal_offline
```

This matches the current product decision:

```text
desktop offline -> no plaintext queue -> honest offline response
```

### Active session, offer ACKed committed

```text
return Telegram 2xx
record metadata: desktop_committed
```

### Active session, duplicate committed ACK

```text
return Telegram 2xx
record metadata: duplicate_desktop_committed
```

### Active session, terminal reject

Examples:

```text
route revoked
unknown topic
unsupported chat type
payload rejected by policy
```

Action:

```text
send user-facing rejection if useful
return Telegram 2xx
record metadata: terminal_rejected
```

### Active session, retryable reject

Examples:

```text
local store locked
team route repairing
desktop still loading route inventory
```

Action:

```text
return Telegram 503 for a bounded number of attempts or bounded age
then fall back to offline/degraded notice and 2xx
```

### Active session, no ACK before deadline

This is the hardest case.

Recommended:

```text
1. Mark metadata: ack_timeout_ambiguous.
2. Return Telegram 503 if within retry budget.
3. On retry, re-offer with same providerUpdateId and payloadHash.
4. Desktop must return duplicate_committed if it already wrote the message.
5. If retry budget expires, send "delivery uncertain/offline" notice and return 2xx.
```

Do not immediately send a definitive "not delivered" notice after an ACK timeout, because the desktop might have committed and the ACK may have been lost.

## Retry Budget

Use Telegram retries only for ambiguous transient failures, not as a product queue.

Suggested initial policy:

```text
max retry deferrals per update: 2
max retry window: 30-60s
if no healthy desktop by then: offline/degraded notice and 2xx
```

Why:

- Keeps the product promise: no default durable backend plaintext queue.
- Avoids indefinite webhook backlog.
- Lets short reconnects recover.
- Does not silently turn Telegram into a long-term queue.

## Ordering Rules

Telegram `update_id` is useful for duplicate detection, but do not assume every update id is contiguous forever.

Route ordering should use:

```text
orderingKey = provider + bindingId + routeId
providerOrder = update_id plus provider message date/message_id when available
```

Backend:

```text
Use an in-memory per-route serial executor while the process is alive.
Do not persist plaintext to achieve ordering in default mode.
```

Desktop:

```text
Deduplicate by providerUpdateId.
Append accepted messages in provider order when possible.
If out-of-order arrival is detected, store both and mark ordering warning.
```

Webhook setting:

```text
Do not set max_connections to 1 globally for the shared bot unless traffic is tiny.
Use route-level ordering instead.
```

Reason:

```text
max_connections=1 would serialize every customer through one webhook lane.
That is safe but does not scale.
```

## Route Inventory Handshake

When desktop connects:

```text
1. authenticate install/binding
2. send protocol version
3. send route inventory hash
4. backend responds with active routes known server-side
5. desktop responds with local route inventory
6. both sides mark compatible or needs_repair
```

If route inventory mismatches:

```text
do not deliver inbound user messages into uncertain routes
ask desktop to repair or refresh
```

This protects cases like:

- team deleted locally
- team renamed
- topic recreated
- binding revoked on another process
- local route store restored from old backup

## Desktop To Lead Delivery

The desktop local commit should not directly mean "agent saw it".

Better state split:

```text
provider update accepted locally
-> local inbound message committed
-> route to lead/team inbox scheduled
-> inbox write committed
-> agent turn started
-> response captured
-> outbound provider delivery ledger
```

If inbox write fails after ACKing Telegram:

```text
The message is not lost because it is in MessengerDesktopInboundStore.
MessengerLocalDeliveryLedger can retry delivery to lead/team inbox.
```

This is the same reliability style as existing runtime delivery journals.

## Official Bot vs Own Bot Difference

Official shared bot default:

```text
Telegram sends webhooks to our backend.
Backend must decide quickly whether desktop accepted the update.
If desktop is offline, backend sends offline notice and ACKs Telegram.
No catch-up after offline notice.
```

Own bot local mode:

```text
Desktop can use getUpdates long polling directly.
If desktop is offline, Telegram may retain updates for up to 24 hours.
When desktop returns, it can catch up, because Telegram is the queue.
```

This means own-bot mode has a surprising reliability advantage:

```text
It can support Telegram-side catch-up without our backend storing plaintext.
```

But UX must say it clearly:

```text
Own bot can catch up recent Telegram updates while your computer was asleep, subject to Telegram retention.
Default Agent Teams bot replies offline instead of queueing by default.
```

## Technology Recommendation

### Desktop main process client

Use Node 22 native WebSocket client.

🎯 9   🛡️ 8   🧠 4   Approx change size: 700-1400 LOC

Why:

- No new dependency for desktop client.
- Node docs say v22.4.0 marked WebSocket stable.
- Full-duplex fits ACK/control messages.

### Backend WebSocket server

If backend is Node/Fastify, use `@fastify/websocket` 11.2.0.

🎯 8   🛡️ 8   🧠 5   Approx change size: 900-1800 LOC backend-side

Why:

- Aligns with existing Fastify stack style.
- Built on `ws@8`.
- Has TypeScript declarations.

Note:

```text
This dependency is for cloud/backend package, not necessarily this Electron app package.
```

### Fallback transport

Keep SSE + HTTPS ACK as an optional enterprise fallback.

🎯 7   🛡️ 7   🧠 6   Approx change size: +1200-2500 LOC after WebSocket protocol exists

Why:

- Some networks/proxies break WebSocket.
- SSE is easier to pass through HTTP infrastructure.

But:

```text
Do not implement fallback until WebSocket protocol semantics are stable.
Otherwise two transports will double the bug surface.
```

## Error Copy Policy

Telegram user-facing responses should be honest and short.

No desktop session:

```text
Agent Teams desktop is offline for this team. Open the app and resend your message.
```

Route disabled:

```text
This team is no longer connected to Telegram. Reconnect it in Agent Teams.
```

Delivery uncertain after retry budget:

```text
Agent Teams could not confirm delivery to desktop. Check the app or resend.
```

Unsupported media in MVP:

```text
This Telegram connection currently supports text only. Send the details as text.
```

Avoid:

```text
"Message delivered" before desktop commit ACK.
"Queued" in default mode.
"We will process this when online" in default mode.
```

## Security Rules

Relay authentication:

```text
desktop signs session start with install secret
backend issues short-lived relay session token
WebSocket uses WSS only
old session token cannot ACK after lease is stolen
ACK includes deliveryId and sessionId
```

Frame validation:

```text
max payload size for text MVP
strict JSON object shape
protocolVersion required
unknown frame types rejected
provider ids stored as strings
raw provider ids redacted in logs
```

Replay controls:

```text
providerUpdateId dedupe on backend metadata ledger
providerUpdateId dedupe on desktop local ledger
deliveryId unique per backend offer
payloadHash conflict detection
duplicate committed ACK path
```

## Edge Cases To Test

Webhook and ACK:

- Telegram webhook with valid secret token and active desktop returns 2xx only after desktop commit ACK.
- Telegram webhook with no active desktop sends offline notice and returns 2xx.
- Active desktop socket exists but heartbeat is stale, backend treats it offline.
- Desktop commits locally but ACK response is lost, retry returns duplicate committed.
- Desktop receives offer after `expiresAt`, rejects retryable or terminal by policy.
- Backend process crashes before returning 2xx, Telegram retries.
- Backend process crashes after returning 2xx but before metadata update, metadata repair handles it.

Ordering and duplicates:

- Same `update_id` delivered twice.
- Two updates for same route arrive concurrently.
- Out-of-order updates due to parallel webhook connections.
- Update id jumps after a long quiet period.
- Payload hash conflict for same update id.

Session lifecycle:

- Second desktop instance steals lease.
- Old session tries to ACK after lease stolen.
- Desktop reconnects with old route inventory hash.
- Binding revoked while socket is open.
- Route disabled while offer is in flight.

Local delivery:

- Desktop commits inbound message, then app crashes before writing team inbox.
- Local delivery ledger retries inbox write on restart.
- Inbox path locked temporarily.
- Team deleted after local commit.
- Lead process offline after local commit.

Privacy:

- Backend durable stores contain no plaintext message bodies in default mode.
- Logs redact raw Telegram ids and message text.
- Offline notice path does not persist message body.
- Metrics count event classes without payload.

Own bot:

- Desktop has no webhook and polls with `getUpdates`.
- Existing webhook on own bot is detected and not deleted silently.
- Desktop catches up updates after restart within Telegram retention window.
- Desktop handles updates older than local route creation as ignored.

## Decision Update

The feature should introduce:

```text
MessengerRelaySessionManager
MessengerRelayProtocol
MessengerBackendUpdateMetadataLedger
MessengerDesktopInboundStore
MessengerLocalDeliveryLedger
```

Recommended default:

```text
official shared bot
WebSocket desktop relay
local-commit ACK before Telegram 2xx
offline notice when no healthy desktop session
bounded Telegram retry only for ambiguous active-session failures
no durable plaintext backend queue
```

Main open uncertainty left after this pass:

```text
Should official shared bot use limited Telegram webhook retries for active-session ACK timeouts,
or always terminal-handle ambiguous timeouts with "delivery uncertain" and 2xx?
```

My current recommendation:

🎯 8   🛡️ 8   🧠 6   Approx change size: +500-1200 LOC

```text
Use limited retry deferral for active-session ACK timeouts only.
Never use retry deferral when there is clearly no healthy desktop session.
```

Reason:

```text
This recovers short reconnects and ACK-loss cases without turning default mode into a hidden queue.
```
