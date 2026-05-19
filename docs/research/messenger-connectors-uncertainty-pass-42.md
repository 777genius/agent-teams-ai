# Messenger Connectors - Uncertainty Pass 42

Date: 2026-04-30
Scope: replay-user-messages compatibility, stdout `type=user` safety, transcript cursor shape, and local relay metadata leaks

## 1. New Bottom Line

Pass 41 said:

```text
use --replay-user-messages plus transcript marker scan
```

Pass 42 correction:

```text
--replay-user-messages is promising, but not drop-in for this codebase.
```

There are four concrete reasons:

1. Official docs and local help say `--replay-user-messages` works with stream-json input and output, and the help text says stream-json input is print-mode scoped.
2. Current team launch args already use `--input-format stream-json` and `--output-format stream-json`, but do not explicitly pass `--print`.
3. Current stdout handler routes every `msg.type === "user"` through permission request parsing and native teammate-message parsing.
4. `TeamDataService.sendMessage()` accepts `relayOfMessageId` but currently does not pass it into `controller.messages.sendMessage()`, even though lower stores and `agent-teams-controller` support it.

The next implementation must not just add one CLI flag. It needs a small runtime protocol layer.

Recommended minimum:

```text
RuntimeStdoutUserMessageClassifier
RuntimePromptReplayObserver
LeadTranscriptAppendObserver
MessengerActiveTurnCoordinator
TeamDataService relayOfMessageId pass-through test
```

## 2. Verified Facts

Official docs checked:

- Claude Code CLI reference documents `--replay-user-messages` and says it re-emits stdin user messages on stdout. It requires `--input-format stream-json` and `--output-format stream-json`.
- Claude Code help in the local environment also shows `--replay-user-messages`.
- Local CLI checked: `claude --version` returned `2.1.119 (Claude Code)`.
- Local `claude --help` shows `--replay-user-messages`, `--input-format`, and `--output-format`.

Current launch facts:

```text
create team launch args:
  --input-format stream-json
  --output-format stream-json
  --verbose
  no explicit --print

team relaunch args:
  --input-format stream-json
  --output-format stream-json
  --verbose
  optional --resume
  no explicit --print
```

Current stdout facts:

```text
attachStdoutHandler parses newline-delimited JSON.
assistant and result reset stall timer.
type=user enters permission parsing, tool_result finish, native teammate-message parsing.
unhandled stream-json types only log warnings.
```

Current message persistence facts:

```text
agent-teams-controller messageStore persists relayOfMessageId.
TeamInboxWriter persists relayOfMessageId.
TeamDataService SendMessageRequest includes relayOfMessageId.
TeamDataService.sendMessage() does not pass relayOfMessageId to controller.messages.sendMessage().
```

## 3. Replay User Messages Risk

### 3.1 Existing `type=user` branch has a different meaning

Today, stdout `type=user` is not treated as "the app's own prompt was accepted".

It currently does:

```text
extract raw user text
parse permission_request JSON
finish runtime tool_result activity
handle native teammate user message blocks
return
```

After enabling `--replay-user-messages`, the same branch will also receive user turns that the app itself wrote to stdin.

That creates a semantic collision:

```text
runtime-native user message:
  permission request, tool result, teammate heartbeat

app-replayed user prompt:
  outbound user turn ACK
```

These must be separated before any permission or teammate parser runs.

### 3.2 Security implication

If a UI or Telegram-origin prompt is replayed as `type=user`, it may contain user-controlled text.

`parsePermissionRequest()` is strict because it parses JSON and requires `type: "permission_request"`, but adding replay expands the parser's input surface from runtime-native protocol messages to app-originated prompts.

Safe rule:

```text
Only runtime-native teammate permission channels may call parsePermissionRequest.
App-originated prompt replays must be classified and short-circuited first.
```

Recommended classifier order:

```text
if isKnownOutboundPromptReplay(msg):
  RuntimePromptReplayObserver.recordAccepted(...)
  return

if isRuntimeToolResult(msg):
  finish tool activity
  return

if isRuntimeNativePermissionMessage(msg):
  parsePermissionRequest(...)
  return

if isNativeTeammateUserMessage(msg):
  handleNativeTeammateUserMessage(...)
  return
```

Top 3 choices:

1. Add `RuntimeStdoutUserMessageClassifier` before existing `type=user` logic - 🎯 8   🛡️ 9   🧠 5, approx `500-1200` LOC.
   - Recommended.
   - Keeps replay ACK, permission requests, tool results, and teammate heartbeats separated.

2. Add replay handling inside the current `if (msg.type === "user")` branch with local `if` checks - 🎯 6   🛡️ 7   🧠 3, approx `180-450` LOC.
   - Faster.
   - Makes an already overloaded branch harder to reason about.

3. Do nothing and just enable `--replay-user-messages` - 🎯 3   🛡️ 3   🧠 1, approx `20-80` LOC.
   - Unsafe.
   - Can misclassify app prompts as runtime protocol messages.

## 4. CLI Flag Compatibility Risk

The docs and local CLI support the flag, but the exact current launch shape still needs proof.

Why:

- Official help says `--input-format` works with print mode.
- The current team runtime already uses stream-json without explicit `--print`.
- Existing production behavior proves the current runtime accepts that shape today, but not necessarily with `--replay-user-messages`.

Do not discover this by breaking team launch.

Recommended proof:

```text
RuntimeReplayCapabilityProbe
  input:
    claudePath
    cwd
    env
    providerArgs
  checks:
    help text contains --replay-user-messages
    exact launch-shape dry probe exits safely
    probe output contains replayed marker
  result:
    supported
    unsupported_missing_flag
    unsupported_launch_shape
    probe_failed_unknown
```

Exact launch-shape probe should be tiny and isolated. It must not use the real team workspace if it can create sessions or settings side effects.

Top 3 choices:

1. Capability-gate replay with help check plus exact stream-json probe - 🎯 8   🛡️ 9   🧠 6, approx `900-2200` LOC.
   - Recommended before making replay required.
   - Avoids older CLI or launch-shape breakage.

2. Require Claude Code `>=2.1.119` for messenger connector MVP - 🎯 7   🛡️ 8   🧠 3, approx `250-700` LOC.
   - Simpler UX.
   - Version alone is weaker than feature probing if behavior changes.

3. Always add the flag because current docs and local CLI support it - 🎯 6   🛡️ 6   🧠 2, approx `80-220` LOC.
   - Too optimistic for a feature that depends on long-lived local processes.

Recommendation:

```text
Use option 1 during implementation.
If probe is too expensive, use option 2 as MVP product requirement.
```

## 5. Outbound Prompt Ledger

Replay classification needs a local record of prompts the app intentionally wrote to stdin.

Suggested record:

```ts
type RuntimeOutboundPromptRecord = {
  id: string;
  runId: string;
  teamName: string;
  source:
    | "messenger_external_turn"
    | "manual_user_prompt"
    | "lead_inbox_relay"
    | "post_compact_reminder"
    | "gemini_hydration"
    | "user_dm_forward";
  payloadHash: string;
  marker: string | null;
  localTurnId: string | null;
  writeStartedAt: string | null;
  writeAcceptedAt: string | null;
  replayObservedAt: string | null;
  replayMessageId: string | null;
  transcriptPromptIndexedAt: string | null;
  lastReason: string | null;
};
```

This should not be the final messenger ledger. It is an adapter-level support ledger that lets the stdout parser tell:

```text
this stdout user message is a replay of app prompt P1
```

from:

```text
this stdout user message is runtime-native protocol traffic
```

Without this ledger, `--replay-user-messages` is too ambiguous.

## 6. Transcript Cursor Risk

Existing lead-session extraction is UI-oriented:

- it scans backwards from the tail;
- it limits scan bytes;
- it extracts assistant texts and command outputs;
- it ignores user prompt indexing as a first-class proof;
- it caches by whole file signature;
- it is optimized for feed projection, not external-turn proof.

Messenger needs a forward append observer:

```text
capture cursor before stdin write
scan appended bytes after cursor
parse complete JSONL lines only
find external marker in user message
find assistant/tool references after marker
record exact message uuid and offsets
```

Do not reuse `extractLeadSessionTextsFromJsonl()` as proof. It is useful prior art for JSONL parsing and cache invalidation only.

Recommended cursor:

```ts
type LeadTranscriptCursor = {
  transcriptPath: string;
  sessionId: string | null;
  size: number;
  mtimeMs: number;
  ctimeMs: number | null;
  capturedAt: string;
  lastCompleteLineOffset: number;
};
```

Recommended observation result:

```ts
type LeadTranscriptPromptObservation =
  | { kind: "prompt_indexed"; userMessageUuid: string | null; offset: number; observedAt: string }
  | { kind: "not_found"; scannedBytes: number; observedAt: string }
  | { kind: "partial_trailing_line"; scannedBytes: number; observedAt: string }
  | { kind: "transcript_rotated"; previousPath: string; currentPath: string }
  | { kind: "unreadable"; reason: string };
```

Top 3 choices:

1. New `LeadTranscriptAppendObserver` with offset cursor - 🎯 8   🛡️ 9   🧠 6, approx `900-2000` LOC.
   - Recommended.
   - Purpose-built for proof and restart recovery.

2. Extend existing lead-session extractor with marker mode - 🎯 6   🛡️ 7   🧠 5, approx `500-1300` LOC.
   - Less new code.
   - Mixes UI feed extraction with delivery proof.

3. Skip transcript proof when replay is available - 🎯 5   🛡️ 6   🧠 2, approx `150-400` LOC.
   - Loses recovery after stdout parser crash or app restart.

## 7. Active Turn Interleaving Risk

`sendMessageToRun()` is a low-level writer. It has no knowledge of external turn ownership.

Callers include:

- manual `sendMessageToTeam`;
- lead inbox relay;
- user DM forward;
- restart/failure notices;
- post-compact reminders;
- Gemini hydration;
- future messenger external turn injection.

Some callers already guard against lead activity, `leadRelayCapture`, or silent forward. Others can still write directly.

Messenger needs one coordination layer:

```text
MessengerActiveTurnCoordinator
  owns per-route lock
  owns per-run external capture lock
  asks non-messenger internal injections to defer
  records reason when a turn is queued behind another prompt
```

Lock conflict policy:

```text
messenger external turn active:
  defer post-compact reminder
  defer Gemini hydration
  block or queue manual UI prompt for same team
  disable relayLeadInboxMessages for the same lead run

manual UI prompt active:
  queue messenger turn for the route
  do not tell Telegram desktop is offline

leadRelayCapture active:
  queue messenger turn
  do not start runtime injection
```

Top 3 choices:

1. Central `RuntimeTurnCoordinator` around all stdin writes - 🎯 8   🛡️ 9   🧠 8, approx `1800-4200` LOC.
   - Recommended for reliable messenger.
   - Highest code change, but fixes the real interleaving class.

2. Messenger-only lock that checks known transient fields before injecting - 🎯 7   🛡️ 7   🧠 5, approx `700-1600` LOC.
   - Good MVP bridge.
   - Does not protect future non-messenger writers unless they opt in.

3. Rely on `leadActivityState` and current ad hoc guards - 🎯 4   🛡️ 4   🧠 2, approx `100-300` LOC.
   - Too weak.
   - `sendMessageToTeam()` can still interleave.

Recommendation:

```text
Option 2 for first implementation if scope pressure is high.
Option 1 before enabling automatic Telegram replies broadly.
```

## 8. `relayOfMessageId` Pass-Through Gap

This is now a concrete local bug for messenger readiness.

Facts:

```text
SendMessageRequest has relayOfMessageId.
TeamInboxWriter persists relayOfMessageId.
agent-teams-controller persists relayOfMessageId.
agent-teams-controller uses relayOfMessageId as explicit delivery context.
TeamDataService.sendMessage() currently does not pass relayOfMessageId to controller.messages.sendMessage().
```

Impact:

- UI/manual review flows can lose the exact reply link.
- Future connector repair actions could create an app-visible reply that cannot auto-send.
- Tests that only hit `TeamInboxWriter` or `agent-teams-controller` will not catch the `TeamDataService` adapter gap.

Fix:

```text
Add relayOfMessageId: enrichedRequest.relayOfMessageId to TeamDataService.sendMessage().
Add focused TeamDataService test.
```

Rating:

🎯 10   🛡️ 10   🧠 2   Approx 30-90 LOC

This should happen before messenger implementation begins.

## 9. Updated Implementation Order

Before building Telegram adapters:

1. Fix `TeamDataService.sendMessage()` `relayOfMessageId` pass-through.
2. Add native `SendMessage` shape normalization.
3. Add `RuntimeStdoutUserMessageClassifier`.
4. Add outbound prompt ledger for stdin writes.
5. Add `--replay-user-messages` capability probe.
6. Add `LeadTranscriptAppendObserver`.
7. Add messenger active turn coordinator.
8. Add `MessengerRuntimeTurnLedger`.
9. Add reply projection policy requiring exact `relayOfMessageId`.
10. Add provider outbox.
11. Add Telegram gateway and official relay.

This order makes the chain testable before Telegram is involved.

## 10. Updated Lowest-Confidence Map

1. Exact launch-shape behavior of `--replay-user-messages`.
   🎯 6   🛡️ 8   🧠 6
   - Docs and local CLI help support the flag.
   - Need exact team launch shape probe because current code omits explicit `--print`.

2. Stdout `type=user` classification after replay is enabled.
   🎯 7   🛡️ 9   🧠 5
   - Current branch has multiple meanings.
   - Needs classifier and outbound prompt ledger.

3. Active turn interleaving across all stdin writers.
   🎯 7   🛡️ 8   🧠 8
   - Existing guards are local and uneven.
   - Messenger needs a shared coordinator.

4. Transcript cursor exactness.
   🎯 8   🛡️ 9   🧠 6
   - Existing cache/signature code helps.
   - Existing extractor is not a proof observer.

5. `relayOfMessageId` adapter pass-through.
   🎯 10   🛡️ 10   🧠 2
   - Concrete small fix.
   - Should be done early.

## 11. Decision Update

Add these to the living summary:

```text
--replay-user-messages is useful but must be capability-gated and classified.
Current stdout type=user branch cannot directly own replay ACK handling.
App-originated prompt replays must be short-circuited before permission parsing.
Transcript marker proof needs a forward append observer, not the UI feed extractor.
TeamDataService must pass relayOfMessageId through before messenger reply projection relies on it.
Active turn coordination must wrap all stdin writes, not only Telegram writes.
```

## 12. Practical Recommendation

For the first implementation slice, do this:

```text
Fix relayOfMessageId pass-through.
Add outbound prompt records for all sendMessageToRun callers.
Add replay classifier but keep replay disabled by default.
Add exact-shape replay probe.
Add transcript append observer.
Only then enable replay for Claude lead external turns.
```

This gives a safer rollout:

```text
replay disabled:
  transcript observer still provides durable proof

replay enabled and classified:
  faster acceptance proof

replay unsupported:
  connector still works with slower prompt_indexed proof
```

