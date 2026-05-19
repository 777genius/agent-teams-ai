# Messenger Connectors Uncertainty Pass 89

Date: 2026-05-01
Scope: cross-document coherence for route-container defaulting, Telegram SDK boundaries and inaccessible reply routing

## What Was Still Weak

After pass 88, the remaining risk was not the main architecture. It was wording that could still send implementation in subtly different directions:

1. Route container default.
   Some older sections said "private topics as default" while the current policy says topics are preferred only after capability checks, live client fixture and per-route activation proof. Selector mode is not a different product direction. It is the mandatory fallback/default when proof is missing.

2. Telegram SDK ownership.
   Older sections recommended grammY core/runtime as the best TypeScript Telegram library. That is not wrong as a library evaluation, but it conflicts with the MVP reliability boundary if grammY owns polling offsets, ACK timing or non-idempotent send retries.

3. Inaccessible replies.
   One older routing section said a message with missing/inaccessible `reply_to_message` should route to lead. That was weaker than the current rule. If the user intended an explicit reply but link proof is missing, the safe state is ambiguous/repair, not lead fallback.

## Current Route Container Rule

Preferred product shape:

```text
official shared bot
one team route per Agent Team
Telegram private-chat topic per team when proof passes
```

Activation requirements:

```text
provider capability proof
mutation policy proof
live client compatibility fixture
per-team RouteActivationProof
stored ProviderRouteAddress plus RouteGeneration
```

Fallback rule:

```text
if any proof is missing or stale:
  use private DM selector mode
  do not silently activate topic routing
  do not route unknown topic ids to lead
```

This keeps the product goal and implementation safety aligned.

## Current Telegram SDK Rule

MVP default:

```text
raw fetch Bot API adapter
@grammyjs/types for Telegram typing
feature-owned update normalizer
feature-owned offset commit
feature-owned provider outbox retry classifier
```

Not allowed to own MVP critical boundaries:

```text
grammY runner offset advancement
default autoRetry around sendMessage
framework-level webhook retry semantics
framework-owned outbox worker
```

Allowed later:

```text
small grammY helper usage if it does not own ACK, offset or outbox retry semantics
grammY runner only after a proof spike shows offset commit can remain durable-first
auto-retry only for non-trackable setup calls or explicitly non-ambiguous retry phases
```

## Current Inaccessible Reply Rule

Safe routing:

```text
normal un-replied message in active team route -> lead
reply_to_message resolves through ExternalMessageLink -> linked lead or teammate
reply_to_message exists but is missing/inaccessible/unlinked -> ambiguous or repair
external_reply -> never teammate in MVP; use current route only when explicit stored link proves it
unknown topic/thread -> setup, repair or selector; never lead fallback
```

Why:

- `reply_to_message` is a user intent signal;
- missing proof can mean deleted/inaccessible old message;
- lead fallback can send a private teammate reply to the lead by mistake;
- repair is annoying but recoverable, while misrouting is not.

## Coherence Fix Applied

Updated the living architecture and summary so:

- private topics are described as preferred only after proof;
- selector mode is the mandatory fallback/default when proof is missing;
- raw `fetch` plus `@grammyjs/types` is the MVP Telegram adapter default;
- grammY runtime/helper usage is explicitly outside critical reliability boundaries;
- inaccessible explicit replies become ambiguous/repair, not lead fallback.

## Remaining Confidence

Route-container wording:

🎯 9.8   🛡️ 9.7   🧠 5

Telegram SDK boundary:

🎯 9.7   🛡️ 9.5   🧠 5

Reply-target routing:

🎯 9.9   🛡️ 9.8   🧠 4

Main remaining uncertainty is still implementation proof: real Telegram private-topic fixture behavior, route activation repair UX, and failure injection around own-bot polling offset commits.
