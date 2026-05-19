# Messenger Connectors Uncertainty Pass 91

Date: 2026-05-16
Scope: fresh-code audit for MCP `message_send`, controller message storage and reply proof

## Why This Pass Exists

Pass 90 aligned the architecture with the fresh feature-slice and storage shape. This pass rechecks the most fragile delivery chain:

```text
Telegram topic
-> Agent Team route
-> lead or teammate runtime
-> message_send reply
-> durable local message row
-> connector proof ledger
-> Telegram provider outbox
```

The question is whether fresh code changed the proof boundary enough to simplify the messenger design.

## Fresh Source Checks

Checked fresh `dev` commit `2beb4dae`:

- `mcp-server/src/tools/messageTools.ts`
- `agent-teams-controller/src/internal/messages.js`
- `agent-teams-controller/src/internal/messageStore.js`
- `agent-teams-controller/src/internal/atomicFile.js`
- `agent-teams-controller/test/controller.test.js`
- `src/main/services/team/TeamDataService.ts`
- `src/main/services/team/TeamInboxWriter.ts`
- `src/main/services/team/TeamProvisioningService.ts`
- `src/shared/types/team.ts`

## What Improved

`message_send` is already close to the right semantic action:

```text
message_send:
  teamName
  to
  text
  from
  source
  relayOfMessageId
  leadSessionId
  attachments
  taskRefs
```

Fresh behavior:

- `message_send` tells the agent to stop after a successful app-delivered runtime reply.
- `message_send(to="user")` requires a non-user `from`.
- `relayOfMessageId` is treated as explicit delivery context.
- The controller strips hallucinated `#00000000` task prefixes.
- OpenCode idle/ack-only messages to user or lead are blocked unless there is explicit delivery context.

Controller storage also improved:

- `agent-teams-controller/src/internal/atomicFile.js` provides temp-file write, best-effort file fsync and rename retry.
- `messageStore` uses `writeJsonFileSync` for JSON writes.
- Repeated same-text `runtime_delivery` replies with the same `relayOfMessageId`, `from` and `to` dedupe to the first row.
- Exact `lookupMessage(messageId)` searches `sentMessages.json` and inbox files.
- `lookupMessage` refuses ambiguous duplicate `messageId`.
- `lookupMessage` intentionally does not resolve by `relayOfMessageId`.

These are good changes. They reduce accidental duplicate local rows and make exact message provenance stronger.

## What Still Does Not Change

This is still not enough for Telegram auto-send proof.

Remaining gaps:

- MCP `message_send` schema does not expose explicit `messageId` or `idempotencyKey`.
- The controller can build a message from `flags.messageId`, but the MCP schema does not let the connector provide one.
- `messageStore` message writes still do not use `withFileLockSync`.
- `messageStore` does not read after write to verify the row landed.
- Same `relayOfMessageId` with different text is not a terminal connector conflict. It can produce multiple rows.
- Dedupe applies only to `source === "runtime_delivery"` and comparable same-text replies.
- The MCP tool result is JSON text for the model; it is not a durable commit proof by itself.
- `TeamDataService.sendMessage()` accepts `relayOfMessageId` in `SendMessageRequest`, but still does not pass it into `controller.messages.sendMessage()`.
- Native `SendMessage(to="user")` still does not attach connector-safe `relayOfMessageId`; fresh `TeamProvisioningService` keeps it local-visible, not Telegram-safe.
- `InboxMessage.source` has no connector-specific source such as `external_connector_reply`, so connector proof must avoid relying on source alone until the type is extended.

## Current Proof Rule

MCP `message_send` remains the intended reply action for MVP, but it is not final proof.

Required proof chain:

```text
assistant intended reply via message_send
-> MCP tool result says delivered or later reconciliation finds row
-> destination store readback finds exact row
-> row relayOfMessageId equals external inbound local message id
-> row from/to/source/text hash match expected connector context
-> connector proof ledger commits visible reply proof
-> ExternalReplyProjectionIntent is created
-> ProviderOutboxItem is created
-> Telegram send attempt starts
```

Rejected shortcuts:

```text
tool result success -> Telegram send
relayOfMessageId scan only -> Telegram send
plain assistant text -> Telegram send
native SendMessage(to=user) without connector sidecar -> Telegram send
TeamDataService.sendMessage relayOfMessageId before pass-through fix -> Telegram send
```

## Updated Implementation Implications

Minimum before automatic Telegram replies:

1. Add MCP `message_send` `messageId` or `idempotencyKey` owned by the connector, not invented by the model.
2. Add controller message write locking and read-after-write verification, or make the connector proof ledger responsible for verified readback and conflicts.
3. Treat same `relayOfMessageId` plus different text hash as ambiguous/manual, not last-write-wins.
4. Fix `TeamDataService.sendMessage()` to pass `relayOfMessageId` through if any app-service path becomes eligible for connector proof.
5. Add connector-specific source or proof metadata for externally originated replies.
6. Keep `ExternalReplyProjectionIntent` as the only provider-send eligibility boundary.

## Top 3 Options

1. Connector proof ledger over current `message_send`, plus MCP `messageId`/`idempotencyKey` and verified readback - 🎯 9   🛡️ 9   🧠 7, approx `1800-4200` LOC.
   Best MVP. It respects current code improvements without pretending the controller store is a provider transaction log.

2. Harden controller `messageStore` first, then make it a reusable proof source - 🎯 8   🛡️ 9   🧠 8, approx `2200-5200` LOC.
   Stronger long term, but larger blast radius because controller writes are shared across many team workflows.

3. Use current same-text `runtime_delivery` dedupe and scan by `relayOfMessageId` - 🎯 5   🛡️ 5   🧠 4, approx `700-1600` LOC.
   Too weak for real Telegram auto-send. It fails on changed text, concurrent writes, app-service path loss and ambiguous retries.

## Confidence After This Pass

MCP `message_send` as intended reply action:

🎯 9.2   🛡️ 8.6   🧠 5

Current controller store as final provider proof:

🎯 5.5   🛡️ 5.5   🧠 4

Connector proof ledger after destination readback:

🎯 9.0   🛡️ 9.2   🧠 7

The architecture remains coherent. Fresh code improves the local reply path, but it does not remove the need for a messenger-owned proof ledger and `ExternalReplyProjectionIntent`.
