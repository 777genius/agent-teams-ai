# Member Work Sync OpenCode Turn-Settled Plan

- **Status:** implemented and live-verified in `feat/member-work-sync-opencode-turn-settled`
- **Scope:** `member-work-sync`, OpenCode runtime turn-settled signal, OpenCode SSE observer
- **Primary repo:** `claude_team`
- **Secondary repo:** `agent_teams_orchestrator`
- **Feature name:** `member-work-sync`
- **Recommended cut:** provider-neutral runtime turn-settled pipeline with OpenCode SSE adapter

Implemented verification:

- `claude_team`: `pnpm exec vitest run test/features/member-work-sync/main/OpenCodeTurnSettledPayloadNormalizer.test.ts test/features/member-work-sync/main/CodexNativeTurnSettledPayloadNormalizer.test.ts test/features/member-work-sync/main/TeamRuntimeTurnSettledTargetResolver.test.ts test/features/member-work-sync/main/FileRuntimeTurnSettledEventStore.test.ts test/features/member-work-sync/main/createMemberWorkSyncFeature.test.ts`
- `claude_team`: `pnpm typecheck --pretty false`
- `agent_teams_orchestrator`: `bun test src/services/opencode/OpenCodeSseEventStream.test.ts src/services/opencode/OpenCodePreviewObserver.test.ts src/services/opencode/OpenCodeTurnSettledObserver.test.ts src/services/opencode/OpenCodeRuntimeTurnSettledEmitter.test.ts src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.test.ts src/services/opencode/OpenCodeSessionBridge.test.ts src/services/opencode/OpenCodeBridgeCommandHandler.test.ts`
- `agent_teams_orchestrator`: `bun run build`
- `agent_teams_orchestrator`: `OPENCODE_E2E=1 OPENCODE_TURN_SETTLED_LIVE=1 bun test src/services/opencode/OpenCodeTurnSettledObserver.live-e2e.test.ts`
- both repos: `git diff --check`

---

## 1. Summary

Add OpenCode support to the existing `member-work-sync` runtime turn-settled pipeline.

The goal is not to make OpenCode "answer better" directly. The goal is to make the app know when an OpenCode teammate turn has settled, so the existing `MemberWorkSyncReconciler` can re-check authoritative work state:

```text
OpenCode prompt_async accepted
-> app-owned SSE observer watches same session
-> observer returns bounded turn evidence: idle / error / timeout / stream unavailable
-> bridge command also uses existing reconcile/preview evidence
-> OpenCode turn-settled coordinator chooses one final outcome
-> orchestrator writes one durable runtime_turn_settled event to spool
-> claude_team drains event
-> OpenCode normalizer validates payload
-> resolver validates active team/member/provider
-> existing MemberWorkSyncEventQueue enqueues reconcile
-> existing policy decides no-op / status update / future nudge outbox
```

Recommended implementation:

**OpenCode SSE turn-settled observer + bounded bridge-command settlement + error-aware spool event**

`🎯 9   🛡️ 9   🧠 6`, roughly `850-1250 LOC`.

Why this is the right cut:

- OpenCode already exposes reliable-enough SSE lifecycle events on `/event`.
- The current app already has a durable runtime turn-settled spool for Claude and Codex.
- OpenCode does not need user/project plugin config mutation.
- `session.idle` is a wake-up signal, not proof of success. The existing member-work-sync agenda remains authoritative.
- This integrates with watchdog by queueing the same reconcile signal, not by adding a second watchdog.
- The OpenCode bridge command is short-lived, so the observer cannot be a fire-and-forget background task. It must be awaited with a small bounded settlement budget inside the bridge command, then return `timeout` evidence if the turn is still not terminal.
- The observer must collect evidence only. A small emission coordinator writes exactly one spool event after the path has also used existing reconcile/preview evidence. This avoids premature `timeout` events when post-prompt reconcile proves activity.

---

## 2. Evidence From Live Prototype

Prototype environment:

- installed OpenCode version: `1.14.19`
- local server: `opencode serve --hostname 127.0.0.1 --port <temp>`
- API used:
  - `POST /session`
  - `GET /event`
  - `POST /session/:id/prompt_async`
  - `GET /session/:id/message`

Observed with `opencode/gpt-5-nano`:

```text
prompt_async accepted: true
session activity observed after prompt: true
idle observed: true
assistant text: OK
```

Observed event shape:

```text
server.connected
message.updated user
message.part.updated user text
session.status busy
message.updated assistant
message.part.updated step-start/reasoning/text
message.part.delta text
message.part.updated step-finish
session.status idle
session.idle
```

Observed with `openai/gpt-5.1-codex-mini`:

```text
prompt_async accepted: true
session.error observed: true
session.status idle observed after error: true
session.idle observed after error: true
```

Important conclusions:

- The observer must subscribe before `prompt_async`, otherwise fast turns can be missed.
- OpenCode `messageID` must start with `msg`; UUID-only IDs get `400`.
- `session.idle` means "turn ended", not "turn succeeded".
- `session.error` must produce an error outcome, but should still wake member-work-sync to reconcile.
- Both `session.status idle` and `session.idle` can arrive for the same turn, so emission must be idempotent.
- The orchestrator bridge command exits after the command returns. A background observer can be killed before it writes the spool event. This invalidates a pure "start observer and return" design.

### 2.1 External Research Notes

Official OpenCode docs confirm the API surface this plan relies on:

- OpenCode server docs document `opencode serve` and `GET /event` as a server-sent events stream: https://dev.opencode.ai/docs/server/
- OpenCode SDK docs document `event.subscribe()` and `session.prompt(...)`: https://opencode.ai/docs/sdk/
- OpenCode plugin docs list `session.idle`, `session.status`, `session.error`, `message.updated`, and `message.part.updated` event types: https://open-code.ai/en/docs/plugins
- The generated OpenCode SDK types define `EventSessionIdle`, `EventSessionStatus`, `EventSessionError`, `EventMessageUpdated`, `EventMessagePartUpdated`, and `GlobalEvent { directory, payload }`: https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts
- The generated OpenCode SDK types define `/session/{id}/prompt_async` with optional `body.messageID?: string` and `204 Prompt accepted`: https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts
- Current OpenCode prompt implementation uses `input.messageID ?? MessageID.ascending()` when creating the user message, so a custom `messageID` is a real OpenCode message identity, not opaque metadata: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts
- Current OpenCode `prompt_async` handler schedules `SessionPrompt.prompt(...)` in an async runtime and returns `204` immediately; later failures are logged and published as `session.error`: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts
- Current OpenCode `/event` handler sends `server.connected`, heartbeat events every 10 seconds, and no SSE `id` field for replay: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/event.ts
- Current OpenCode session status source defines `session.status` with object status and marks `session.idle` as deprecated, while still publishing idle for compatibility: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/status.ts
- Current OpenCode ID schema requires message IDs to start with `msg`: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/id/id.ts
- Current OpenCode message event schemas carry `message.updated.properties.info.role` and `message.part.updated.properties.part.messageID/sessionID`, so the observer can distinguish prompt persistence from assistant/runtime activity: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/message-v2.ts

Design impact:

- The observer should parse both plain events and global events wrapped under `payload`.
- For `/global/event`, the observer should ignore events whose `directory` is known and does not match the session record `projectPath`.
- The terminal state must be session-scoped and post-prompt, not host-scoped.
- Error and idle can both be emitted for the same turn, so error wins over later idle.
- `prompt_async` `204` means "scheduled/accepted by endpoint", not "assistant turn succeeded"; `session.error` after `204` must still be captured.
- `prompt_async` returns before the assistant is done, so the bridge command must wait a bounded amount for `session.status idle` / `session.idle` if it wants a reliable turn-settled file.
- `session.status idle` is the primary terminal event; deprecated `session.idle` is a compatibility fallback.
- A custom `messageID` must be generated per OpenCode prompt attempt and should not be reused as the app-level delivery retry key.
- Heartbeat and `server.connected` events are stream health, not session activity.
- `message.updated user` and user text part events prove only that the prompt was persisted. They are not assistant-turn activity and must not make observer outcome `success`.
- Assistant-turn activity should be limited to `session.status busy`, assistant `message.updated`, assistant-owned `message.part.updated` / `message.part.delta`, or tool/step/reasoning parts associated with assistant messages.
- Because `/event` has no replay IDs, missing a fast event must be handled by reconcile/preview proof rather than by reconnect replay.

Additional source-audit notes from current docs:

- OpenCode server docs say `/event` starts with `server.connected`, then bus events. Do not treat `server.connected` as session activity.
- OpenCode server docs expose `/global/event` separately. It is useful as fallback, but only with directory filtering.
- OpenCode SDK docs expose `event.subscribe()` as the official stream abstraction. Our fetch-based reader should stay compatible with the same event shapes, not invent a separate schema.
- OpenCode SDK generated types show `EventSessionStatus.properties.status` as a structured status object in current versions. Runtime captures can still be strings, so support both.
- OpenCode SDK generated types show `GlobalEvent.directory`. That confirms the need to pass `projectPath` into both new turn-settled observer and existing preview observer.

### 2.2 Deep Review Corrections

The original version of this plan had two unsafe assumptions. They are fixed below.

1. **No unbounded background observer in orchestrator CLI.** `OpenCodeBridgeCommandClient` launches `agent_teams_orchestrator runtime opencode-command ...` as a short-lived process. If `runSendMessage()` returns immediately after `prompt_async`, a background SSE observer may be terminated with the process. The implementation must await observer settlement with a bounded timeout, keep the evidence, and only then continue to final emission.
2. **Do not mutate global `promptAsync()` semantics.** Existing OpenCode prompt callers should keep old behavior. Add an opt-in method such as `promptAsyncWithTurnSettled()` or a small wrapper service around `promptAsync()` so only launch/delivery paths that explicitly request turn-settled telemetry get message IDs and bounded observation.
3. **Do not add a second SSE stream for launch unless live evidence requires it.** `runLaunch()` already calls `observePreview()` per prompted member in the concurrent settle phase. For launch v1, derive final turn-settled outcome from existing preview + reconcile summaries instead of starting a second observer. The new observe-around-prompt path is most valuable for delivery prompts.
4. **Normalize `session.status` as object or string.** Current OpenCode SDK types model status as `{ type: "idle" | "busy" | "retry" }`, while older/live shapes can appear as strings. Shared status parsing must accept both, and `OpenCodePreviewObserver` should be updated as part of helper extraction.
5. **Do not let observation outlive the retained host scope accidentally.** `OpenCodeSessionBridge.withSessionHost()` calls `releaseHost()` in `finally`. Observed prompt APIs must either keep observe/prompt/settle inside the retained scope or explicitly hold an observation lease until `waitForSettled()`/`dispose()` completes.
6. **Emit after final local evidence, not directly from observer.** `runSendMessage()` already reconciles after prompt. If the SSE observer times out but reconcile sees new messages/tool calls, the final event should be `success`, not an already-written `timeout`. The observer returns evidence; the coordinator emits once.

---

## 3. Goals

- Emit OpenCode `runtime_turn_settled` events into the existing durable spool exactly once per observed prompt path.
- Keep OpenCode support provider-specific at the adapter boundary and provider-neutral in `member-work-sync` core.
- Make the observer fail-soft: delivery success still depends on `prompt_async`, but the bridge command waits only a bounded telemetry budget and returns `timeout` evidence rather than hanging.
- Preserve existing OpenCode delivery, watchdog, ledger, MCP readiness, and task-stall semantics.
- Avoid modifying OpenCode user config, project plugins, or profile settings.
- Avoid frontend changes in v1.
- Make live validation possible with cheap models and without long-running model matrix tests.

---

## 4. Non-Goals

This plan does not:

- add OpenCode plugin installation;
- add a new MCP tool;
- synthesize replies;
- auto-complete tasks;
- change `TeamTaskStallMonitor` behavior;
- mark messages read;
- change OpenCode prompt text except optional deterministic message IDs;
- rely on model text like "done" as proof;
- expose new UI controls.

---

## 5. Architecture Principles

### 5.1 Clean Architecture

Follow `docs/FEATURE_ARCHITECTURE_STANDARD.md`.

In `claude_team`:

```text
src/features/member-work-sync/
  core/domain/
  core/application/
  main/adapters/output/
  main/infrastructure/
  main/composition/
```

In `agent_teams_orchestrator`:

```text
src/services/opencode/
  OpenCodeTurnSettledObserver.ts
  OpenCodeRuntimeTurnSettledEmitter.ts
```

The boundary is explicit:

- orchestrator knows OpenCode SSE and session protocol;
- orchestrator writes raw provider event files;
- `claude_team` owns agenda, fingerprint, leases, queue, nudge policy, and watchdog separation.

### 5.2 SOLID

- **SRP:** observer watches OpenCode events; coordinator derives final outcome; emitter writes spool files; normalizer validates payload; resolver validates team/member.
- **OCP:** adding OpenCode means adding a normalizer/resolver branch and provider env support, not rewriting `RuntimeTurnSettledIngestor`.
- **LSP:** tests can substitute fake observer, fake emitter, fake resolver.
- **ISP:** ports stay small: `OpenCodeTurnSettledEmitterPort`, `RuntimeTurnSettledPayloadNormalizerPort`, `RuntimeTurnSettledTargetResolverPort`.
- **DIP:** application layer depends on ports, not `fetch`, filesystem, OpenCode client, or Electron.

### 5.3 Watchdog Separation

OpenCode turn-settled is a fast wake-up signal:

```text
"a runtime turn ended, recompute current agenda"
```

Task stall watchdog remains semantic and delayed:

```text
"a task has not had meaningful progress for too long"
```

Rules:

- turn-settled does not directly nudge;
- turn-settled does not count as meaningful task progress;
- watchdog cooldowns still prevent duplicate nudges;
- `member-work-sync` dispatcher remains the only path that can deliver sync nudges, and it must pass its internal guards first.

---

## 6. Recommended Design

### 6.1 Provider Signal Source

Use OpenCode SSE, not plugin hooks.

```text
GET <baseUrl>/event
```

Fallback:

```text
GET <baseUrl>/global/event
```

Reasons:

- no project config mutation;
- no user OpenCode plugin pollution;
- app already has the session record and host URL;
- observer can be started before `prompt_async`;
- compatible with existing `OpenCodePreviewObserver` experience.

### 6.2 Turn Boundary

A turn-settled observer starts immediately before the prompt is submitted and is awaited with a bounded settlement budget inside the same bridge command:

```text
observeTurnSettled(record, context)
-> waitUntilReady(max 500ms)
-> markPromptSubmitting()
-> prompt_async(record, prompt)
-> markPromptAcceptedByEndpoint()
-> waitForSettled(max 8-12s for delivery)
-> existing post-send reconcile / response observation where already present
-> coordinator derives final outcome from observer evidence + reconcile evidence + response proof
-> coordinator emits one success/error/timeout/stream_unavailable event
-> return bridge command result
```

Why this is required:

- the orchestrator OpenCode command is not a long-lived daemon;
- a fire-and-forget observer can be killed when the command exits;
- a bounded wait gives a durable signal without making delivery depend on perfect SSE behavior.
- the observer must enter `submitting` before the HTTP call, not after the accepted response, because fast OpenCode turns can emit message/activity/idle events while `prompt_async` is still in flight.
- `prompt_async` `204` only means the endpoint scheduled the turn. It does not prove the prompt finished or even that model/tool execution succeeded. Later `session.error` still wins unless reconcile/response proof upgrades the outcome.

No-reply guard:

- If `noReply === true`, do not emit a runtime turn-settled event. There is no assistant turn to settle.
- The command can still reconcile for delivery bookkeeping, but `member-work-sync` should not treat a no-reply prompt as an agent idle signal.
- Add a test that `noReply` delivery preserves existing behavior and does not enqueue OpenCode work sync.

Important default:

```ts
const OPENCODE_SEND_TURN_SETTLED_TIMEOUT_MS = 12_000;
const OPENCODE_SEND_TURN_SETTLED_IDLE_TIMEOUT_MS = 2_500;
```

These are telemetry budgets. If they expire, delivery can still be accepted and the observer outcome is `timeout`. The emitted outcome can still become `success` if later reconcile/response evidence proves assistant-turn activity.

Do not let the observer write the spool file directly. It should return evidence:

```ts
type OpenCodeTurnSettledEvidence = {
  readiness: 'connected' | 'fallback' | 'timeout';
  promptLifecycle: 'accepted_by_endpoint' | 'rejected_by_endpoint' | 'unknown';
  outcome: OpenCodeTurnSettledOutcome;
  sawAssistantTurnActivity: boolean;
  sawError: boolean;
  diagnostics: string[];
};
```

Then the command path derives the final event:

```text
response observation proves visible/tool reply -> success with diagnostic response_observation_proved_activity
reconcile cursor advanced -> success with diagnostic reconcile_advanced_after_prompt
observer error -> error unless reconcile/response proof shows a later successful turn
observer success -> success
observer idle_without_assistant_activity -> idle_without_assistant_activity unless reconcile/response proof upgrades it
observer timeout + reconcile failed/no activity -> timeout
stream unavailable + reconcile failed/no activity -> stream_unavailable
```

This avoids writing a premature `timeout` immediately before existing reconcile proves that the turn actually completed.

Prompt submission race rule:

```text
before HTTP prompt_async request -> markPromptSubmitting()
HTTP 204 returned -> markPromptAcceptedByEndpoint()
HTTP rejected/throws -> markPromptRejectedByEndpoint(), dispose observer, do not emit runtime_turn_settled
events seen after submitting are buffered as candidate evidence
candidate evidence becomes valid only after endpoint acceptance
session.error after endpoint acceptance is still a failed turn signal
```

This avoids both bad outcomes:

- missing a very fast turn that finishes while the HTTP request is in flight;
- emitting a turn-settled event for a prompt that OpenCode rejected.

There are two integration shapes:

1. **Single prompt wrapper for delivery.**

   ```text
   promptAsyncWithTurnSettled()
   -> begin observation
   -> prompt_async
   -> bounded wait
   -> return accepted + telemetry outcome
   ```

2. **Preview-derived launch event.**

   ```text
   promptAsync(record)
   existing observePreview(record) in concurrent settle phase
   existing reconcileSession(record)
   coordinator emits turn-settled from preview + reconcile summary
   ```

Launch should not open a second SSE stream in v1. If live tests prove preview misses too many fast bootstrap turns, add split observe-around-prompt later.

### 6.3 Event Outcome

Allowed OpenCode outcomes:

```ts
export type OpenCodeTurnSettledOutcome =
  | 'success'
  | 'error'
  | 'timeout'
  | 'stream_unavailable'
  | 'idle_without_assistant_activity';
```

Interpretation:

- `success`: assistant-turn activity was observed and no `session.error` happened before idle.
- `error`: `session.error` happened before idle or stream termination.
- `timeout`: observer connected but did not see a terminal event within budget.
- `stream_unavailable`: SSE could not be opened.
- `idle_without_assistant_activity`: an idle signal was seen after prompt submission, but no assistant-turn session/message/tool activity was observed. This still wakes reconcile, but diagnostics should flag weak correlation.

All outcomes can still enqueue reconcile, because even an error can leave board state changed through earlier tool calls.

### 6.4 Idempotency

Use one deterministic source identity:

```text
runtime-turn-settled:opencode:<sessionId>:<turnId>:no-transcript:<payloadHash>
```

The file store already dedupes by source ID after normalization.

OpenCode emission coordinator must also avoid duplicate writes for the same prompt path:

```ts
let emitted = false;

async function emitOnce(outcome: OpenCodeTurnSettledOutcome) {
  if (emitted) return;
  emitted = true;
  await emitter.emit(buildEvent({ outcome }));
}
```

### 6.5 Message ID

If we add explicit `messageID` to `prompt_async`, it must be OpenCode-compatible:

```ts
function buildOpenCodePromptMessageId(input: {
  teamId: string;
  memberName: string;
  sessionId: string;
  purpose: string;
  nonce: string;
}): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 32);
  return `msg_${hash}`;
}
```

In v1, `turnId` can be generated by our observer even if `messageID` is not passed to OpenCode. However, passing a compatible `messageID` improves correlation and should be done if it does not break existing tests.

Important source-backed constraint:

- OpenCode SDK generated types expose `SessionPromptAsyncData.body.messageID?: string` for `/session/{id}/prompt_async`.
- OpenCode session prompt implementation uses `input.messageID ?? MessageID.ascending()` as the user message ID.

Therefore `messageID` is not just telemetry metadata. It becomes the OpenCode user-message identifier. Treat it as a per-prompt attempt ID, not as a long-lived delivery retry key.

Rules:

- Generate a fresh OpenCode prompt `messageID` for each accepted `prompt_async` attempt.
- Keep Agent Teams delivery idempotency in the existing `messageId` / ledger / relay fields, not by reusing OpenCode `messageID`.
- Do not retry a failed `prompt_async` with the same text and same `messageID` unless a targeted live test proves OpenCode dedupes that exact case safely.
- Store the generated OpenCode prompt `messageID` in diagnostics and turn-settled payload as `runtimePromptMessageId` for correlation.
- If OpenCode rejects the custom ID shape, fail the prompt normally in v1. Do not silently resend without `messageID`, because that can create duplicate user messages. A later compatibility fallback can be added only with explicit single-send guarantees.

---

## 7. Cross-Repo Contract

### 7.1 Spool Environment

Existing env variable:

```ts
export const RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV =
  'AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT';
```

Current `claude_team` behavior only returns this env for `codex`. Extend it to OpenCode:

```ts
export function buildRuntimeTurnSettledEnvironment(input: {
  provider: RuntimeTurnSettledProvider;
  spoolRoot: string;
}): Record<string, string> | null {
  if (input.provider !== 'codex' && input.provider !== 'opencode') {
    return null;
  }

  return {
    [RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]: input.spoolRoot,
  };
}
```

### 7.2 OpenCode Runtime Event Payload

Add this orchestrator payload:

```ts
export interface OpenCodeRuntimeTurnSettledEvent {
  schemaVersion: 1;
  provider: 'opencode';
  eventName: 'runtime_turn_settled';
  hookEventName: 'Stop';
  source: 'agent-teams-orchestrator-opencode';
  recordedAt: string;
  sessionId: string;
  turnId: string;
  teamName: string;
  memberName: string;
  cwd?: string;
  runtimePid?: number;
  outcome:
    | 'success'
    | 'error'
    | 'timeout'
    | 'stream_unavailable'
    | 'idle_without_assistant_activity';
  detail?: string;
  diagnostics?: string[];
}
```

Why keep `hookEventName: 'Stop'`:

- `RuntimeTurnSettledEvent` currently models provider "turn settled" as a Stop-like lifecycle signal.
- This avoids changing core semantics.
- It does not imply OpenCode has a real Claude Stop hook.

If desired later, rename the domain field to `eventKind`. Do not do that in this patch.

### 7.3 File Naming

Use the same atomic spool pattern as Codex:

```text
<spoolRoot>/incoming/<stamp>-.turn-settled.<pid>-<uuid>.opencode.json
```

Do not append to shared JSONL.

---

## 8. Orchestrator Implementation Plan

Repo:

```text
/Users/belief/dev/projects/claude/_worktrees/agent_teams_orchestrator_opencode_turn_settled
```

### 8.1 Add OpenCode Runtime Turn-Settled Emitter

File:

```text
src/services/opencode/OpenCodeRuntimeTurnSettledEmitter.ts
```

Example:

```ts
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV =
  'AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT';

export type OpenCodeRuntimeTurnSettledOutcome =
  | 'success'
  | 'error'
  | 'timeout'
  | 'stream_unavailable'
  | 'idle_without_assistant_activity';

export interface OpenCodeRuntimeTurnSettledEvent {
  schemaVersion: 1;
  provider: 'opencode';
  eventName: 'runtime_turn_settled';
  hookEventName: 'Stop';
  source: 'agent-teams-orchestrator-opencode';
  recordedAt: string;
  sessionId: string;
  turnId: string;
  teamName: string;
  memberName: string;
  cwd?: string;
  runtimePid?: number;
  outcome: OpenCodeRuntimeTurnSettledOutcome;
  detail?: string;
  diagnostics?: string[];
}

export interface OpenCodeRuntimeTurnSettledEmitterPort {
  emit(event: OpenCodeRuntimeTurnSettledEvent): Promise<void>;
}

export class FileOpenCodeRuntimeTurnSettledEmitter
  implements OpenCodeRuntimeTurnSettledEmitterPort
{
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async emit(event: OpenCodeRuntimeTurnSettledEvent): Promise<void> {
    const spoolRoot = this.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]?.trim();
    if (!spoolRoot) return;

    const incomingDir = join(spoolRoot, 'incoming');
    await mkdir(incomingDir, { recursive: true });

    const stamp = event.recordedAt.replace(/[-:.]/g, '');
    const suffix = `${process.pid}-${randomUUID()}`;
    const tempPath = join(incomingDir, `.turn-settled.${suffix}`);
    const finalPath = join(incomingDir, `${stamp}-${basename(tempPath)}.opencode.json`);

    await writeFile(tempPath, `${JSON.stringify(event)}\n`, 'utf8');
    await rename(tempPath, finalPath);
  }
}

export async function emitOpenCodeTurnSettledBestEffort(
  event: OpenCodeRuntimeTurnSettledEvent,
  emitter: OpenCodeRuntimeTurnSettledEmitterPort,
): Promise<void> {
  try {
    await emitter.emit(event);
  } catch {
    // Runtime turn-settled telemetry must never fail OpenCode delivery.
  }
}
```

### 8.2 Add OpenCode Turn-Settled Observer

File:

```text
src/services/opencode/OpenCodeTurnSettledObserver.ts
```

Responsibilities:

- open SSE before prompt;
- filter events by `sessionID`;
- mark assistant-turn activity only after `start()` is called;
- capture `session.error`;
- return terminal evidence on `session.idle` or `session.status idle`;
- timeout gracefully;
- never throw into delivery path;
- never write the spool directly.

Example interface:

```ts
export interface OpenCodeTurnSettledObservation {
  turnId: string;
  waitUntilReady(input: { timeoutMs: number }): Promise<'connected' | 'fallback' | 'timeout'>;
  markPromptSubmitting(): void;
  markPromptAcceptedByEndpoint(): void;
  markPromptRejectedByEndpoint(reason: string): void;
  waitForSettled(input: { timeoutMs: number }): Promise<OpenCodeTurnSettledEvidence>;
  dispose(): void;
}

export interface OpenCodeTurnSettledEvidence {
  readiness: 'connected' | 'fallback' | 'timeout';
  promptLifecycle: 'accepted_by_endpoint' | 'rejected_by_endpoint' | 'unknown';
  outcome: OpenCodeRuntimeTurnSettledOutcome;
  sawAssistantTurnActivity: boolean;
  sawError: boolean;
  diagnostics: string[];
}

export interface OpenCodeTurnSettledObserverPort {
  observe(input: OpenCodeTurnSettledObserveInput): OpenCodeTurnSettledObservation;
}

export interface OpenCodeTurnSettledObserveInput {
  baseUrl: string;
  sessionId: string;
  teamName: string;
  memberName: string;
  selectedModel: string;
  projectPath?: string | null;
  runtimePid?: number | null;
  turnId: string;
  timeoutMs?: number;
}
```

Status and session identity rules:

```ts
function sessionIdFromEvent(event: OpenCodeSseEvent): string | null {
  const properties = event.properties;
  if (event.type === 'session.error') {
    return asString(properties.sessionID);
  }
  return (
    asString(properties.sessionID)
    ?? asString(asRecord(properties.info)?.sessionID)
    ?? asString(asRecord(properties.part)?.sessionID)
  );
}

function isCurrentSessionEvent(event: OpenCodeSseEvent, sessionId: string): boolean {
  const eventSessionId = sessionIdFromEvent(event);
  return eventSessionId === sessionId;
}

function getOpenCodeSessionStatusType(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return asString(record?.type);
}
```

Do not infer `session.error` from `info.sessionID` or `part.sessionID`; current generated SDK shape uses `properties.sessionID?` for session error. If missing, record a diagnostic and do not classify the turn as error without later matched session evidence.

Core event handling:

```ts
function isRelevantDirectory(event: OpenCodeSseEvent, projectPath?: string | null): boolean {
  if (!projectPath || !event.directory) return true;
  return normalizePathForCompare(event.directory) === normalizePathForCompare(projectPath);
}

function isTerminalIdle(event: OpenCodeSseEvent): boolean {
  if (event.type === 'session.status') {
    return getOpenCodeSessionStatusType(event.properties.status) === 'idle';
  }
  return event.type === 'session.idle'; // Deprecated in OpenCode source, kept as legacy fallback.
}

const assistantMessageIds = new Set<string>();

function isAssistantTurnActivityEvent(event: OpenCodeSseEvent, runtimePromptMessageId: string): boolean {
  if (event.type === 'session.status') {
    return getOpenCodeSessionStatusType(event.properties.status) === 'busy';
  }

  if (event.type === 'message.updated') {
    const info = asRecord(event.properties.info);
    const messageId = asString(info?.id);
    const role = asString(info?.role);
    if (messageId && role === 'assistant') {
      assistantMessageIds.add(messageId);
      return true;
    }
    return false; // user message persistence is not assistant-turn activity.
  }

  if (event.type === 'message.part.updated' || event.type === 'message.part.delta') {
    const part = asRecord(event.properties.part);
    const messageId = asString(part?.messageID) ?? asString(event.properties.messageID);
    if (!messageId || messageId === runtimePromptMessageId) return false;
    if (assistantMessageIds.has(messageId)) return true;
    const partType = asString(part?.type);
    return partType === 'tool'
      || partType === 'step-start'
      || partType === 'step-finish'
      || partType === 'reasoning';
  }

  return false;
}
```

Prompt lifecycle behavior:

```ts
let promptLifecycle:
  | 'pending'
  | 'submitting'
  | 'accepted_by_endpoint'
  | 'rejected_by_endpoint' = 'pending';
let candidateAssistantTurnActivity = false;
let candidateTerminalIdle: OpenCodeSseEvent | null = null;
let candidateSessionError = false;

function markPromptSubmitting() {
  if (promptLifecycle === 'pending') {
    promptLifecycle = 'submitting';
  }
}

function markPromptAcceptedByEndpoint() {
  if (promptLifecycle !== 'rejected_by_endpoint') {
    promptLifecycle = 'accepted_by_endpoint';
    if (candidateAssistantTurnActivity) sawAssistantTurnActivity = true;
    if (candidateSessionError) {
      resolveTerminalEvidence('error');
      return;
    }
    if (candidateTerminalIdle) resolveFromIdle(candidateTerminalIdle);
  }
}

function markPromptRejectedByEndpoint(reason: string) {
  promptLifecycle = 'rejected_by_endpoint';
  diagnostics.push(`OpenCode prompt_async rejected before turn-settled emission: ${reason}`);
}
```

Core event behavior:

```ts
if (!isRelevantDirectory(event, input.projectPath)) return;

if (event.type === 'session.error' && !sessionIdFromEvent(event)) {
  diagnostics.push('OpenCode session.error observed without matching session identity');
  return;
}

if (!isCurrentSessionEvent(event, input.sessionId)) return;

if (isAssistantTurnActivityEvent(event, turnId)) {
  if (promptLifecycle === 'submitting') {
    candidateAssistantTurnActivity = true;
  } else if (promptLifecycle === 'accepted_by_endpoint') {
    sawAssistantTurnActivity = true;
  }
}

if (event.type === 'session.error') {
  if (promptLifecycle === 'submitting' || promptLifecycle === 'accepted_by_endpoint') {
    sawError = true;
    diagnostics.push('OpenCode session.error observed before idle');
    if (promptLifecycle === 'submitting') {
      candidateSessionError = true;
      return;
    }
    resolveTerminalEvidence('error');
    return;
  } else {
    diagnostics.push('OpenCode session.error observed before prompt submit window');
  }
}

if (isTerminalIdle(event)) {
  if (promptLifecycle === 'submitting') {
    candidateTerminalIdle = event;
    return;
  }
  if (promptLifecycle !== 'accepted_by_endpoint') return;
  const outcome = sawError
    ? 'error'
    : sawAssistantTurnActivity
      ? 'success'
      : 'idle_without_assistant_activity';
  resolveTerminalEvidence(outcome);
}
```

Timeout behavior:

```ts
async waitForSettled({ timeoutMs }: { timeoutMs: number }) {
  return await Promise.race([
    terminalEvidencePromise,
    sleep(timeoutMs).then(() => buildEvidence(streamConnected ? 'timeout' : 'stream_unavailable')),
  ]);
}
```

Readiness behavior:

```ts
async waitUntilReady({ timeoutMs }: { timeoutMs: number }) {
  return await Promise.race([
    streamConnectedPromise.then(() => 'connected' as const),
    endpointFallbackPromise.then(() => 'fallback' as const),
    sleep(timeoutMs).then(() => 'timeout' as const),
  ]);
}
```

`waitUntilReady()` is advisory. If it times out, the prompt still proceeds and the final outcome can become `stream_unavailable` or `timeout`.

### 8.2b Add Turn-Settled Emission Coordinator

File:

```text
src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.ts
```

Responsibility:

- combine observer evidence with existing reconcile/preview evidence;
- avoid premature timeout emission when existing reconcile proves assistant-turn activity;
- build one final `OpenCodeRuntimeTurnSettledEvent`;
- call the file emitter once;
- translate outcome into existing bridge diagnostics.

Example:

```ts
export class OpenCodeTurnSettledEmissionCoordinator {
  constructor(private readonly emitter: OpenCodeRuntimeTurnSettledEmitterPort) {}

  async emitDelivery(input: {
    record: OpenCodeSessionRecord;
    turnId: string;
    teamName: string;
    memberName: string;
    observer: OpenCodeTurnSettledEvidence;
    prePromptCursor: string | null;
    reconcileSummary: OpenCodeSessionReconcileSummary | null;
    responseObservation?: OpenCodeDeliveryResponseObservation | null;
  }): Promise<TeamDiagnostic[]> {
    const finalOutcome = deriveDeliveryOutcome(input);
    await emitOpenCodeTurnSettledBestEffort(
      buildOpenCodeTurnSettledEvent({ ...input, outcome: finalOutcome.outcome }),
      this.emitter,
    );
    return [teamDiagnostic(finalOutcome.code, finalOutcome.message, finalOutcome.severity)];
  }
}
```

Derivation rules:

```ts
function didReconcileAdvance(input: {
  prePromptCursor: string | null;
  summary: OpenCodeSessionReconcileSummary | null;
}): boolean {
  return Boolean(
    input.summary
    && input.summary.lastCanonicalCursor
    && input.summary.lastCanonicalCursor !== input.prePromptCursor
  );
}

function deriveDeliveryOutcome(input: DeliveryEmissionInput): FinalOpenCodeTurnOutcome {
  if (didResponseObservationProveActivity(input.responseObservation)) {
    return success('response_observation_proved_activity');
  }

  if (didReconcileAdvance(input)) {
    return success('reconcile_advanced_after_prompt');
  }

  if (input.observer.outcome === 'error') {
    return failure('error', 'observer_session_error');
  }

  if (input.observer.outcome === 'success') {
    return success('observer_idle_after_activity');
  }

  return {
    outcome: input.observer.outcome,
    diagnostics: input.observer.diagnostics,
  };
}
```

Launch derivation is similar but uses preview summary plus reconcile summary:

```ts
function deriveLaunchOutcome(input: LaunchEmissionInput): FinalOpenCodeTurnOutcome {
  if (didPreviewObserveActivity(input.preview) || didReconcileAdvance(input)) {
    return success('launch_preview_or_reconcile_activity');
  }
  if (input.preview?.runtimeState === 'error') {
    return failure('error', 'launch_preview_session_error');
  }
  return { outcome: 'timeout', diagnostics: ['launch_preview_no_activity'] };
}

function didPreviewObserveActivity(summary: OpenCodeSessionPreviewSummary | null): boolean {
  if (!summary) return false;
  return Boolean(
    summary.previewOutcome === 'observed'
    && (
      summary.runtimeState === 'idle'
      || summary.latestEventType === 'session.idle'
      || summary.latestAssistantMessageId
      || summary.latestAssistantPreview
    )
  );
}
```

The coordinator is the only object that writes spool files for OpenCode turn-settled. The observer and preview reader return evidence only.

Do not treat `previewOutcome === 'observed'` alone as success. The current preview observer can return `observed` after a bounded timeout once the stream was connected. The coordinator needs session activity evidence, not just stream availability.

### 8.3 Reuse Or Extract SSE Helpers

Existing file:

```text
src/services/opencode/OpenCodePreviewObserver.ts
```

It already contains:

- SSE parsing;
- OpenCode event normalization;
- session ID extraction logic.

Required signature change:

```ts
type ObserveSessionParams = {
  baseUrl: string;
  sessionId: string;
  projectPath?: string | null;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}
```

`OpenCodeSessionBridge.observePreview(record, ...)` must pass `record.projectPath` into `openCodePreviewObserver.observeSession(...)`.

Current weak spot found in code:

```ts
const status = asString(properties.status)
```

OpenCode SDK types model `session.status.properties.status` as an object:

```ts
type SessionStatus = { type: 'idle' } | { type: 'busy' } | { type: 'retry', ... }
```

Older/live shapes can still be strings, so the shared helper must normalize both. This should be fixed while extracting helpers, otherwise `session.status idle` may be missed by both preview and turn-settled logic.

Preferred low-risk approach:

1. Extract shared pure helpers into:

```text
src/services/opencode/OpenCodeSseEventStream.ts
```

2. Keep `OpenCodePreviewObserver` behavior unchanged.
3. Add tests that both preview and turn-settled observers parse the same fixture events.

Example shared API:

```ts
export function normalizeOpenCodeSseEvent(raw: unknown): OpenCodeSseEvent | null;
export function parseOpenCodeSseDataBlocks(input: string): string[];
export function extractOpenCodeSseDataLines(block: string): string | null;
export function getOpenCodeSessionStatusType(value: unknown): string | null;
export async function* readOpenCodeSseEvents(input: {
  fetchImpl: typeof fetch;
  endpointUrl: string;
  signal: AbortSignal;
  projectPath?: string | null;
}): AsyncIterable<OpenCodeSseEvent>;
```

If extraction looks risky, duplicate the small parser in v1 and document a follow-up dedupe task. However, extraction is preferred for DRY if tests stay tight.

Current-code weak spots that this extraction must fix:

1. `OpenCodePreviewObserver` currently reads `properties.status` as a string. It must use `getOpenCodeSessionStatusType()` so `{ type: 'idle' }` is terminal.
2. `OpenCodePreviewObserver` currently has `directory` on normalized events but no `projectPath` input, so `/global/event` fallback cannot reject foreign project events. Extend `ObserveSessionParams` with `projectPath?: string | null`, pass `record.projectPath` from `OpenCodeSessionBridge.observePreview()`, and filter before session matching.
3. `session.error` without a session identity should not mark the current session as errored. It should add a diagnostic and wait for matched session activity. This matters because current SDK types allow missing `sessionID`.
4. `server.connected` proves stream readiness only. It must not increment assistant-turn activity or launch success evidence.
5. Multiline SSE `data:` blocks and comment lines should stay supported. Do not replace the parser with a naive `split('\n')`.

### 8.4 Integrate With OpenCodeSessionBridge

File:

```text
src/services/opencode/OpenCodeSessionBridge.ts
```

Extend deps:

```ts
type OpenCodeSessionBridgeDeps = {
  // existing deps
  turnSettledObserver?: OpenCodeTurnSettledObserverPort;
}
```

Do not put final emission policy in `OpenCodeSessionBridge`. The bridge owns host/session IO. The command handler owns command-level evidence composition because it already has `prePromptCursor`, response observation, preview summary, and reconcile summary.

Current code shape:

```text
OpenCodeBridgeCommandHandler.ts
-> module-level runLaunch/runSendMessage functions
-> singleton imports: openCodeSessionBridge, openCodeSessionStore, ...
-> export executeOpenCodeBridgeCommandEnvelope(input)
```

Do not introduce a large class refactor in this patch. Add a small optional dependency seam:

```ts
type OpenCodeBridgeCommandRuntimeDeps = {
  sessionBridge: typeof openCodeSessionBridge;
  turnSettledCoordinator?: OpenCodeTurnSettledEmissionCoordinator;
}

const defaultBridgeCommandRuntimeDeps: OpenCodeBridgeCommandRuntimeDeps = {
  sessionBridge: openCodeSessionBridge,
  turnSettledCoordinator: defaultOpenCodeTurnSettledCoordinator,
};

export async function executeOpenCodeBridgeCommandEnvelope(
  input: unknown,
  deps: OpenCodeBridgeCommandRuntimeDeps = defaultBridgeCommandRuntimeDeps,
) {
  // pass deps into runLaunch/runSendMessage only where needed
}
```

This keeps the CLI public API unchanged, improves testability, and avoids rewriting the whole command handler.

Host lifecycle rule:

- For delivery v1, keep observe -> prompt -> waitForSettled inside one `withSessionHost()` callback.
- Do not create an observation inside `withSessionHost()` and return it after the callback exits.
- If a future split observer is added, it must own a separate host ref and release it from `dispose()` / `waitForSettled()` finalizer.

Future split scope shape:

```ts
type OpenCodeObservedPromptScope = {
  baseUrl: string;
  runtimePid: number | null;
  observation: OpenCodeTurnSettledObservation;
  submit(params: OpenCodePromptParams): Promise<void>;
  dispose(): Promise<void>;
};
```

Add prompt context:

```ts
type OpenCodePromptTurnSettledContext = {
  teamName: string;
  memberName: string;
  purpose: 'launch' | 'delivery' | 'reminder' | 'manual';
  turnId?: string;
  readyTimeoutMs?: number;
  timeoutMs?: number;
};
```

Do not change the behavior of existing `promptAsync()` calls. Add one public opt-in wrapper for delivery and one private helper:

1. A convenience wrapper for single delivery prompts.
2. A private submit helper that can include `messageID` without changing public `promptAsync()` behavior.
3. Coordinator methods in the command handler that reuse existing `observePreview()` output for launch.

Private submit helper:

```ts
private async submitPromptAsync(
  record: OpenCodeSessionRecord,
  params: {
    text: string;
    agent?: string;
    noReply?: boolean;
    system?: string;
    messageID?: string;
  },
): Promise<void>
```

Existing public method remains a wrapper:

```ts
async promptAsync(record, params): Promise<void> {
  await this.submitPromptAsync(record, params);
}
```

Single-prompt wrapper:

```ts
async promptAsyncWithTurnSettled(
  record: OpenCodeSessionRecord,
  params: {
    text: string;
    agent?: string;
    noReply?: boolean;
    system?: string;
    turnSettled: OpenCodePromptTurnSettledContext;
  },
): Promise<OpenCodePromptTurnSettledResult>
```

Guard:

- `promptAsyncWithTurnSettled()` is for prompts that can produce an assistant turn.
- `runSendMessage()` must call plain `promptAsync()` when `body.noReply === true`.
- Add a defensive assertion inside `promptAsyncWithTurnSettled()` so accidental no-reply use fails in tests before production wiring.

Do not expand bridge command public data unless needed. The final coordinator result can be converted into existing `diagnostics`:

```ts
teamDiagnostic(
  `opencode_turn_settled_${outcome}`,
  `OpenCode turn-settled observer finished with outcome=${outcome}`,
  outcome === 'success' ? 'info' : 'warning',
)
```

This keeps `OpenCodeSendMessageCommandData` and renderer IPC stable.

Delivery wrapper implementation sketch:

```ts
async promptAsyncWithTurnSettled(record, params): Promise<OpenCodePromptTurnSettledResult> {
  if (params.noReply === true) {
    throw new Error('OpenCode turn-settled observation does not support noReply prompts');
  }

  return await this.withSessionHost(record, async ({ baseUrl, runtimePid }) => {
    const turnId = params.turnSettled.turnId ?? buildOpenCodePromptMessageId({
      teamId: record.teamId,
      memberName: record.memberName,
      sessionId: record.opencodeSessionId,
      purpose: params.turnSettled.purpose,
      nonce: new Date().toISOString(),
    });

    const observation = this.turnSettledObserver.observe({
      baseUrl,
      sessionId: record.opencodeSessionId,
      teamName: params.turnSettled.teamName,
      memberName: params.turnSettled.memberName,
      selectedModel: record.selectedModel,
      projectPath: record.projectPath,
      runtimePid,
      turnId,
    });

    try {
      observation.markPromptSubmitting();
      try {
        await this.submitPromptAsync(record, {
          text: params.text,
          agent: params.agent,
          noReply: params.noReply,
          system: params.system,
          messageID: turnId,
        });
        observation.markPromptAcceptedByEndpoint();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        observation.markPromptRejectedByEndpoint(message);
        throw error;
      }

      const evidence = await observation.waitForSettled({
        timeoutMs: params.turnSettled.timeoutMs ?? OPENCODE_SEND_TURN_SETTLED_TIMEOUT_MS,
      });

      return { ok: true, turnId, readiness, evidence };
    } finally {
      observation.dispose();
    }
  });
}
```

Launch preview-derived coordinator sketch:

```ts
const settledMembers = await mapWithConcurrency(promptedMembers, 3, async ({ name, record }) => {
  let preview: OpenCodePreviewSummary | null = null;
  let reconciled: OpenCodeSessionReconcileSummary | null = null;

  try {
    preview = await deps.sessionBridge.observePreview(record, {
      timeoutMs: OPENCODE_LAUNCH_PREVIEW_TIMEOUT_MS,
      idleTimeoutMs: OPENCODE_LAUNCH_PREVIEW_IDLE_TIMEOUT_MS,
    });
  } catch (error) {
    // Existing launch preview diagnostics stay unchanged.
  }

  try {
    reconciled = await deps.sessionBridge.reconcileSession(record, { limit: 50 });
  } catch (error) {
    // Existing launch reconcile diagnostics stay unchanged.
  }

  await deps.turnSettledCoordinator?.emitLaunch({
    record,
    turnId: buildOpenCodeLaunchTurnId(record),
    teamName: teamId,
    memberName: name,
    preview: preview?.summary ?? null,
    reconcileSummary: reconciled,
  });

  return { name, record, reconciled };
});
```

Risk:

- Adding `messageID` to all prompts could affect OpenCode behavior.
- Waiting for settlement can increase bridge command latency.

Mitigation:

- Keep `promptAsync()` unchanged for unobserved prompt paths.
- Only pass `messageID` inside `promptAsyncWithTurnSettled()`.
- Ensure generated ID starts with `msg_`.
- Keep wait bounded and return `timeout` evidence rather than waiting indefinitely.
- Test existing prompt paths remain unchanged.

### 8.5 Add Turn-Settled Context At Prompt Sites

Prompt sites:

```text
src/services/opencode/OpenCodeBridgeCommandHandler.ts
```

Known calls:

- launch/bootstrap prompt around `openCodeSessionBridge.promptAsync(record, ...)`;
- delivery prompt inside `runSendMessage()`.

Launch prompt example:

```ts
await openCodeSessionBridge.promptAsync(record, {
  text: `${runtimeIdentityBlock}\n\n${prompt}`,
  agent: 'teammate',
});
promptedMembers.push({ name, record });
```

Launch settle phase example:

```ts
const preview = await safeObservePreview(record);
const reconciled = await safeReconcileSession(record, { limit: 50 });
const diagnostics = await deps.turnSettledCoordinator?.emitLaunch({
  record,
  teamName: teamId,
  memberName: name,
  turnId: buildOpenCodeLaunchTurnId(record),
  preview: preview?.summary ?? null,
  reconcileSummary: reconciled,
});
```

Delivery prompt example:

```ts
const promptText = identityReminder ? `${identityReminder}\n\n${text}` : text;

const turnSettled = body.noReply === true
  ? null
  : await deps.sessionBridge.promptAsyncWithTurnSettled(deliveryRecord, {
      text: promptText,
      agent: asString(body.agent) ?? 'teammate',
      turnSettled: {
        teamName: teamId,
        memberName,
        purpose: 'delivery',
        timeoutMs: OPENCODE_SEND_TURN_SETTLED_TIMEOUT_MS,
      },
    });

if (body.noReply === true) {
  await deps.sessionBridge.promptAsync(deliveryRecord, {
    text: promptText,
    agent: asString(body.agent) ?? 'teammate',
    noReply: true,
  });
}

const reconcileSummary = await safeReconcileSession(deliveryRecord, { limit: 50 });
const responseObservation = observeOpenCodeDeliveryResponse(...);
const diagnostics = turnSettled
  ? await deps.turnSettledCoordinator?.emitDelivery({
      record: deliveryRecord,
      teamName: teamId,
      memberName,
      turnId: turnSettled.turnId,
      observer: turnSettled.evidence,
      prePromptCursor,
      reconcileSummary,
      responseObservation,
    })
  : [];
```

Suggested defaults:

```ts
const OPENCODE_SEND_TURN_SETTLED_TIMEOUT_MS = 12_000;
const OPENCODE_SEND_TURN_SETTLED_IDLE_TIMEOUT_MS = 2_500;
```

Keep these bounded. They are bridge-command telemetry budgets, not model behavior guarantees.

### 8.6 Bounded Wait, Not Background Fire-And-Forget

Do not leave the observer running in the background after the bridge command returns.

Bad:

```ts
void observation.waitForSettled({ timeoutMs: OPENCODE_SEND_TURN_SETTLED_TIMEOUT_MS });
return accepted;
```

Good:

```ts
const outcome = await observation.waitForSettled({ timeoutMs: OPENCODE_SEND_TURN_SETTLED_TIMEOUT_MS });
const reconcileSummary = await reconcileSession(record);
await deps.turnSettledCoordinator?.emitDelivery({ observer: outcome, reconcileSummary, ... });
return { accepted, diagnostics };
```

Acceptance semantics remain:

- `prompt_async` accepted means delivery accepted;
- observer timeout does not turn accepted delivery into failed delivery;
- post-send reconcile can still warn;
- turn-settled event is extra input for member-work-sync.

Practical tradeoff:

- The bridge command can take up to the telemetry budget longer.
- This is acceptable because OpenCode bridge calls already wait for delivery observation/reconcile in several paths, and durability matters more than a fire-and-forget signal that may never be written.

---

## 9. claude_team Implementation Plan

Repo:

```text
/Users/belief/dev/projects/claude/_worktrees/claude_team_member_work_sync_opencode
```

### 9.1 Extend Provider Type

File:

```text
src/features/member-work-sync/core/domain/RuntimeTurnSettledProvider.ts
```

Change:

```ts
export type RuntimeTurnSettledProvider = 'claude' | 'codex' | 'opencode';

export function isRuntimeTurnSettledProvider(
  value: unknown
): value is RuntimeTurnSettledProvider {
  return value === 'claude' || value === 'codex' || value === 'opencode';
}
```

### 9.2 Add OpenCode Payload Normalizer

File:

```text
src/features/member-work-sync/main/infrastructure/OpenCodeTurnSettledPayloadNormalizer.ts
```

Example:

```ts
export class OpenCodeTurnSettledPayloadNormalizer
  implements RuntimeTurnSettledPayloadNormalizerPort
{
  constructor(private readonly hash: MemberWorkSyncHashPort) {}

  normalize(input: {
    provider: RuntimeTurnSettledProvider;
    raw: string;
    recordedAt: string;
  }): RuntimeTurnSettledPayloadNormalization {
    if (input.provider !== 'opencode') {
      return { ok: false, reason: 'unsupported_provider' };
    }

    const payload = parseObject(input.raw);
    if (!payload.ok) {
      return { ok: false, reason: payload.reason };
    }

    if (getString(payload.value, 'provider') !== 'opencode') {
      return { ok: false, reason: 'provider_mismatch' };
    }
    if (getString(payload.value, 'source') !== 'agent-teams-orchestrator-opencode') {
      return { ok: false, reason: 'source_mismatch' };
    }
    if (getString(payload.value, 'eventName', 'event_name') !== 'runtime_turn_settled') {
      return { ok: false, reason: 'not_turn_settled_event' };
    }

    const sessionId = getString(payload.value, 'sessionId', 'session_id');
    const teamName = getString(payload.value, 'teamName', 'team_name');
    const memberName = getString(payload.value, 'memberName', 'member_name');
    if (!sessionId) return { ok: false, reason: 'missing_session_identity' };
    if (!teamName || !memberName) {
      return { ok: false, reason: 'missing_team_member_identity' };
    }

    const payloadHash = this.hash.sha256Hex(input.raw);
    const turnId = getString(payload.value, 'turnId', 'turn_id');
    const outcome = getString(payload.value, 'outcome');

    return {
      ok: true,
      event: {
        schemaVersion: 1,
        provider: 'opencode',
        hookEventName: 'Stop',
        payloadHash,
        recordedAt: getString(payload.value, 'recordedAt', 'recorded_at') ?? input.recordedAt,
        sourceId: buildRuntimeTurnSettledSourceId({
          provider: 'opencode',
          sessionId,
          turnId,
          payloadHash,
        }),
        sessionId,
        ...(turnId ? { turnId } : {}),
        teamName,
        memberName,
        ...(outcome ? { outcome } : {}),
      },
    };
  }
}
```

Validation rules:

- reject invalid JSON;
- reject source mismatch;
- require session ID;
- require team and member identity;
- accept known outcomes but do not fail if outcome is unknown, because event still wakes reconcile.

### 9.3 Add Normalizer To Composition

File:

```text
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
```

Change:

```ts
const runtimeTurnSettledNormalizer = new CompositeRuntimeTurnSettledPayloadNormalizer([
  new ClaudeStopHookPayloadNormalizer(hash),
  new CodexNativeTurnSettledPayloadNormalizer(hash),
  new OpenCodeTurnSettledPayloadNormalizer(hash),
]);
```

### 9.4 Extend Target Resolver

File:

```text
src/features/member-work-sync/main/adapters/output/TeamRuntimeTurnSettledTargetResolver.ts
```

Add OpenCode branch matching Codex style:

```ts
async resolve(event: RuntimeTurnSettledEvent): Promise<RuntimeTurnSettledTargetResolution> {
  if (event.provider === 'codex') {
    return this.resolveExplicitProviderEvent(event, 'codex');
  }
  if (event.provider === 'opencode') {
    return this.resolveExplicitProviderEvent(event, 'opencode');
  }
  // existing Claude transcript/session scan
}
```

Shared helper:

```ts
private async resolveExplicitProviderEvent(
  event: RuntimeTurnSettledEvent,
  expectedProviderId: 'codex' | 'opencode'
): Promise<RuntimeTurnSettledTargetResolution> {
  const teamName = event.teamName?.trim();
  const memberName = event.memberName?.trim();
  if (!teamName || !memberName) {
    return { ok: false, reason: 'missing_team_member_identity' };
  }

  const member = await this.resolveActiveMember(teamName, memberName);
  if (!member) {
    return { ok: false, reason: 'member_not_active' };
  }
  if (isReservedMemberName(member.name)) {
    return { ok: false, reason: 'reserved_member' };
  }

  const providerId = providerForMember(member);
  if (providerId && providerId !== expectedProviderId) {
    return { ok: false, reason: 'provider_mismatch' };
  }

  return {
    ok: true,
    teamName,
    memberName: normalizeMemberName(member.name),
  };
}
```

This reduces duplication and keeps Codex/OpenCode explicit identity resolution consistent.

### 9.5 Split Spool Initialization From Shell Hook Installation

Current weak spot:

`ShellRuntimeTurnSettledHookScriptInstaller` both creates the spool root and installs the Claude shell hook script. Reusing it for OpenCode works accidentally but is confusing and can become wrong as more provider-native emitters are added.

Add a provider-neutral initializer:

```text
src/features/member-work-sync/main/infrastructure/RuntimeTurnSettledSpoolInitializer.ts
```

Example:

```ts
export interface RuntimeTurnSettledSpoolInitializerPort {
  ensure(): Promise<{ spoolRoot: string }>;
}

export class RuntimeTurnSettledSpoolInitializer
  implements RuntimeTurnSettledSpoolInitializerPort
{
  constructor(private readonly paths: RuntimeTurnSettledSpoolPaths) {}

  async ensure(): Promise<{ spoolRoot: string }> {
    const root = this.paths.getSpoolRoot();
    await Promise.all([
      mkdir(join(root, 'incoming'), { recursive: true }),
      mkdir(join(root, 'processing'), { recursive: true }),
      mkdir(join(root, 'processed'), { recursive: true }),
      mkdir(join(root, 'invalid'), { recursive: true }),
    ]);
    return { spoolRoot: root };
  }
}
```

Then:

- Claude hook settings still use `ShellRuntimeTurnSettledHookScriptInstaller`.
- Codex and OpenCode runtime env use `RuntimeTurnSettledSpoolInitializer`.
- This keeps shell-hook concerns out of provider-native turn-settled emitters.

Extend environment builder:

```text
src/features/member-work-sync/main/infrastructure/runtimeTurnSettledEnvironment.ts
```

```ts
export function buildRuntimeTurnSettledEnvironment(input: {
  provider: RuntimeTurnSettledProvider;
  spoolRoot: string;
}): Record<string, string> | null {
  if (input.provider !== 'codex' && input.provider !== 'opencode') {
    return null;
  }

  return {
    [RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]: input.spoolRoot,
  };
}
```

### 9.6 Extend File Store Provider Parsing

File:

```text
src/features/member-work-sync/main/infrastructure/FileRuntimeTurnSettledEventStore.ts
```

Current weak spot:

```ts
function parseProviderFromFileName(fileName: string): 'claude' | 'codex' | null
```

This currently extracts the provider token from the second-to-last filename segment and validates it through `isRuntimeTurnSettledProvider(provider)`. After the provider union is extended, the runtime behavior is almost correct, but the explicit return type would still make TypeScript reject `opencode` and can hide future provider additions.

Change to:

```ts
function parseProviderFromFileName(fileName: string): RuntimeTurnSettledProvider | null {
  const parts = fileName.split('.');
  const provider = parts.length >= 3 ? parts[parts.length - 2] : null;
  return isRuntimeTurnSettledProvider(provider) ? provider : null;
}
```

Add a test that a valid `.opencode.json` file reaches the normalizer instead of invalid quarantine.

### 9.7 Pass Env To OpenCode Bridge Launch

Find where `claude_team` invokes `agent_teams_orchestrator` OpenCode bridge commands.

Expected service area:

```text
src/main/services/team/
src/features/runtime-provider-management/
```

Concrete path found in current code:

```text
src/main/index.ts
createOpenCodeRuntimeAdapterRegistry()
```

The important detail: `OpenCodeBridgeCommandClient` captures `env` in its constructor. Adding env after the client is constructed is too late.

Second important detail found in current composition order:

```text
teamProvisioningService.setRuntimeAdapterRegistry(await createOpenCodeRuntimeAdapterRegistry())
...
memberWorkSyncFeature = createMemberWorkSyncFeature(...)
```

So `createOpenCodeRuntimeAdapterRegistry()` currently runs before `memberWorkSyncFeature` exists. A naive call to `memberWorkSyncFeature.buildRuntimeTurnSettledEnvironment({ provider: 'opencode' })` inside the registry factory would always see `null`.

Related code path:

```text
TeamProvisioningService.buildRuntimeTurnSettledEnvironment(providerId)
```

currently returns env only for `codex`. That path is for native provider process launches. OpenCode secondary teammates use the OpenCode runtime adapter bridge, whose env is captured by `OpenCodeBridgeCommandClient` in `src/main/index.ts`. Therefore the v1 OpenCode wiring must target the bridge client env, not only the generic provisioning env helper.

Preferred composition fix:

```text
create TeamDataService
create TeamProvisioningService
create memberWorkSyncFeature
register runtimeTurnSettled providers on TeamProvisioningService
create OpenCode runtime adapter registry with memberWorkSyncFeature available
```

Keep delayed side effects where they are:

- startup replay/scan still runs after service wiring;
- IPC registration still runs after window/service setup;
- `memberWorkSyncFeature.noteTeamChange(...)` remains guarded by nullable access in emitters.

The runtime launch/handoff path must merge:

```ts
const openCodeTurnSettledEnv =
  await memberWorkSyncFeature.buildRuntimeTurnSettledEnvironment({ provider: 'opencode' });
```

into the environment used for the OpenCode bridge process.

Important:

- do not overwrite existing env;
- merge before constructing `OpenCodeBridgeCommandClient`;
- do not expose this env to unrelated user project scripts;
- missing env means telemetry disabled, not runtime failure.
- keep `TeamProvisioningService.buildRuntimeTurnSettledEnvironment()` codex-only unless a real OpenCode path later launches a provider process directly through that generic helper.

Example:

```ts
const bridgeEnv = applyOpenCodeAutoUpdatePolicy({ ...process.env });
const turnSettledEnv = memberWorkSyncFeature
  ? await memberWorkSyncFeature.buildRuntimeTurnSettledEnvironment({ provider: 'opencode' })
  : null;
Object.assign(bridgeEnv, turnSettledEnv ?? {});

const bridgeClient = new OpenCodeBridgeCommandClient({
  binaryPath,
  tempDirectory,
  env: bridgeEnv,
});
```

---

## 10. Event Flow Details

### 10.1 Launch Bootstrap

OpenCode launch currently prompts teammates with runtime identity and briefing instructions.

New behavior:

```text
launch prompt accepted
-> existing preview/reconcile settle phase collects evidence
-> coordinator writes one spool event
-> app reconciles member agenda
```

Expected practical value:

- if launch finished and teammate has tasks, work-sync quickly re-evaluates;
- if launch errored, app still gets a signal and diagnostics;
- no direct user-visible UI changes.

### 10.2 User Delivery

OpenCode user-to-member message currently goes through `runSendMessage()`.

New behavior:

```text
delivery prompt accepted
-> observer tracks same session
-> post-send reconcile/response observation contributes evidence
-> coordinator writes one turn-settled event
-> member-work-sync recomputes whether member agenda is known/current
```

It does not replace:

- OpenCode delivery ledger;
- response observation;
- visible reply correlation;
- MCP readiness repair.

### 10.3 Watchdog Interaction

If OpenCode agent stalls after weak start:

1. delivery ledger/watchdog keeps existing behavior;
2. OpenCode turn-settled signal wakes member-work-sync after each turn;
3. member-work-sync may decide status is `needs_sync`;
4. future nudge outbox remains rate-limited;
5. task-stall monitor remains responsible for semantic no-progress.

No conflict because each layer has a different proof model.

---

## 11. Risks And Mitigations

### Risk 1: SSE Misses Fast Turns

Problem:

```text
prompt_async can return and OpenCode can finish very quickly.
```

Mitigation:

- start observer before `prompt_async`;
- call `markPromptSubmitting()` immediately before the HTTP request;
- buffer same-session activity and terminal idle seen while the request is in flight;
- validate buffered evidence only after `markPromptAcceptedByEndpoint()`;
- if `prompt_async` rejects, call `markPromptRejectedByEndpoint()` and do not emit a runtime turn-settled file.

Residual risk:

- if OpenCode emits a complete turn before SSE stream connects, v1 can miss it.

Fallback:

- bounded polling can be added if live tests show misses.

### Risk 2: Idle After Error Looks Like Success

Problem:

OpenCode emits `session.idle` after `session.error`.

Mitigation:

- preserve `sawError` state;
- treat matched `session.error` as terminal error evidence immediately;
- if matched `session.error` arrives while `prompt_async` is still in flight, buffer it and promote it after endpoint acceptance;
- return observer `outcome: 'error'`;
- let coordinator upgrade to success only if response/reconcile evidence proves later successful activity;
- include short diagnostic.

### Risk 3: Duplicate Idle Events

Problem:

Both `session.status idle` and `session.idle` can arrive.

Mitigation:

- observer-level `resolveOnce`;
- coordinator-level `emitOnce`;
- sourceId-level dedupe in `RuntimeTurnSettledIngestor`.

### Risk 4: Misattributing Member

Problem:

OpenCode session ID alone can be stale or reused in corrupted metadata.

Mitigation:

- payload includes explicit `teamName` and `memberName` from `OpenCodeSessionRecord`;
- resolver validates active team config/meta;
- resolver validates provider is `opencode`;
- reserved names rejected.

### Risk 5: Stale Removed Teammate Emits Event

Problem:

Old OpenCode process can still emit after member removal.

Mitigation:

- resolver checks config is not deleted and member has no `removedAt`;
- unresolved event is archived, not enqueued.

### Risk 6: Telemetry Breaks Delivery

Problem:

If observer or spool fails, message delivery should still work.

Mitigation:

- all turn-settled emission is best-effort;
- observer errors are diagnostics only;
- `prompt_async` acceptance remains the delivery acceptance boundary;
- `waitForSettled()` is bounded and returns `timeout`/`stream_unavailable`, not an exception that fails delivery.

Non-negotiable:

- do not use unbounded await;
- do not run the observer fire-and-forget after bridge command return.

### Risk 7: Message ID Changes Existing Behavior

Problem:

Passing `messageID` to `prompt_async` may alter idempotency in OpenCode.

Mitigation:

- only pass messageID when observer is enabled;
- generate valid `msg_...` ID;
- use unique turn ID, not deterministic retry ID, unless we explicitly want OpenCode-side idempotency later;
- tests verify existing no-observer prompt path sends no `messageID`.

### Risk 8: OpenCode Event Schema Changes

Problem:

OpenCode event properties use `sessionID`, `info.sessionID`, or `part.sessionID`.

Mitigation:

- reuse existing preview observer extraction logic;
- tolerate unknown event types;
- only rely on `session.status`, `session.idle`, `session.error`.

### Risk 8b: `session.error` Without Session Identity

Problem:

OpenCode SDK types allow `session.error.properties.sessionID` to be missing. Treating all host-level errors as the current session could misattribute errors if a host ever serves multiple sessions.

Mitigation:

- if `session.error` has the expected session ID, set `sawError = true`;
- if `session.error` has no session ID, record a diagnostic but do not mark error unless later matched activity/idle confirms the session;
- only add a stronger host-level fallback if the session bridge can prove the host is dedicated to this `OpenCodeSessionRecord`;
- tests cover sessionless error followed by matched idle and sessionless error with no matched activity.

### Risk 8c: Global Event Cross-Project Noise

Problem:

`/global/event` wraps events with a `directory` field. If `/event` fails and observer falls back to `/global/event`, unrelated project events can be visible on the same server stream.

Mitigation:

- pass `projectPath` from `OpenCodeSessionRecord` into observation input;
- when event has `directory`, compare it with normalized `projectPath`;
- ignore mismatched directory events before session matching;
- keep direct `/event` behavior unchanged when no directory is present;
- tests cover global event with matching directory and foreign directory.

### Risk 9: Long-Lived Background Observers Leak

Problem:

Many OpenCode messages can start many observers.

Mitigation:

- bounded timeout per observer;
- abort controller cleanup;
- no global listener per host in v1;
- unit test verifies `dispose()` aborts stream.

Additional constraint:

- observer lifetime must be scoped to one bridge command. If a future long-lived host-level observer is added, it should be a separate adapter with explicit lifecycle ownership and not hidden inside `promptAsyncWithTurnSettled()`.

### Risk 10: Nudges Become More Frequent

Problem:

More reconcile triggers could expose existing Phase 2 nudges.

Mitigation:

- nudges are active by default, but delivery remains bounded by dispatcher guards;
- queue quiet window debounces events;
- outbox has one item per fingerprint;
- dispatcher revalidates busy/watchdog cooldown before delivery.

### Risk 11: Bridge Command Timeout Budget

Problem:

`claude_team` currently runs `opencode.sendMessage` through `OpenCodeReadinessBridge`, whose default send timeout is `30_000ms`. `runSendMessage()` already does MCP readiness repair and a post-prompt reconcile with `OPENCODE_SEND_RECONCILE_TIMEOUT_MS = 5_000ms`. Adding a turn-settled wait can consume that budget and accidentally turn accepted prompts into bridge timeouts.

Mitigation:

- keep `OPENCODE_SEND_TURN_SETTLED_TIMEOUT_MS` below the send command budget, implemented default `12_000ms`;
- keep `OPENCODE_SEND_TURN_SETTLED_IDLE_TIMEOUT_MS` small, implemented default `2_500ms`;
- do not nest another long response-observation wait inside the same critical path without reviewing total timeout;
- if the bridge envelope exposes remaining time, cap observer timeout to `min(configuredTurnSettledTimeout, remainingBudget - safetyMargin)`;
- compute a static fallback cap when remaining time is unavailable:

  ```ts
  const telemetryBudgetMs = Math.min(
    configuredTurnSettledTimeoutMs,
    Math.max(1_000, envelope.timeoutMs - 12_000),
  );
  ```

- add a test where `waitForSettled()` times out and the command still returns accepted before the bridge timeout.

### Risk 12: Launch Fan-Out Becomes Serial Or Opens Duplicate Streams

Problem:

`runLaunch()` currently submits bootstrap prompts for all members first, then observes/reconciles with `mapWithConcurrency(promptedMembers, 3, ...)`. If launch uses the single-prompt wrapper and waits during the prompt loop, a 4-member OpenCode team can pay the observer timeout 4 times before all members even receive bootstrap. If it starts a second SSE observer in addition to `observePreview()`, launch does duplicate stream work.

Mitigation:

- launch v1 keeps current prompt submission path;
- launch v1 emits turn-settled from existing `observePreview()` summary in the concurrent settle phase;
- no second launch SSE stream unless live tests prove preview-derived signal is insufficient;
- tests assert prompt submission is not delayed by per-member observer timeout.

### Risk 13: Status Shape Drift

Problem:

OpenCode SDK types model `session.status.properties.status` as an object with `type`, while earlier/live event captures may expose a string. Code that only checks one shape can silently miss terminal idle.

Mitigation:

- centralize `getOpenCodeSessionStatusType(value)` in shared SSE helpers;
- support both string and object status;
- update `OpenCodePreviewObserver` and the new turn-settled observer to use the helper;
- tests cover both shapes.

### Risk 14: Composition Order Drops OpenCode Spool Env

Problem:

`createOpenCodeRuntimeAdapterRegistry()` currently runs before `memberWorkSyncFeature` is created. Since `OpenCodeBridgeCommandClient` captures env in its constructor, late wiring cannot fix the bridge env.

Mitigation:

- move `createMemberWorkSyncFeature(...)` earlier in `src/main/index.ts`, before OpenCode registry construction;
- keep effectful startup replay/scan and IPC registration in their current later positions;
- add a composition test or safe integration test proving `AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT` is present in the env passed to `OpenCodeBridgeCommandClient`;
- if reordering causes a cycle, extract a small public member-work-sync factory for runtime-turn-settled env creation rather than reaching into infrastructure directly.

### Risk 15: Observation Outlives Host Reference

Problem:

`OpenCodeSessionBridge.withSessionHost()` retains a host for callback duration and releases it in `finally`. Any API that returns an observation after `withSessionHost()` exits can leave the SSE stream attached to a host whose in-process ref was already released.

Mitigation:

- v1 delivery wrapper keeps observe, prompt, and `waitForSettled()` inside one `withSessionHost()` callback;
- launch v1 reuses `observePreview()`, so it does not introduce a second returned observation;
- if future split observer is needed, introduce explicit observed prompt scope ownership;
- tests assert delivery wrapper does not release host before observer settle/dispose.

### Risk 16: IPC/Data Contract Churn

Problem:

Adding `turnSettledOutcome` to bridge command data could force renderer/shared contract changes for a telemetry-only feature.

Mitigation:

- keep public command data shape stable in v1;
- surface observer outcome through existing `diagnostics`;
- only expand contract later if UI needs to display turn-settled telemetry directly.

### Risk 17: Premature Timeout Before Reconcile Proves Activity

Problem:

The SSE observer can time out because of stream delay, but the existing post-send reconcile can still see the assistant message, tool call, or cursor advance a few milliseconds later. If the observer writes the spool file directly, `member-work-sync` receives a false `timeout` even though the turn completed.

Mitigation:

- observer never writes spool files;
- observer returns evidence only;
- command handler runs the same reconcile/preview logic it already owns;
- coordinator emits exactly one final event after all local evidence has been collected;
- tests cover timeout evidence upgraded to success by reconcile and assert no duplicate timeout+success files.

### Risk 18: Cross-Repo Contract Drift

Problem:

The orchestrator writes `.opencode.json` payloads, while `claude_team` normalizes and resolves them. If the two repos drift, events can be silently quarantined or ignored.

Mitigation:

- keep payload minimal and versioned with `schemaVersion: 1`;
- add an orchestrator fixture event generated by `buildOpenCodeTurnSettledEvent(...)`;
- import that fixture into `claude_team` tests or duplicate it as a contract fixture with an explicit comment;
- test malformed provider/source/session/team/member cases;
- do not rely on TypeScript shared imports across repos for runtime compatibility.

### Risk 19: Optional Coordinator Missing

Problem:

If turn-settled env is not present or coordinator construction fails, OpenCode delivery must not fail.

Mitigation:

- default coordinator no-ops when spool env is missing;
- command handler treats missing `turnSettledCoordinator` as telemetry disabled;
- diagnostics can include `opencode_turn_settled_disabled`, but delivery acceptance remains unchanged;
- tests run send-message with `turnSettledCoordinator: undefined`.

### Risk 20: Prompt Request Race And Rejected Prompt Events

Problem:

`prompt_async` returns `204` after OpenCode accepts the prompt, but the runtime can start and finish a short turn while the HTTP request is still in flight. If observation only starts counting after the response, the app can miss the whole turn. If observation emits before the response, it can create a false turn-settled event for a rejected prompt.

Mitigation:

- start SSE before the request;
- call `markPromptSubmitting()` immediately before `submitPromptAsync()`;
- buffer same-session activity and idle seen during `submitting`;
- after `204`, call `markPromptAcceptedByEndpoint()` and promote buffered evidence;
- if the HTTP request throws, call `markPromptRejectedByEndpoint()`, dispose the observer, and emit no runtime turn-settled file;
- tests cover fast idle during in-flight submit, rejected prompt with buffered idle, and normal slow idle after accepted.

### Risk 21: `204 Prompt Accepted` Is Not Turn Success

Problem:

Current OpenCode `prompt_async` handler returns `204` after scheduling the prompt run. The actual prompt can still fail later and publish `session.error`. Treating `204` as success would hide model/provider/tool startup failures and make member-work-sync reconcile too optimistically.

Mitigation:

- name the lifecycle state `accepted_by_endpoint`, not just `accepted`;
- still observe `session.error` after `204`;
- derive final success only from response proof, reconcile cursor/message proof, or observer idle after post-submit activity with no error;
- tests cover `204 -> session.error -> session.status idle` returning final `error` unless response/reconcile proof upgrades it.

### Risk 22: SSE Has Heartbeats But No Replay

Problem:

Current OpenCode `/event` sends `server.connected` and `server.heartbeat`, but no SSE `id` for replay. If the stream connects late, reconnects, or closes before terminal idle, the observer cannot recover missed events from Last-Event-ID.

Mitigation:

- ignore `server.connected` and `server.heartbeat` as activity;
- do not implement reconnect replay in v1 because the server does not expose replay IDs;
- map premature stream EOF to `stream_unavailable` with diagnostic `stream_closed_before_terminal_event`;
- let coordinator upgrade stream failure from existing reconcile/response proof;
- tests cover heartbeat-only stream, stream EOF before idle, and stream failure upgraded by reconcile.

### Risk 23: `noReply` Prompts Are Not Agent Turns

Problem:

OpenCode `SessionPrompt.prompt()` returns after creating the user message when `noReply === true`; it does not enter the assistant loop that sets busy/idle. Observing such prompts would produce false timeouts or fake work-sync signals.

Mitigation:

- do not request OpenCode turn-settled observation when `noReply === true`;
- keep existing delivery/reconcile behavior for no-reply bookkeeping;
- do not write runtime-turn-settled spool files for no-reply prompts;
- tests cover `noReply` delivery with no observer, no coordinator emission, and stable command response.

### Risk 24: OpenCode Version Drift

Problem:

The plan references current OpenCode source and docs, but users can run different installed OpenCode versions. Event payload shapes can drift while still staying compatible at the HTTP level.

Mitigation:

- implement tolerant parsing for known string/object status variants and unknown event types;
- record OpenCode version, stream endpoint, and observed event type histogram in live test artifacts;
- avoid exact full-event snapshots in unit tests. Use targeted fixtures for session identity, status shape, error, heartbeat, and global payload wrapper;
- add a live smoke that dumps a compact compatibility report when `OPENCODE_TURN_SETTLED_LIVE=1`;
- if a future version drops `session.idle`, v1 still works through `session.status idle`.

### Risk 25: User Prompt Persistence Looks Like Assistant Work

Problem:

OpenCode emits `message.updated user` and user text part events when it stores the prompt. If the observer treats those as activity, a prompt that only persisted user input and then idled or errored could be reported as a successful assistant turn.

Mitigation:

- ignore `message.updated` where `info.role === 'user'`;
- ignore parts whose `messageID` equals the generated OpenCode prompt `messageID`;
- track assistant message IDs from `message.updated assistant`;
- count assistant parts only when their message ID is known assistant, or when the part type is assistant-only such as `tool`, `step-start`, `step-finish`, or `reasoning`;
- count `session.status busy` as turn-start activity, but keep final success gated by later idle and no `session.error`;
- tests cover user-only prompt events followed by idle returning `idle_without_assistant_activity`.

### 11.1 Highest-Risk Implementation Checks

These are the checks to do first during implementation, before expanding tests broadly:

1. **Command timeout budget.** Confirm the actual `OpenCodeBridgeCommandClient` timeout for `send-message` and `launch`. The sum of `waitUntilReady`, `waitForSettled`, response observation, and reconcile must stay below that budget with a safety margin. If not, cap the turn-settled wait dynamically.
2. **Host retention.** Add a test fake host manager that records retain/release order. The sequence must be `retain -> observe -> prompt -> waitForSettled -> dispose -> release`.
3. **Outcome derivation from real types.** Use actual `OpenCodeSessionPreviewSummary` and `OpenCodeSessionReconcileSummary` fields, not invented observer fields. Outcome helpers should be pure functions with fixture tests.
4. **Composition order.** Write a test or narrow integration seam proving OpenCode bridge env receives `AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT` before `OpenCodeBridgeCommandClient` construction.
5. **SSE schema drift.** Shared event helpers must parse `session.status` as string and object, and must unwrap `/global/event` payload events without trusting unrelated directories.
6. **Best-effort boundary.** Make emitter failure impossible to surface as delivery failure. The only accepted-prompt failure path should remain existing OpenCode delivery/reconcile logic.
7. **Prompt submit race.** Unit-test `submitting -> accepted` promotion and `submitting -> rejected` discard before wiring the observer into delivery. This is the highest-risk race in the design.
8. **No-reply bypass.** Confirm no-reply OpenCode prompts do not start the observer and do not emit runtime-turn-settled files.
9. **No replay assumption.** Treat SSE as best-effort current stream only. Reconcile remains the safety net for missed events.
10. **User prompt is not work.** Ensure `message.updated user` and prompt text parts do not satisfy `sawAssistantTurnActivity`.

---

## 12. Alternatives Considered

### Option 1: Bounded SSE Observer Per Prompt

`🎯 9   🛡️ 9   🧠 6`, roughly `850-1250 LOC`.

Pros:

- no OpenCode config mutation;
- exact prompt boundary;
- easy to test;
- works for launch and delivery;
- provider-specific logic stays in orchestrator.
- durable in the current short-lived bridge-command architecture because the command waits for a bounded outcome.
- preserves launch fan-out by reusing existing preview/reconcile settle lifecycle.
- avoids false timeout events by emitting only after observer + reconcile/preview evidence is merged.

Cons:

- one observer per prompt;
- needs careful timeout cleanup;
- can miss events if stream connection is delayed.
- adds bounded latency to OpenCode bridge command completion.

Decision: choose this.

### Option 2: Long-Lived Host-Level SSE Observer

`🎯 8   🛡️ 9   🧠 7`, roughly `650-1000 LOC`.

Pros:

- lower chance of missing fast events;
- one connection per host;
- can collect richer runtime diagnostics.

Cons:

- more lifecycle complexity;
- host lease cleanup risk;
- needs session-to-member registry updates;
- harder to prove no leaks.

Decision: defer. Consider if per-prompt observer misses events in live validation.

### Option 3: OpenCode Plugin `session.idle`

`🎯 6   🛡️ 6   🧠 5`, roughly `300-600 LOC`.

Pros:

- OpenCode officially documents `session.idle` plugin event;
- event is naturally emitted by OpenCode runtime.

Cons:

- requires plugin install/config mutation;
- risks user/project config conflict;
- harder to keep app-owned and reversible;
- less aligned with current OpenCode serve bridge.

Decision: reject for v1.

### Option 4: Poll `/session/status`

`🎯 6   🛡️ 7   🧠 3`, roughly `180-350 LOC`.

Pros:

- simple;
- no SSE parser.

Cons:

- less precise;
- more load;
- cannot distinguish error path as cleanly;
- slower reaction.

Decision: use only as fallback if SSE has real misses.

---

## 13. Test Plan

### 13.1 Orchestrator Unit Tests

Files:

```text
src/services/opencode/OpenCodeRuntimeTurnSettledEmitter.test.ts
src/services/opencode/OpenCodeTurnSettledObserver.test.ts
src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.test.ts
src/services/opencode/OpenCodeSessionBridge.test.ts
src/services/opencode/OpenCodeBridgeCommandHandler.test.ts
```

Cases:

- emitter writes atomic `.opencode.json` file when env is present;
- emitter no-ops when env missing;
- command handler accepts missing coordinator and preserves delivery behavior;
- observer returns success evidence on post-prompt `session.status idle`;
- observer handles `session.status` where status is `{ type: 'idle' }`;
- preview observer still handles status string and status object after helper extraction;
- observer returns success evidence on post-prompt `session.idle`;
- observer returns error evidence when `session.error` precedes idle;
- observer does not misattribute sessionless `session.error` to a foreign session;
- observer records sessionless `session.error` diagnostic;
- observer resolves only once when both idle events arrive;
- observer ignores foreign session events;
- observer ignores `/global/event` events from a foreign directory;
- observer ignores `server.connected` and `server.heartbeat` as session activity;
- observer ignores `message.updated user` and user text prompt parts as assistant-turn activity;
- observer tracks assistant message IDs and counts assistant parts for those messages;
- observer treats prompt message parts with `messageID === runtimePromptMessageId` as prompt persistence, not assistant-turn activity;
- observer times out and returns timeout evidence;
- stream unavailable returns `stream_unavailable` evidence;
- premature stream EOF before terminal idle returns `stream_unavailable` with diagnostic `stream_closed_before_terminal_event`;
- observer buffers same-session activity and idle during `submitting`;
- observer buffers same-session `session.error` during `submitting` and promotes it to terminal error after endpoint acceptance;
- `markPromptAcceptedByEndpoint()` promotes buffered in-flight evidence into success;
- `markPromptRejectedByEndpoint()` discards buffered evidence and no emitter call happens;
- prompt failure after buffered idle does not produce a runtime turn-settled file;
- `204 -> session.error -> session.status idle` returns error unless response/reconcile proof upgrades it;
- `session.error` without later idle still returns error, not timeout;
- user-only prompt persistence followed by idle returns `idle_without_assistant_activity`, not `success`;
- coordinator writes one event per delivery emission;
- coordinator upgrades observer timeout to success when reconcile cursor advanced;
- coordinator upgrades stream unavailable to success when response observation proves visible/tool reply;
- coordinator keeps observer error when reconcile/response evidence does not prove activity;
- coordinator does not write both timeout and success for one prompt;
- coordinator emits launch success from preview activity;
- coordinator emits launch success from reconcile cursor advance when preview missed activity;
- orchestrator contract fixture is accepted by `claude_team` OpenCode normalizer;
- `promptAsync()` remains unchanged and sends no `messageID`;
- `promptAsyncWithTurnSettled()` starts observer before `promptSessionAsync`;
- `promptAsyncWithTurnSettled()` calls `waitUntilReady()` before prompt;
- `promptAsyncWithTurnSettled()` calls `markPromptSubmitting()` immediately before `submitPromptAsync()`;
- `promptAsyncWithTurnSettled()` calls `markPromptAcceptedByEndpoint()` only after `promptSessionAsync` resolves;
- `promptAsyncWithTurnSettled()` calls `markPromptRejectedByEndpoint()` when `promptSessionAsync` rejects;
- `promptAsyncWithTurnSettled()` calls `waitForSettled()` after prompt and before command return;
- `promptAsyncWithTurnSettled()` disposes observer when prompt request fails;
- delivery wrapper keeps host retained until settle/dispose;
- delivery wrapper releases host after settle/dispose;
- bounded observer timeout returns accepted delivery with internal observer outcome `timeout`;
- `noReply: true` delivery does not start turn-settled observation and writes no OpenCode runtime-turn-settled file;
- launch path reuses existing preview observation and does not open a second SSE stream;
- launch with 4 members does not add `4 * turnSettledTimeoutMs` to prompt submission time;
- delivery prompt passes turnSettled context;
- no observer context preserves old request body shape.
- bridge command data shape remains stable and final coordinator outcome appears in diagnostics.

### 13.2 claude_team Unit Tests

Files:

```text
test/features/member-work-sync/main/infrastructure/OpenCodeTurnSettledPayloadNormalizer.test.ts
test/features/member-work-sync/main/adapters/output/TeamRuntimeTurnSettledTargetResolver.test.ts
test/features/member-work-sync/main/infrastructure/runtimeTurnSettledEnvironment.test.ts
test/features/member-work-sync/core/application/RuntimeTurnSettledIngestor.test.ts
```

Cases:

- OpenCode payload normalizes valid event;
- invalid JSON rejected;
- source mismatch rejected;
- missing session identity rejected;
- missing team/member rejected;
- error outcome preserved;
- resolver accepts active OpenCode member;
- resolver rejects non-OpenCode provider member;
- resolver rejects removed member;
- resolver rejects reserved member;
- env builder returns spool env for OpenCode;
- composition creates member-work-sync env provider before OpenCode bridge client captures env;
- file event store routes `.opencode.json` files to the OpenCode normalizer;
- ingestor enqueues OpenCode event once.
- orchestrator-generated contract fixture normalizes successfully.

### 13.3 Integration Tests

Add or update:

```text
test/features/member-work-sync/MemberWorkSyncRuntimeTurnSettled.opencode.test.ts
```

Scenario:

```text
given team with OpenCode member
and one actionable task
and a valid OpenCode turn-settled event file
when drainRuntimeTurnSettledEvents runs
then queue receives member-turn-settled
and member-work-sync status is recomputed
and no direct nudge is sent outside the existing outbox/dispatcher path
```

### 13.4 Live E2E Prototype Test

Add opt-in test:

```text
src/services/opencode/OpenCodeTurnSettledObserver.live-e2e.test.ts
```

Gate:

```text
OPENCODE_E2E=1
OPENCODE_TURN_SETTLED_LIVE=1
```

Default models:

```text
opencode/gpt-5-nano
opencode/minimax-m2.5-free
```

If OpenAI model is used:

```text
openai/gpt-5.4-mini-fast
```

Assertions:

- server starts and cleans up;
- session is created;
- SSE stream connects;
- `prompt_async` accepted;
- observer returns terminal evidence before bridge command exits;
- coordinator writes one event after final evidence is derived;
- event has provider `opencode`;
- event has outcome `success` or `error`;
- error outcome includes diagnostic;
- all spawned `opencode serve` processes are killed by test cleanup.

Live test must use a short prompt:

```text
Reply with exactly OK.
```

No model matrix in this patch.

### 13.5 Verification Commands

In orchestrator worktree:

```bash
cd /Users/belief/dev/projects/claude/_worktrees/agent_teams_orchestrator_opencode_turn_settled
bun test src/services/opencode/OpenCodeRuntimeTurnSettledEmitter.test.ts src/services/opencode/OpenCodeTurnSettledObserver.test.ts src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.test.ts src/services/opencode/OpenCodeSessionBridge.test.ts src/services/opencode/OpenCodeBridgeCommandHandler.test.ts
bun run build:dev
git diff --check
```

In `claude_team` worktree:

```bash
cd /Users/belief/dev/projects/claude/_worktrees/claude_team_member_work_sync_opencode
pnpm vitest run test/features/member-work-sync
pnpm typecheck --pretty false
git diff --check
```

Opt-in live:

```bash
cd /Users/belief/dev/projects/claude/_worktrees/agent_teams_orchestrator_opencode_turn_settled
OPENCODE_E2E=1 OPENCODE_TURN_SETTLED_LIVE=1 bun test src/services/opencode/OpenCodeTurnSettledObserver.live-e2e.test.ts
```

---

## 14. Implementation Sequence

### Cut 1: claude_team Contract Support

`🎯 9   🛡️ 9   🧠 4`, roughly `180-300 LOC`.

Steps:

1. Extend provider union with `opencode`.
2. Add provider-neutral `RuntimeTurnSettledSpoolInitializer`.
3. Extend runtime env builder.
4. Extend file store provider parsing for `.opencode.json`.
5. Add OpenCode normalizer.
6. Extend resolver through shared explicit-provider helper.
7. Add contract fixture test using the orchestrator payload shape.
8. Add tests.
9. Commit:

```text
feat(member-work-sync): accept opencode turn-settled events
```

### Cut 2: Orchestrator Emitter And Observer

`🎯 9   🛡️ 8   🧠 5`, roughly `320-520 LOC`.

Steps:

1. Add OpenCode emitter.
2. Add OpenCode SSE observer.
3. Add OpenCode turn-settled emission coordinator.
4. Extract or duplicate SSE helpers safely.
5. Add generated contract fixture for `claude_team` normalizer tests.
6. Add observer/coordinator unit tests.
7. Add live e2e gate.
8. Commit:

```text
feat(opencode): emit runtime turn-settled events
```

### Cut 3: Prompt Path Integration

`🎯 8   🛡️ 9   🧠 5`, roughly `240-420 LOC`.

Steps:

1. Keep `OpenCodeSessionBridge.promptAsync()` unchanged.
2. Add `promptAsyncWithTurnSettled()` as the delivery convenience wrapper.
3. Add coordinator usage to send-message after post-send reconcile/response observation.
4. Add coordinator usage to launch after existing preview + reconcile settle phase.
5. Keep launch prompt submission unchanged and avoid a second launch SSE stream.
6. Ensure failure path disposes observer.
7. Ensure observer wait is bounded and returns timeout evidence without failing accepted delivery.
8. Add regression tests for prompt request bodies, bounded wait behavior, and launch no-duplicate-stream behavior.
9. Commit:

```text
feat(opencode): observe launch and delivery turn settlement
```

### Cut 4: App Launch Env Wiring

`🎯 8   🛡️ 9   🧠 5`, roughly `120-240 LOC`.

Steps:

1. Move `createMemberWorkSyncFeature(...)` before `createOpenCodeRuntimeAdapterRegistry()` call, without moving startup replay/scan side effects.
2. Register runtime turn-settled providers before OpenCode registry construction.
3. Wire env in `src/main/index.ts` before `OpenCodeBridgeCommandClient` construction.
4. Merge `memberWorkSyncFeature.buildRuntimeTurnSettledEnvironment({ provider: 'opencode' })`.
5. Add integration or safe e2e test proving env reaches bridge command constructor.
6. Commit:

```text
feat(member-work-sync): pass opencode turn-settled spool env
```

### Cut 5: Full Verification

`🎯 9   🛡️ 9   🧠 3`, roughly test-only cleanup.

Steps:

1. Run targeted suites in both repos.
2. Run one OpenCode live e2e with cheap model.
3. Confirm no stray `opencode serve` process from tests.
4. Confirm no untracked temp artifacts.
5. Commit test fixture or doc updates if needed.

---

## 15. Definition Of Done

The implementation is done when:

- `claude_team` accepts OpenCode runtime turn-settled spool events.
- OpenCode bridge process receives `AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT`.
- `promptAsync()` remains backward-compatible.
- Observed OpenCode delivery paths use `promptAsyncWithTurnSettled()`.
- Observed OpenCode launch paths derive final outcome from existing `observePreview()` + reconcile summaries without opening a second SSE stream.
- Observed OpenCode delivery paths start an observer before `prompt_async`.
- Observed OpenCode delivery paths wait a bounded telemetry budget before command return.
- `session.error` before idle produces `outcome: 'error'`.
- observer does not write spool files directly.
- coordinator emits one spool event after final local evidence is collected.
- observer timeout can be upgraded to success by response/reconcile proof.
- duplicate idle events produce one final spool event.
- missing spool env never breaks OpenCode delivery.
- `.opencode.json` spool files are accepted by the file event store.
- removed or non-OpenCode member events are rejected by resolver.
- `member-work-sync` reconciles from OpenCode event without direct frontend changes.
- tests pass in both repos.
- one opt-in live test proves actual `opencode serve` emits the expected lifecycle.

---

## 16. Open Questions

No blocker questions before implementation.

Non-blocking decisions:

- Whether to extract SSE helpers from `OpenCodePreviewObserver` immediately or duplicate in v1. Preferred: extract if tests remain small.
- Whether to pass explicit `messageID` on all observed prompts. Preferred: yes, only when `turnSettled` context is present.
- Whether to add polling fallback in v1. Preferred: no, add only if live e2e shows missed idle events.
- Whether to use a long-lived host-level observer later. Preferred: no for v1 because current bridge process lifecycle is command-scoped; revisit only if bounded per-prompt observer misses events in live tests.

---

## 17. Final Recommendation

Implement Option 1 in the cuts above.

This gives OpenCode the same architectural role as Claude Stop hook and Codex native turn-settled:

```text
provider-specific runtime signal
-> durable spool
-> provider normalizer
-> active team/member resolver
-> MemberWorkSync reconciler
```

It is more robust than a plain "ping after idle" loop and less invasive than OpenCode plugin hooks. It also keeps `member-work-sync` scalable for future providers.
