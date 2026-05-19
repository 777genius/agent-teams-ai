# Messenger Connectors - Uncertainty Pass 53

Date: 2026-05-01
Scope: data movement, plaintext boundaries, stability guarantees, and the weakest remaining delivery promises

## Question

Can we say exactly what data moves between Telegram, backend, desktop, lead, teammates and UI? Can the system be stable?

Short answer:

```text
Yes, the data path is clear.
No, we should not promise perfect exactly-once delivery.
We can promise durable local state, idempotent inbound processing, proof-based outbound projection, explicit unknown states, and no silent guessing.
```

## Fresh Source Check

Official Telegram facts that drive the reliability contract:

- `getUpdates` and webhooks are mutually exclusive for one bot token.
- Telegram stores incoming bot updates until delivery, but not longer than 24 hours.
- `update_id` is useful for ignoring repeated updates and restoring order after out-of-order webhook delivery.
- `getUpdates` confirms an update only when the next offset is higher than the update id.
- Webhooks retry when the response status is not 2xx.
- `setWebhook.max_connections` can create concurrent webhook delivery.
- `secret_token` adds `X-Telegram-Bot-Api-Secret-Token`.
- `sendMessage` returns a sent `Message` on normal API success.
- Calling Bot API methods in the webhook response gives no result, so it cannot persist provider `message_id`.

Local web security facts checked:

- `HttpOnly` cookies are not readable by JavaScript, but still ride with browser requests.
- `SameSite=Strict` restricts cookies to same-site requests.
- CORS is not enough as the only localhost protection for mutating routes.

Sources:

- https://core.telegram.org/bots/api#getting-updates
- https://core.telegram.org/bots/api#getupdates
- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#sendmessage
- https://core.telegram.org/bots/api#making-requests-when-getting-updates
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie
- https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html

## Data Paths

### Official Shared Bot - Inbound

```text
Telegram user message
-> Telegram Bot API webhook request
-> Agent Teams cloud relay process memory
-> metadata-only claim ledger
-> desktop main-process relay stream
-> desktop MessengerStateStore local plaintext row
-> route decision
-> LeadTurnGate
-> lead stdin or teammate inbox
-> local visible history
```

Backend sees plaintext transiently in request memory and relay write buffers.

Backend must not persist:

- raw Telegram update JSON
- message text
- captions
- file names
- bot token
- authorization headers
- desktop refresh token plaintext

Backend may persist:

- providerUpdateKey
- accountBindingId
- route id
- claim id
- attempt id
- state
- timestamps
- HMAC payload digest
- payload size bucket
- terminal reason code
- provider status message ids

### Official Shared Bot - Outbound

```text
lead/teammate visible reply
-> local message write
-> local read-back verification
-> ExternalReplyProjectionIntent
-> desktop-owned plaintext outbox
-> backend send proxy request with plaintext in memory
-> Telegram sendMessage
-> backend metadata result cache
-> desktop stores provider message_id
```

Backend sees outbound plaintext transiently while sending to Telegram.

Backend must not durably queue outbound plaintext.

If the Telegram send request started and the result is lost:

```text
provider_send_unknown
```

No blind retry.

### Own Bot Mode

```text
desktop stores own-bot token locally
desktop getUpdates long-polls Telegram
desktop sends Telegram messages directly
our backend is not involved
```

Own bot mode improves privacy because our backend does not see token or message plaintext.

It does not solve Telegram outbound idempotency. `sendMessage` still has no app-supplied idempotency key.

### Renderer And Browser UI

Renderer/browser UI can see user-visible conversation text because it is the product UI.

Renderer/browser UI must not receive:

- bot tokens
- relay refresh credentials
- raw provider update bodies
- backend auth secrets
- official relay plaintext claims before local persistence

The UI should receive normalized view DTOs after local state is committed.

## Stability Guarantees

Inbound official shared bot:

```text
Guarantee: at-least-once provider delivery + idempotent local processing.
ACK target: desktop durable local prepare or terminal non-delivery status.
No runtime starts before backend accepts local_prepared ACK.
```

Outbound official shared bot:

```text
Guarantee: durable local outbox + at-most-one automatic send attempt after request_started.
If result is unknown, mark send_unknown/provider_send_unknown and require repair or explicit user decision.
```

Reply projection:

```text
Guarantee: no Telegram auto-send without exact proof.
Proof source: ExternalReplyProjectionIntent.
Plain assistant text: local-only or manual review.
```

Local browser API:

```text
Guarantee: protected mutating routes require local session + Host/Origin + CSRF.
No unauthenticated localhost mutation.
```

## Top 3 Stability Contract Options

1. Honest durable contract with explicit unknown states.
   🎯 9   🛡️ 9   🧠 7   Approx 2200-4600 LOC on top of current plan.
   Recommended. Inbound is idempotent, outbound is durable but can become `send_unknown`, and UI shows truthful repair states.

2. Try to hide unknown states with automatic retries.
   🎯 4   🛡️ 4   🧠 5   Approx 900-2200 LOC.
   Rejected for provider sends. Telegram may have accepted the message before the response was lost, so blind retry can duplicate.

3. Backend durable plaintext queue for simpler reliability.
   🎯 7   🛡️ 6   🧠 6   Approx 1800-3600 LOC.
   Not MVP. It improves retry ability but violates the no-plaintext-backend-queue product decision.

## Lowest Confidence Areas After This Pass

1. Outbound `send_unknown` UX.
   🎯 7   🛡️ 8   🧠 6
   The technical state is clear, but user copy and repair actions need design.

2. Real Telegram webhook retry timing.
   🎯 6   🛡️ 8   🧠 5
   Telegram documents retries but not exact timing. Need staging measurements.

3. Native `SendMessage` fixture.
   🎯 8   🛡️ 9   🧠 3
   Local code mismatch is known; exact stream-json shape still needs capture.

4. Shared `LeadTurnGate` migration.
   🎯 8   🛡️ 9   🧠 8
   Architecturally required, but high touch area in current team runtime code.

5. Backend no-plaintext enforcement.
   🎯 8   🛡️ 9   🧠 6
   Needs branded plaintext types, metadata schemas that reject plaintext fields, redaction tests and log canaries.

6. Local HTTP auth rollout.
   🎯 8   🛡️ 8   🧠 5
   Straightforward, but must be added before mutating messenger HTTP routes become normal.

7. Multi-device future.
   🎯 6   🛡️ 8   🧠 8
   Current desktop lease model can scale, but hosted web control needs account auth, device pairing, lease ownership and audit.

## Tests Needed

Inbound:

- Duplicate webhook update with same providerUpdateKey dedupes.
- Same providerUpdateKey with different payload hash becomes conflict.
- ACK before desktop local prepare is impossible.
- Runtime starts only after backend accepts `local_prepared`.
- ACK missing after plaintext dispatch cannot produce `desktop_offline`.
- Retry after duplicate local prepare returns `duplicate_local`.
- Retry budget expiry sends `delivery_unconfirmed`.

Outbound:

- Provider outbox cannot be created without `ExternalReplyProjectionIntent`.
- `request_started` plus lost response becomes `provider_send_unknown`.
- `provider_send_unknown` does not auto-retry.
- Same outbox id and payload hash dedupes.
- Same outbox id with different payload hash becomes conflict.
- Backend send result cache stores metadata, not plaintext.
- Backend result cache persist failure after Telegram success becomes `send_unknown`.

Privacy:

- Backend metadata schemas reject `text`, `caption`, `fileName`, `rawUpdate`, `token`, `authorization`.
- Logs reject plaintext canary values.
- Support bundle export excludes provider plaintext and tokens.
- Own-bot mode never calls official relay endpoints.

Local HTTP:

- Missing session rejects protected messenger POST.
- Bad Origin rejects protected messenger POST.
- Bad Host rejects protected messenger POST.
- Missing CSRF rejects cookie-auth mutation.
- One-time browser auth code burns after first use.

## Updated Recommendation

Use these product promises:

```text
Official bot:
  easiest setup
  our backend sees message plaintext transiently
  no durable backend plaintext queue
  honest offline/unconfirmed states

Own bot:
  most private
  token and messages stay local to desktop and Telegram
  desktop must be running for message sync

Delivery:
  inbound is durable after local ACK
  outbound is durable locally, but Telegram send can become unknown
  no silent duplicate-prone retry
```

This is stable enough for a real MVP because every non-deterministic edge becomes an explicit state, not a hidden best guess.
