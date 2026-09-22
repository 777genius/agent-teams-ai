# Messenger Connectors - Uncertainty Pass 29

Date: 2026-04-29
Scope: official shared Telegram bot ingress, webhook ACK semantics, offline desktop behavior, and no durable backend plaintext queue

## Executive Delta

The next weakest boundary is official bot ingress:

```text
Telegram webhook update
official backend
desktop live connection
durable local turn
Telegram webhook ACK
```

The product decision was:

```text
Default official bot, no durable backend plaintext queue.
If desktop is offline, be honest and answer offline.
Encrypted queue can be added later as advanced reliability mode.
```

This creates a precise reliability contract:

```text
Backend must ACK Telegram only after either:
1. desktop durably accepted the plaintext turn locally, or
2. backend recorded a redaction-safe offline/blocked decision and attempted or skipped the offline notice by policy, or
3. this is a duplicate already completed update.
```

Do not use Telegram webhook retry as the queue. It is operationally noisy, finite, and hard to reason about.

## Source Facts Rechecked

Telegram official facts checked on 2026-04-29:

- `setWebhook` sends HTTPS POST updates to our URL.
- Telegram repeats webhook delivery after a non-2xx response and eventually gives up after a reasonable number of attempts.
- `secret_token` can be configured so Telegram includes `X-Telegram-Bot-Api-Secret-Token`.
- `max_connections` can be 1-100 and defaults to 40.
- `drop_pending_updates` can drop pending updates.
- `getWebhookInfo` exposes `pending_update_count` and last error fields.
- `getUpdates` confirms updates by calling with offset greater than the previous `update_id`.
- Telegram stores incoming updates until received, but not longer than 24 hours.
- `getUpdates` cannot be used while webhook is set.
- Bot API calls made directly in the webhook response do not return a result to us.

Sources:

- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#getwebhookinfo
- https://core.telegram.org/bots/api#getting-updates
- https://core.telegram.org/bots/api#making-requests-when-getting-updates
- https://core.telegram.org/bots/faq

Local code facts:

- Existing `HttpServer` binds to localhost by default and serves local app HTTP routes through Fastify.
- Existing browser mode uses SSE from local server to renderer.
- There is no current cloud/backend persistent relay layer for messenger traffic.
- The app already has a usable local event idea, but messenger official mode needs a new outbound desktop-to-cloud control connection, not the existing local HTTP server.

## 1. The ACK Problem

If the backend returns non-2xx to Telegram because desktop is offline, Telegram retries. That sounds like a queue, but it is a bad queue:

- plaintext stays in Telegram's pending delivery mechanism, not under our product semantics;
- retries can repeat the same update while the user keeps typing;
- `pending_update_count` can grow and hide real bugs;
- retries are finite;
- update retention has an upper bound;
- backend may send duplicate offline notices unless it has its own idempotency state.

If the backend returns 2xx before desktop has durably accepted the update, the lead message can be lost forever in official mode because we intentionally do not keep plaintext.

Therefore ACK timing is the core ingress invariant.

## 2. Recommended Backend Ingress State Machine

Backend should persist only redaction-safe metadata before side effects:

```ts
type OfficialIngressReceipt = {
  receiptId: string;
  provider: 'telegram';
  botScope: 'official';
  updateId: number;
  providerMessageKey: string;
  routeId: string | null;
  routeGeneration: number | null;
  textHash: string | null;
  fromUserHash: string | null;
  chatIdHash: string;
  messageThreadId: number | null;
  status:
    | 'received'
    | 'route_missing'
    | 'desktop_claim_started'
    | 'desktop_accepted'
    | 'desktop_acceptance_unknown'
    | 'offline_notice_started'
    | 'offline_notice_sent'
    | 'offline_notice_ambiguous'
    | 'acknowledged'
    | 'failed_terminal';
  createdAt: string;
  updatedAt: string;
};
```

State rules:

```text
received -> desktop_claim_started -> desktop_accepted -> acknowledged
received -> offline_notice_started -> offline_notice_sent -> acknowledged
received -> offline_notice_started -> offline_notice_ambiguous -> acknowledged
received -> route_missing -> acknowledged
duplicate acknowledged -> acknowledged
```

Important: `offline_notice_ambiguous` still ACKs the webhook. It is better to possibly miss the offline notice than to auto-send duplicate notices or keep Telegram retrying.

## 3. Desktop Claim Protocol

Official mode needs a desktop-initiated persistent connection:

```text
desktop -> backend: connect(route subscriptions, install id, session key, capabilities)
backend -> desktop: inbound plaintext turn
desktop -> backend: accepted_local(internalTurnId, providerMessageKey, localMessageId)
backend -> Telegram: 2xx webhook ACK
```

Rules:

- Backend forwards plaintext only to an already-authenticated active desktop connection.
- Desktop must persist the turn locally before returning `accepted_local`.
- Desktop dedupes by `providerMessageKey` and returns the existing local acceptance if the backend retries delivery.
- Backend does not store plaintext after the request handler scope.
- Backend stores only hashes and receipt state.
- If no desktop session can accept within a short timeout, backend goes to offline policy.

Suggested timeout:

```text
2-4 seconds for desktop accepted_local
then offline response or offline status
```

This keeps webhook handlers bounded and avoids Telegram retry storms.

## 4. Crash Matrix

Critical cases:

- Backend crashes before persisting receipt.
  - Telegram retries; safe, because no side effect happened.
- Backend persists receipt, crashes before desktop forward.
  - Telegram retries; backend can process again from `received`.
- Backend forwards plaintext to desktop, crashes before desktop ACK.
  - Telegram retries; desktop dedupe by `providerMessageKey` prevents duplicate local turn.
- Desktop persists local turn, ACK to backend is lost.
  - Telegram retries; backend redelivers, desktop returns existing `accepted_local`.
- Backend records `desktop_accepted`, crashes before HTTP 2xx.
  - Telegram retries; backend sees completed receipt and returns 2xx without redelivering.
- Desktop offline.
  - Backend records offline decision and ACKs Telegram after offline policy.
- Offline notice `sendMessage` succeeds but backend crashes before marking success.
  - On retry, backend must not blindly resend. Mark `offline_notice_ambiguous`, ACK, show support diagnostics.

## 5. Offline Policy

For default official MVP:

```text
No desktop live acceptance = no local delivery.
```

Then choose one of two offline UX policies:

1. Send a short Telegram offline notice.
2. ACK silently and rely on topic status / setup UI.

I recommend a short offline notice, but only through the same provider outbox ambiguity policy from pass 42.

Example behavior:

```text
Agent Teams desktop is offline. Open the app on the connected computer and send the message again.
```

Do not store the lead's plaintext for later replay.

## 6. Why Not Use Telegram As The Queue

Top risks:

- Telegram will retry on non-2xx, but the retry schedule and final give-up behavior are provider-controlled.
- `pending_update_count` becomes an operational failure queue with plaintext updates we cannot inspect safely.
- Once we finally ACK, Telegram considers the update handled, even if desktop state is not coherent.
- If webhook is reconfigured with `drop_pending_updates`, lead messages can be intentionally discarded.
- If the app is offline for more than Telegram retention, messages are lost anyway.

This conflicts with the product's "honest offline" behavior.

## 7. Official Mode Privacy Story

The honest statement:

```text
Official shared bot backend sees message plaintext transiently while handling Telegram delivery.
It does not durably store plaintext in MVP.
It stores redaction-safe delivery metadata and hashes for dedupe, abuse prevention, and diagnostics.
```

Not honest:

```text
Our backend never sees messages.
```

That statement is only true for private own-bot local polling mode, not official shared bot mode.

## 8. Own Bot Contrast

Own bot mode is much simpler for ingress:

```text
desktop getUpdates
desktop durable local turn
desktop confirms offset
```

Because Telegram `getUpdates` confirms by offset, desktop can persist locally before advancing offset. That is a better privacy and reliability story for users who want it.

But own bot mode is less convenient because the user must create/configure a bot.

## 9. Desktop To Backend Transport Options

1. Persistent WebSocket from desktop to backend - 🎯 8   🛡️ 8   🧠 7 - approx `1600-3600` changed LOC.
   Best default for official mode. Full duplex, explicit ACK messages, connection leases, heartbeats, route subscriptions.

2. Server-Sent Events from backend to desktop plus HTTPS POST ACKs - 🎯 7   🛡️ 7   🧠 6 - approx `1300-3000` changed LOC.
   Simpler in some networks, but ACK correlation and reconnect handling are more awkward.

3. Desktop polling backend every N seconds - 🎯 5   🛡️ 5   🧠 4 - approx `700-1800` changed LOC.
   Poor fit for no plaintext queue because backend would need to hold plaintext or lead messages would be missed between polls.

Recommendation:

```text
Use WebSocket-like persistent desktop claim channel for official mode.
Do not add a package decision until package versions can be verified in an unrestricted network environment.
```

## 10. Multi-Desktop And Lease Policy

If the same user connects the same official route from multiple desktops:

```text
Only one active receiver lease may own inbound plaintext delivery.
```

Options:

1. Single primary device per route - 🎯 8   🛡️ 8   🧠 5 - approx `600-1400` changed LOC.
   Recommended for MVP. Simple and prevents split-brain delivery.

2. Fan out to all active desktops and accept first durable ACK - 🎯 6   🛡️ 6   🧠 7 - approx `1200-2600` changed LOC.
   Can duplicate local inboxes and confuse reply ownership.

3. Per-team device assignment - 🎯 7   🛡️ 8   🧠 7 - approx `1400-3200` changed LOC.
   Useful later for power users, too much for MVP.

## 11. Security Requirements

Minimum official ingress controls:

- Verify `X-Telegram-Bot-Api-Secret-Token`.
- Use a secret webhook path as defense in depth.
- Reject updates that do not match expected bot id/account binding.
- Use `allowed_updates` to narrow update surface.
- Persist update id/provider message key dedupe.
- Rate-limit offline notices by chat/topic.
- HMAC/hash user ids and chat ids in backend logs.
- Do not log plaintext update payloads.
- Encrypt desktop-backend transport.
- Rotate desktop session tokens.

## 12. Test Matrix

Tests should simulate:

- valid webhook with active desktop accepted;
- duplicate webhook update after accepted;
- backend crash before receipt write;
- backend crash after receipt write;
- backend crash after desktop forward;
- desktop accepted locally but ACK lost;
- backend accepted desktop ACK but HTTP 2xx lost;
- desktop offline;
- offline notice success;
- offline notice timeout after request start;
- webhook secret mismatch;
- route missing;
- route disabled;
- topic deleted;
- bot permission lost;
- two desktop sessions racing;
- webhook max_connections concurrent deliveries out of order;
- `drop_pending_updates` during reconnect;
- old update after allowed_updates change;
- backend store unavailable;
- desktop reconnect while webhook is in-flight.

Pass criterion:

```text
No plaintext is durably stored by official backend.
No Telegram update is ACKed as handled before either desktop durable acceptance or an explicit offline/blocked decision.
No duplicate local turns for the same providerMessageKey.
No duplicate offline notice unless user/support explicitly chooses duplicate send.
```

## 13. Top 3 Overall Options

1. Synchronous desktop claim + redaction-safe ingress receipt + offline notice outbox - 🎯 8   🛡️ 8   🧠 8 - approx `2500-6000` changed LOC.
   Recommended official MVP. It matches "no durable backend plaintext queue" and gives deterministic failure states.

2. Encrypted backend queue for later desktop replay - 🎯 7   🛡️ 9   🧠 9 - approx `3500-8000` changed LOC.
   Better reliability, but bigger system. Backend still sees plaintext transiently from Telegram before encrypting.

3. Non-2xx webhook until desktop online, using Telegram retries as queue - 🎯 4   🛡️ 4   🧠 4 - approx `800-2000` changed LOC.
   Not recommended. It is brittle, provider-controlled, and creates operational backlog.

## 14. Decision Update

Official shared bot MVP should implement:

```text
Telegram webhook
-> backend redaction-safe receipt
-> if desktop active: synchronous durable desktop claim
-> if accepted: ACK Telegram
-> if not accepted: offline notice policy, then ACK Telegram
```

Own bot mode remains:

```text
desktop long polling
-> local durable turn
-> advance update offset
```

This keeps the default UX simple while making the privacy/reliability tradeoff explicit instead of accidental.
