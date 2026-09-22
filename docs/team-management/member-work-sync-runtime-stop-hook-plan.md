# Member Work Sync Runtime Stop Hook Plan

**Status:** implemented for provider-neutral spool/drain, Claude Stop hook settings, and Codex/OpenCode turn-settled adapters
**Scope:** `member-work-sync`, Claude runtime hook integration, Codex/OpenCode runtime turn-settled adapters
**Primary repo:** `claude_team`
**Secondary dependency:** `agent_teams_orchestrator` runtime hook payload contract
**Feature name:** `member-work-sync`
**Recommended cut:** provider-neutral turn-settled control plane with Claude Stop hook adapter first

---

## 1. Summary

Add a provider-neutral runtime turn-settled signal for `member-work-sync`.

The goal is not to ping agents directly from a hook. The hook only records that a runtime turn ended. The app then performs the same level-triggered reconcile that `member-work-sync` already owns:

```text
runtime Stop hook
-> durable raw event spool
-> app-side drain and provider normalization
-> team/member resolver
-> MemberWorkSyncEventQueue
-> MemberWorkSyncReconciler
-> optional durable nudge outbox, if policy allows
```

Recommended approach:

**Provider-neutral Stop hook event pipeline, Claude adapter first**
`🎯 9   🛡️ 9   🧠 6`, roughly `650-1000 LOC`.

Why this is the safest direction:

- `Stop` is a useful "turn settled" signal, but not proof that work is complete.
- `TeammateIdle` is not used as the base because it is Claude/team-specific and does not generalize to Codex/OpenCode turn-settled adapters.
- Hook execution must be fast, non-blocking, and fail-open.
- The existing `member-work-sync` agenda fingerprint, lease, cooldown, busy signal, and watchdog separation remain authoritative.
- Codex/OpenCode use provider adapters that emit the same normalized event contract.

Architecture checkpoint:

- No blocker question is required before implementation. The safest defaults are clear.
- Codex/OpenCode production wiring is fail-open: missing runtime turn-settled env disables telemetry for that provider process, but does not fail team launch or prompt delivery.
- The implementation should be done as an extension of `member-work-sync`, not as ad hoc logic inside `TeamProvisioningService`.
- The hook pipeline is an input signal. It must not become a second watchdog, a second delivery ledger, or a runtime liveness detector.

Implementation summary:

```text
Launch path asks member-work-sync for provider settings patch
-> settings patch appends one Stop hook command
-> Stop hook writes raw provider payload to spool
-> app drainer normalizes payload
-> resolver proves active team/member
-> router enqueues turn_settled reconcile
-> existing reconciler/outbox policy decides whether to do nothing or nudge
```

Architecture answer:

- The durable Stop hook ingestion belongs in `claude_team`, not in `agent_teams_orchestrator`, because `member-work-sync` agenda, leases, nudge outbox, cooldowns, and watchdog separation are app-owned policy.
- The orchestrator should only remain a runtime launcher/bridge. It can help with `--settings` materialization, but it should not decide member agenda sync.
- Frontend changes are not needed in v1. This is a control-plane signal, not a new UI workflow.
- The only cross-repo risk is `--settings` merge behavior. If `claude_team` can guarantee a single already-merged inline settings object, no orchestrator change is required. If multiple app-owned inline `--settings` values can still cross the boundary, the orchestrator merge helper must become hook-aware too.

---

## 2. Key Design Decisions

### 2.1 Use `Stop` Only As A Wake-Up Signal

The Stop hook must not:

- decide whether the agent is done;
- write tasks or comments;
- send inbox nudges directly;
- call the app HTTP API;
- block the runtime with `decision: "block"`;
- inject more prompt context.

The Stop hook only writes raw event payload to durable storage and exits `0`.

This keeps the model turn lifecycle independent from app policy. It also prevents expensive or looping "keep working" prompts from hook code.

### 2.2 Do Not Mutate Project `.claude/settings.local.json`

Do not install this hook by editing a user's project-local Claude settings.

Reasons:

- Project settings may already contain user hooks.
- Invalid JSON in project settings should not become our problem.
- Worktrees would each need careful mutation and cleanup.
- A team launch should not permanently alter a customer repo.
- Future Codex support needs a provider adapter, not a Claude-only project settings hack.

Preferred installation is a managed `--settings` fragment added at launch time.

### 2.3 Hook Command Must Be Generic

Do not bake `teamName`, `memberName`, or `runId` into the settings hook command.

Reason: Claude teammate subprocesses inherit `--settings` from the parent. A hook setting created for the lead can run inside a teammate process. A hook setting created for one teammate can also be copied through restart paths. Identity must therefore be resolved after the event is recorded.

Allowed identity hints:

- process environment values, if present;
- hook payload `session_id`;
- hook payload `transcript_path`;
- hook payload `cwd`;
- runtime launch state and log source attribution.

Hints are never accepted as final truth until validated against active team/member state.

### 2.4 Use A POSIX Shell Writer, Not Node

The hook command should invoke a tiny app-owned POSIX shell script:

```text
/bin/sh "<app-data>/member-work-sync/hooks/bin/turn-settled-hook-v1.sh" "<spool-dir>" "claude"
```

Why shell is better than Node here:

- No dependency on `node` being available in the user's shell PATH.
- No dependency on Electron internals from an external hook process.
- Very small failure surface.
- Works for Claude now and can be reused for Codex later.

The shell script should not parse JSON. It writes raw stdin to an atomic event file. The app process parses and validates later.

### 2.5 Spool Files Instead Of Shared JSONL Append

Use one atomic file per hook event, not one append-only JSONL file.

Reason: many agents can stop at nearly the same time. Atomic file writes avoid append interleaving, file lock contention, and partial JSONL line corruption.

Recommended layout:

```text
<teamsBase>/.member-work-sync/runtime-hooks/
  bin/
    turn-settled-hook-v1.sh
  incoming/
    20260429T120102Z-12345-a1b2c3.json
  processing/
  processed/
  invalid/
```

The hook script writes a hidden temp file under `incoming/`, then `mv`s it to a final `.json` filename.

### 2.6 Drain In The App Process

The Electron main process owns:

- reading incoming hook files;
- parsing raw payloads;
- normalizing provider-specific payloads;
- resolving team/member;
- emitting `member-turn-settled` events to `member-work-sync`.

The hook process must stay dumb.

### 2.7 No New Feature Flag For Claude Stop Hook

Do not add a user-facing feature flag for the Claude Stop hook in v1.

Reason:

- The hook is fail-open and only enqueues an existing `member-work-sync` reconcile.
- It does not directly send nudges.
- Existing leases, fingerprints, cooldowns, and watchdog separation still decide behavior.
- A flag would add another state combination without reducing the main risk, which is attribution correctness.

If emergency disable behavior is needed later, patch the narrow hook composition wiring directly rather than adding a permanent config/env flag or branching inside the core policy.

---

## 3. Alternatives Considered

### Option 1: Provider-Neutral Stop Hook Spool

`🎯 9   🛡️ 9   🧠 6`, roughly `650-1000 LOC`.

Add provider-neutral infrastructure now. Implement Claude adapter first. Add Codex adapter later by plugging into the same raw-event contract.

Pros:

- clean provider boundary;
- minimal model interruption;
- no user settings mutation;
- safe under high agent count;
- aligns with existing `member-work-sync` control plane.

Cons:

- more code than direct hook-to-HTTP;
- requires resolver tests for session and transcript attribution.

Decision: choose this.

### Option 2: Claude-Only Stop Hook Directly Enqueues Member

`🎯 7   🛡️ 7   🧠 4`, roughly `350-600 LOC`.

Install a Claude Stop hook that writes `{ teamName, memberName }` directly and bypasses provider-neutral normalization.

Pros:

- faster to build;
- simpler tests.

Cons:

- hard to extend to Codex;
- unsafe if `--settings` is inherited across processes;
- more likely to misattribute lead vs teammate;
- encourages Claude-specific logic inside the feature.

Decision: reject.

### Option 3: Gastown-Style Blocking Stop Hook

`🎯 5   🛡️ 5   🧠 6`, roughly `400-750 LOC`.

Return `decision: "block"` from the Stop hook when the app thinks there is work.

Pros:

- can force an immediate continuation.

Cons:

- risks loops;
- risks repeated acknowledgement-only turns;
- increases token usage;
- bypasses durable outbox and cooldown policy;
- conflicts with watchdog and `member-work-sync` separation.

Decision: reject for this app.

### Option 4: Use `TeammateIdle`

`🎯 6   🛡️ 7   🧠 4`, roughly `250-450 LOC`.

Use Claude Code's team-specific `TeammateIdle` event.

Pros:

- gives direct `team_name` and `teammate_name` for Claude teammates;
- simpler resolver.

Cons:

- not provider-neutral;
- not available for Codex;
- does not cover lead/non-team sessions;
- makes future runtime support harder.

Decision: do not use as v1 base.

---

## 3.1 External Pattern Takeaways

From the prior Gastown/GoClaw comparison and production control-plane patterns:

- Keep Gastown's strongest idea: use provider Stop hooks as a low-latency wake-up signal.
- Do not copy Gastown's blocking Stop hook behavior. It is too easy to create loops and token burn in this product.
- Keep GoClaw-style simplicity only at adapter boundaries. The app still needs durable state because team membership, worktrees, task boards, and provider runtimes are richer here.
- Use Kubernetes-style level-triggered reconciliation: the event only says "recheck now", the app recomputes current work state.
- Use SQS/BullMQ-style lease semantics already present in `member-work-sync`: a report/lease is temporary and tied to current agenda fingerprint.
- Use GitHub Actions-style concurrency key behavior: one in-flight reconcile/nudge per `team/member/fingerprint`, not one per hook event.

This means the architecture should be better suited to this app than a direct Gastown copy: provider hooks are adapters, durable reconciliation remains in the feature core, and watchdog stays a separate slow semantic layer.

---

## 4. Clean Architecture Shape

The feature remains under:

```text
src/features/member-work-sync/
```

New code should follow `docs/FEATURE_ARCHITECTURE_STANDARD.md`.

### 4.0 Current Code Integration Map

The implementation should touch these current seams:

```text
src/features/member-work-sync/
  contracts/
    types.ts                                  # add runtime turn-settled diagnostics DTOs only if UI/API needs them
  core/
    domain/
      RuntimeTurnSettledEvent.ts              # normalized event value objects
      RuntimeTurnSettledProvider.ts           # 'claude' | 'codex'
    application/
      RuntimeTurnSettledIngestor.ts           # drain, normalize, resolve, enqueue
      runtimeTurnSettledPorts.ts              # narrow ports
      ports.ts                                # re-export or colocate new ports
  main/
    adapters/
      input/
        MemberWorkSyncTeamChangeRouter.ts     # route member-turn-settled
        RuntimeTurnSettledMemberQueue.ts      # small queue adapter, if keeping router thin
      output/
        TeamRuntimeTurnSettledTargetResolver.ts
    composition/
      createMemberWorkSyncFeature.ts          # wire installer/store/normalizers/scheduler/ingestor
    infrastructure/
      RuntimeTurnSettledSpoolPaths.ts
      ShellRuntimeTurnSettledHookScriptInstaller.ts
      FileRuntimeTurnSettledEventStore.ts
      RuntimeTurnSettledDrainScheduler.ts
      ClaudeStopHookPayloadNormalizer.ts
      CodexStopHookPayloadNormalizer.ts        # tests only first
      runtimeTurnSettledHookSettings.ts        # settings patch builder and hook-aware merge
```

Launch integration should be intentionally small:

```text
src/main/services/team/TeamProvisioningService.ts
  # call public member-work-sync main helper/facade to get a settings patch
  # pass patch into provider args/settings merge
  # do not import member-work-sync infrastructure internals

src/main/services/runtime/cliSettingsArgs.ts
  # replace or extend current generic --settings JSON merge so hooks arrays are additive
```

Shared event type touch:

```text
src/shared/types/team.ts
  # add TeamChangeEvent type 'member-turn-settled'

src/features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue.ts
  # add trigger reason 'turn_settled'
```

Tests should live with the feature:

```text
test/features/member-work-sync/main/
  RuntimeTurnSettledHookSettings.test.ts
  RuntimeTurnSettledSpool.test.ts
  RuntimeTurnSettledIngestor.test.ts
  RuntimeTurnSettledTargetResolver.test.ts
  createMemberWorkSyncFeature.test.ts
```

Do not add runtime Stop hook code to:

- renderer components;
- `TeamTaskStallMonitor`;
- OpenCode delivery ledger;
- task log stream services;
- direct IPC handlers outside the feature facade.

Those layers can observe outcomes later, but they should not own ingestion or policy. This keeps SRP clean: runtime hook ingestion is an input adapter, `member-work-sync` is policy, watchdog is semantic stall policy, and runtime adapters only launch processes.

### 4.1 Core Domain

`core/domain` remains provider-agnostic.

Possible additions:

```text
core/domain/RuntimeTurnSettledEvent.ts
core/domain/RuntimeTurnSettledProvider.ts
```

Domain responsibilities:

- define normalized event value objects;
- validate basic invariants;
- no filesystem;
- no Electron;
- no Claude/Codex CLI details.

Example:

```ts
export type RuntimeTurnSettledProvider = 'claude' | 'codex';

export interface RuntimeTurnSettledEvent {
  schemaVersion: 1;
  provider: RuntimeTurnSettledProvider;
  hookEventName: 'Stop';
  sourceId: string;
  payloadHash: string;
  recordedAt: string;
  sessionId?: string;
  turnId?: string;
  transcriptPath?: string;
  cwd?: string;
  hints?: {
    teamName?: string;
    memberName?: string;
    runId?: string;
  };
}
```

`sourceId` should be deterministic for storage/debugging but not trusted for dedupe alone:

```ts
export function buildRuntimeTurnSettledSourceId(input: {
  provider: RuntimeTurnSettledProvider;
  sessionId?: string;
  turnId?: string;
  payloadHash: string;
}): string {
  return [
    'runtime-turn-settled',
    input.provider,
    input.sessionId || 'no-session',
    input.turnId || 'no-turn',
    input.payloadHash,
  ].join(':');
}
```

Domain invariants:

- `provider` is known.
- `hookEventName` is `Stop`.
- `payloadHash` is non-empty.
- `recordedAt` is valid ISO or normalized by infrastructure before domain construction.
- `sourceId` contains no filesystem path and no message text.

### 4.2 Core Application

`core/application` owns use cases and ports.

Possible additions:

```text
core/application/RuntimeTurnSettledIngestor.ts
core/application/RuntimeTurnSettledResolver.ts
core/application/runtimeTurnSettledPorts.ts
```

Ports:

```ts
export interface RuntimeTurnSettledEventStorePort {
  claimPending(limit: number): Promise<RuntimeTurnSettledClaim[]>;
  markProcessed(input: { id: string; resolved: boolean; reason?: string }): Promise<void>;
  markInvalid(input: { id: string; reason: string }): Promise<void>;
  release(input: { id: string; reason: string }): Promise<void>;
}

export interface RuntimeTurnSettledNormalizerPort {
  provider: RuntimeTurnSettledProvider;
  normalize(raw: RuntimeTurnSettledRawPayload): RuntimeTurnSettledEvent | null;
}

export interface RuntimeTurnSettledTargetResolverPort {
  resolve(event: RuntimeTurnSettledEvent): Promise<
    | { ok: true; teamName: string; memberName: string; runId?: string }
    | { ok: false; reason: string }
  >;
}

export interface RuntimeTurnSettledQueuePort {
  enqueue(input: {
    teamName: string;
    memberName: string;
    triggerReason: 'turn_settled';
    runAfterMs?: number;
  }): void;
}
```

The use case:

```ts
export class RuntimeTurnSettledIngestor {
  constructor(private readonly deps: RuntimeTurnSettledIngestorDeps) {}

  async drain(): Promise<RuntimeTurnSettledDrainSummary> {
    const claims = await this.deps.store.claimPending(this.deps.batchSize);
    const summary = createEmptyDrainSummary();

    for (const claim of claims) {
      try {
        const normalizer = this.deps.normalizers.get(claim.provider);
        if (!normalizer) {
          await this.deps.store.markInvalid({
            id: claim.id,
            reason: 'unsupported_provider',
          });
          summary.invalid += 1;
          continue;
        }

        const normalized = normalizer.normalize(claim.raw);
        if (!normalized) {
          await this.deps.store.markInvalid({
            id: claim.id,
            reason: 'invalid_payload',
          });
          summary.invalid += 1;
          continue;
        }

        const target = await this.deps.targetResolver.resolve(normalized);
        if (!target.ok) {
          await this.deps.store.markProcessed({
            id: claim.id,
            resolved: false,
            reason: target.reason,
          });
          summary.unresolved += 1;
          continue;
        }

        this.deps.queue.enqueue({
          teamName: target.teamName,
          memberName: target.memberName,
          triggerReason: 'turn_settled',
          runAfterMs: this.deps.turnSettledDelayMs,
        });
        await this.deps.store.markProcessed({ id: claim.id, resolved: true });
        summary.enqueued += 1;
      } catch (error) {
        await this.deps.store.release({
          id: claim.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        summary.released += 1;
      }
    }

    return summary;
  }
}
```

The use case depends only on ports. It should not import `fs`, `path`, Electron, `TeamProvisioningService`, or concrete stores.

### 4.3 Main Infrastructure

`main/infrastructure` owns technical details.

Possible additions:

```text
main/infrastructure/RuntimeTurnSettledSpoolPaths.ts
main/infrastructure/ShellRuntimeTurnSettledHookScriptInstaller.ts
main/infrastructure/FileRuntimeTurnSettledEventStore.ts
main/infrastructure/RuntimeTurnSettledDrainScheduler.ts
main/infrastructure/ClaudeStopHookPayloadNormalizer.ts
main/infrastructure/CodexStopHookPayloadNormalizer.ts
```

Responsibilities:

- write shell hook script;
- manage spool directories;
- claim event files with atomic rename to `processing/`;
- parse JSON with bounded size;
- move invalid files to `invalid/`;
- delete or archive processed files with bounded retention;
- schedule drain with bounded concurrency and `unref()` timers.

### 4.4 Main Adapters

Input adapter:

```text
main/adapters/input/RuntimeTurnSettledMemberWorkSyncAdapter.ts
```

It translates resolved runtime turn events into `MemberWorkSyncEventQueue.enqueue`.

Output adapters:

```text
main/adapters/output/TeamRuntimeTurnSettledTargetResolver.ts
```

It resolves team/member through existing team stores and runtime metadata.

### 4.5 Composition

`createMemberWorkSyncFeature()` wires:

- spool paths;
- hook script installer;
- event store;
- provider normalizers;
- target resolver;
- drain scheduler;
- ingestor.

Facade additions:

```ts
export interface MemberWorkSyncFeatureFacade {
  buildRuntimeTurnSettledHookSettings(input: {
    provider: RuntimeTurnSettledProvider;
  }): Promise<Record<string, unknown> | null>;

  drainRuntimeTurnSettledEvents(): Promise<RuntimeTurnSettledDrainSummary>;
}
```

Launch code should call only the facade or a public helper from `@features/member-work-sync/main`. It should not deep-import infrastructure.

---

## 5. Hook Installation Details

### 5.1 Managed Settings Fragment

For Claude:

```ts
const settingsPatch = {
  hooks: {
    Stop: [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: buildTurnSettledHookCommand({
              scriptPath,
              spoolPath,
              provider: 'claude',
            }),
          },
        ],
      },
    ],
  },
};
```

The command must be deterministic and idempotent.

### 5.2 Hook Marker And Deduplication

Claude hook settings do not have a formal `id` field in the command schema. Deduplication should use a stable command marker:

```text
# agent-teams:member-work-sync-turn-settled:v1
```

Example command:

```sh
/bin/sh '/.../turn-settled-hook-v1.sh' '/.../runtime-hooks' 'claude' # agent-teams:member-work-sync-turn-settled:v1
```

Settings merge should:

- preserve existing user hooks;
- append our hook only if marker is absent;
- not reorder unrelated hooks;
- not duplicate our hook across repeated launch/restart.

### 5.3 Settings Merge Must Be Hook-Aware

Current generic deep merge replaces arrays. That is unsafe for `hooks.Stop`.

Add a hook-aware merge helper. It can live in `src/main/services/runtime/cliSettingsArgs.ts` if it must merge all launch `--settings`, or in `src/features/member-work-sync/main/infrastructure/runtimeTurnSettledHookSettings.ts` if the launch path only needs to build a single already-merged fragment. Prefer a shared runtime helper if multiple launch fragments already use `--settings`.

```ts
type JsonObject = Record<string, unknown>;

const MEMBER_WORK_SYNC_HOOK_MARKER = 'agent-teams:member-work-sync-turn-settled:v1';

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeHooksConfig(target: unknown, source: unknown): unknown {
  if (!isJsonObject(target) && !isJsonObject(source)) {
    return source;
  }

  const merged: JsonObject = isJsonObject(target) ? { ...target } : {};
  if (!isJsonObject(source)) {
    return merged;
  }

  for (const [eventName, sourceEntries] of Object.entries(source)) {
    if (!Array.isArray(sourceEntries)) {
      merged[eventName] = sourceEntries;
      continue;
    }

    const currentEntries = Array.isArray(merged[eventName])
      ? [...(merged[eventName] as unknown[])]
      : [];
    for (const entry of sourceEntries) {
      if (isMemberWorkSyncHookEntry(entry)) {
        const alreadyPresent = currentEntries.some(isMemberWorkSyncHookEntry);
        if (alreadyPresent) {
          continue;
        }
      }
      currentEntries.push(entry);
    }
    merged[eventName] = currentEntries;
  }

  return merged;
}

function isMemberWorkSyncHookEntry(entry: unknown): boolean {
  if (!isJsonObject(entry) || !Array.isArray(entry.hooks)) {
    return false;
  }

  return entry.hooks.some((hook) => {
    if (!isJsonObject(hook) || typeof hook.command !== 'string') {
      return false;
    }
    return hook.command.includes(MEMBER_WORK_SYNC_HOOK_MARKER);
  });
}

export function mergeRuntimeSettingsFragments(fragments: JsonObject[]): JsonObject {
  let merged: JsonObject = {};
  for (const fragment of fragments) {
    merged = mergeRuntimeSettingsObject(merged, fragment);
  }
  return merged;
}

function mergeRuntimeSettingsObject(target: JsonObject, source: JsonObject): JsonObject {
  const output: JsonObject = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (key === 'hooks') {
      output.hooks = mergeHooksConfig(output.hooks, value);
      continue;
    }

    const current = output[key];
    if (isJsonObject(current) && isJsonObject(value)) {
      output[key] = mergeRuntimeSettingsObject(current, value);
      continue;
    }

    output[key] = value;
  }
  return output;
}
```

Test cases:

- fastMode settings + Stop hook settings both survive;
- two Stop hook fragments dedupe our marker;
- user Stop hook and our Stop hook both survive;
- non-hook arrays keep existing generic replace behavior unless explicitly supported.
- malformed `hooks.Stop` from another fragment is not "fixed" silently. Preserve it if it is a non-array value and let Claude validation handle it.
- if any `--settings` value is a file path, do not try to parse or rewrite it in `claude_team`; preserve existing behavior and append our own inline settings fragment separately.

Important implementation note:

The current `mergeJsonObjectCliFlagValues()` in `agent_teams_orchestrator` also deep-merges `--settings` values. If multiple inline JSON settings are passed to Claude, arrays can still be overwritten there. Either:

- upstream the same hook-aware merge into `agent_teams_orchestrator/src/utils/cliArgs.ts`, or
- ensure `claude_team` passes exactly one already-merged inline JSON settings fragment.

Recommended v1: pass exactly one already-merged inline JSON settings fragment from `claude_team` for app-owned settings, and add an orchestrator test proving `fastMode + hooks.Stop` survive eager settings load.

### 5.4 Do Not Fail Team Launch If Hook Install Fails

If hook script installation or settings patch generation fails:

- log a warning;
- continue launch without Stop hook;
- `member-work-sync` still works from startup scans, task events, inbox events, tool activity, and watchdog.

Reason: Stop hook is an optimization signal, not a hard runtime dependency.

### 5.5 Launch Integration Shape

Launch code should ask the feature for an optional settings patch and merge it with existing app-owned Claude settings before args are finalized.

Sketch:

```ts
const appSettingsFragments: JsonObject[] = [];

const fastModeSettings = buildAnthropicFastModeSettings(...);
if (fastModeSettings) {
  appSettingsFragments.push(fastModeSettings);
}

const turnSettledHookSettings =
  await memberWorkSyncFeature.buildRuntimeTurnSettledHookSettings({
    provider: 'claude',
  }).catch((error) => {
    logger.warn('member-work-sync Stop hook unavailable', { error });
    return null;
  });

if (turnSettledHookSettings) {
  appSettingsFragments.push(turnSettledHookSettings);
}

const appSettings = mergeRuntimeSettingsFragments(appSettingsFragments);
args = mergeJsonSettingsArgs(args, JSON.stringify(appSettings));
```

Rules:

- existing user-supplied config/settings stays user-owned and is not rewritten;
- app-owned settings should be merged before crossing process boundaries;
- hook settings generation failure logs warning only;
- tests must prove no duplicate hook command after restart/relaunch.

---

## 6. Hook Writer Script

### 6.1 Requirements

The shell script must:

- use `/bin/sh`;
- accept `spoolRoot` and `provider`;
- create `incoming/`;
- read stdin to a temp file with size bounded by shell-independent outer command where possible;
- atomically rename temp to final `.json`;
- add no stdout;
- keep stderr quiet unless debugging is explicitly enabled;
- exit `0` even when it cannot write.

### 6.2 Example Script Shape

```sh
#!/bin/sh
set +e

spool_root="$1"
provider="$2"
max_bytes="${3:-262144}"

if [ -z "$spool_root" ] || [ -z "$provider" ]; then
  exit 0
fi

case "$provider" in
  claude|codex) ;;
  *) exit 0 ;;
esac

incoming="$spool_root/incoming"
mkdir -p "$incoming" 2>/dev/null || exit 0

stamp="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo unknown-time)"
tmp="$(mktemp "$incoming/.turn-settled.XXXXXX" 2>/dev/null)" || exit 0
suffix="$(basename "$tmp" | sed 's/^\\.turn-settled\\.//')"
final="$incoming/$stamp-$$-$suffix.$provider.json"

# Use dd to bound the file even if a provider accidentally sends a huge payload.
# dd is POSIX. If it fails, fall back to fail-open cleanup.
dd bs="$max_bytes" count=1 of="$tmp" 2>/dev/null || {
  rm -f "$tmp" 2>/dev/null
  exit 0
}

# Empty payloads are not useful. They are dropped here to reduce invalid spool noise.
if [ ! -s "$tmp" ]; then
  rm -f "$tmp" 2>/dev/null
  exit 0
fi

mv "$tmp" "$final" 2>/dev/null || {
  rm -f "$tmp" 2>/dev/null
  exit 0
}

exit 0
```

The file content is raw provider hook payload. The provider is also encoded in the filename. The drainer validates both.

### 6.3 Payload Size Guard

Claude Stop payload can include `last_assistant_message`. To avoid huge files:

- the shell writer limits stdin to `256KB` by default;
- app-side reader still refuses files over the same fixed limit;
- oversized payloads are treated as invalid, never as resolved events.

For v1, app-side read limit is mandatory.

### 6.4 Hook Command Quoting

Build the hook command with shell-safe single-quote escaping:

```ts
const HOOK_MARKER = 'agent-teams:member-work-sync-turn-settled:v1';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildTurnSettledHookCommand(input: {
  scriptPath: string;
  spoolRoot: string;
  provider: RuntimeTurnSettledProvider;
  maxBytes?: number;
}): string {
  return [
    '/bin/sh',
    shellQuote(input.scriptPath),
    shellQuote(input.spoolRoot),
    shellQuote(input.provider),
    shellQuote(String(input.maxBytes ?? 262_144)),
    '#',
    HOOK_MARKER,
  ].join(' ');
}
```

Rules:

- never interpolate unquoted paths;
- never include team/member identity in the command;
- never include secrets or auth paths;
- keep the marker at the end so it is easy to detect without parsing shell syntax.

---

## 7. Event Store And Drain Semantics

### 7.1 Claiming Files

`FileRuntimeTurnSettledEventStore.claimPending(limit)`:

1. list `incoming/*.json`;
2. sort by filename for deterministic order;
3. for each file, atomic rename to `processing/<same-name>`;
4. if rename fails, skip because another process may have claimed it;
5. return claims with file path and provider inferred from extension.

Code sketch:

```ts
export class FileRuntimeTurnSettledEventStore implements RuntimeTurnSettledEventStorePort {
  constructor(private readonly deps: {
    paths: RuntimeTurnSettledSpoolPaths;
    maxBytes: number;
    clock: MemberWorkSyncClockPort;
  }) {}

  async claimPending(limit: number): Promise<RuntimeTurnSettledClaim[]> {
    await this.recoverStaleProcessingFiles();
    const incoming = this.deps.paths.incomingDir();
    const processing = this.deps.paths.processingDir();
    await fs.promises.mkdir(processing, { recursive: true });

    const names = (await fs.promises.readdir(incoming).catch(() => []))
      .filter((name) => providerFromFileName(name) !== null)
      .sort()
      .slice(0, Math.max(0, limit));

    const claims: RuntimeTurnSettledClaim[] = [];
    for (const name of names) {
      const sourcePath = path.join(incoming, name);
      const claimedPath = path.join(processing, name);
      const provider = providerFromFileName(name);
      if (!provider) {
        continue;
      }
      try {
        await fs.promises.rename(sourcePath, claimedPath);
      } catch {
        continue;
      }

      let stat: Awaited<ReturnType<typeof fs.promises.stat>>;
      try {
        stat = await fs.promises.stat(claimedPath);
      } catch (error) {
        claims.push({
          id: name,
          provider,
          raw: null,
          claimedPath,
          transientError: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (stat.size > this.deps.maxBytes) {
        claims.push({
          id: name,
          provider,
          raw: null,
          claimedPath,
          invalidReason: 'payload_too_large',
        });
        continue;
      }

      let raw: string;
      try {
        raw = await fs.promises.readFile(claimedPath, 'utf8');
      } catch (error) {
        claims.push({
          id: name,
          provider,
          raw: null,
          claimedPath,
          transientError: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      claims.push({
        id: name,
        provider,
        raw,
        claimedPath,
      });
    }
    return claims;
  }
}
```

`claimPending()` should not throw for one bad file. Bad files become claims with `invalidReason`, so the ingestor can quarantine them and continue. Transient read/stat errors become claims with `transientError`, so the ingestor can release them back for retry.

File name validation is part of the store, not the normalizer:

```ts
const EVENT_FILE_PATTERN =
  /^\d{8}T\d{6}Z-\d+-[A-Za-z0-9._-]+\.(claude|codex)\.json$/;

function providerFromFileName(name: string): RuntimeTurnSettledProvider | null {
  const match = EVENT_FILE_PATTERN.exec(name);
  if (!match) {
    return null;
  }
  return match[1] as RuntimeTurnSettledProvider;
}
```

Rules:

- ignore hidden temp files;
- reject names with path separators;
- reject unknown provider suffixes;
- never derive any target identity from the filename.

### 7.2 Processing Outcome

For each claim:

- processed and resolved: move to `processed/` or delete after metrics are recorded;
- parsed but unresolved: move to `processed/` with unresolved metric, not `invalid`;
- invalid JSON or too large: move to `invalid/`;
- transient read error: release back to `incoming/` or leave in `processing/` with recovery scan.

Important distinction:

```text
invalid = payload cannot be trusted or parsed
unresolved = payload is valid, but no active team/member target was proven
```

Unresolved events are not errors. They are expected when a lead or non-team Claude session stops.

### 7.3 Recovery From Crashes

On app startup:

- move stale `processing/` files older than e.g. `5 minutes` back to `incoming/`;
- then drain normally.

This prevents losing events if the app crashes mid-drain.

Recovery should run before every scheduled drain as well, not only at startup. This handles app crashes and abrupt process kills without requiring a full app restart.

Recovery should use file age, not process liveness. The app can crash while a process that wrote the file is still alive, and checking arbitrary PIDs here would couple the store to runtime process management.

### 7.4 Retention

Keep processed/invalid files only for a short developer/debug window:

- processed: max `1000` files or `24h`;
- invalid: max `100` files or `72h`.

These are not user-facing logs.

### 7.5 Drain Scheduler

The drain scheduler should be lightweight and bounded:

```ts
export class RuntimeTurnSettledDrainScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref?.();
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.ingestor.drain();
    } finally {
      this.running = false;
    }
  }
}
```

Rules:

- one drain at a time;
- bounded batch size, recommended `50`;
- `unref()` timer;
- no UI dependency;
- `dispose()` stops timer and waits for current drain;
- scheduler errors are logged once per tick and never crash the app;
- if one drain finds a full batch, schedule an immediate follow-up tick to clear backlog without waiting the full interval.

---

## 8. Provider Normalizers

### 8.1 Claude Stop Normalizer

Input fields expected from Claude hook payload:

- `hook_event_name`;
- `session_id`;
- `transcript_path`;
- `cwd`;
- possibly `turn_id`;
- possibly `last_assistant_message`.

Rules:

- accept only `hook_event_name === "Stop"`;
- do not persist full `last_assistant_message`;
- compute `payloadHash` from raw payload;
- trim and normalize paths but do not require them to exist at normalization time;
- produce `RuntimeTurnSettledEvent`.

Implementation sketch:

```ts
export class ClaudeStopHookPayloadNormalizer implements RuntimeTurnSettledNormalizerPort {
  readonly provider = 'claude' as const;

  normalize(raw: RuntimeTurnSettledRawPayload): RuntimeTurnSettledEvent | null {
    if (raw.provider !== 'claude' || typeof raw.text !== 'string') {
      return null;
    }

    const parsed = parseJsonObject(raw.text);
    if (!parsed || parsed.hook_event_name !== 'Stop') {
      return null;
    }

    const payloadHash = sha256(raw.text);
    const sessionId = readOptionalString(parsed.session_id);
    const turnId = readOptionalString(parsed.turn_id);

    return {
      schemaVersion: 1,
      provider: 'claude',
      hookEventName: 'Stop',
      sourceId: buildRuntimeTurnSettledSourceId({
        provider: 'claude',
        sessionId,
        turnId,
        payloadHash,
      }),
      payloadHash,
      recordedAt: raw.recordedAt,
      sessionId,
      turnId,
      transcriptPath: normalizeOptionalPath(parsed.transcript_path),
      cwd: normalizeOptionalPath(parsed.cwd),
    };
  }
}
```

`parseJsonObject()` must reject arrays and primitives. Do not pass raw parsed provider payload outside the normalizer.

Normalizer tests should cover:

- valid Stop payload returns normalized event;
- non-Stop event returns `null`;
- malformed JSON returns `null`;
- `last_assistant_message` is not copied;
- missing `session_id` is allowed but resolver may later ignore the event;
- huge payload never reaches normalizer because the store quarantines it first.

### 8.2 Codex Stop Normalizer, Future

Codex support should be added by implementing the same interface:

```ts
class CodexStopHookPayloadNormalizer implements RuntimeTurnSettledNormalizerPort {
  provider = 'codex' as const;
  normalize(raw: RuntimeTurnSettledRawPayload): RuntimeTurnSettledEvent | null {
    // Codex payload mapping
  }
}
```

Do not add Codex launch behavior until there is a contract test with a captured or synthetic Codex Stop payload.

---

## 9. Target Resolution

`TeamRuntimeTurnSettledTargetResolver` should resolve conservatively.

Resolution order:

1. Runtime launch state by `sessionId`.
2. Transcript path attribution.
3. Validated explicit hints, if event contains them.
4. CWD/team metadata match, only if it maps to exactly one active team/member.

Session and transcript evidence should beat hints because hints can be inherited through `--settings`.

If resolution is ambiguous:

- do not enqueue;
- record metric `unresolved_ambiguous_target`;
- leave debug diagnostics.

If team is stopped/offline:

- do not enqueue;
- record metric `ignored_inactive_team`.

If member is removed/inactive:

- do not enqueue;
- record metric `ignored_inactive_member`.

Implementation sketch:

```ts
export class TeamRuntimeTurnSettledTargetResolver
  implements RuntimeTurnSettledTargetResolverPort {
  constructor(private readonly deps: {
    teamReader: TeamConfigReaderPort;
    launchStateReader: RuntimeLaunchStateReaderPort;
    transcriptAttribution: RuntimeTranscriptAttributionPort;
    teamStatusReader: TeamStatusReaderPort;
  }) {}

  async resolve(event: RuntimeTurnSettledEvent): Promise<RuntimeTurnSettledTargetResult> {
    const candidates = compact([
      await this.fromSessionId(event),
      await this.fromTranscriptPath(event),
      await this.fromValidatedHints(event),
      await this.fromUniqueCwd(event),
    ]);

    const active = [];
    for (const candidate of candidates) {
      const verified = await this.verifyCandidate(event, candidate);
      if (verified.ok) {
        active.push(verified.target);
      }
    }

    const unique = uniqueTargets(active);
    if (unique.length === 1) {
      return { ok: true, ...unique[0] };
    }
    if (unique.length > 1) {
      return { ok: false, reason: 'unresolved_ambiguous_target' };
    }
    return { ok: false, reason: 'unresolved_no_target' };
  }
}
```

`verifyCandidate()` must check:

- team exists and is not stopped/cancelled;
- member exists in current config or members-meta;
- member is active, not removed;
- provider matches `claude` for Claude Stop events;
- if `sessionId` exists, it belongs to the same member or is absent from known runtime state;
- if `transcriptPath` exists, it is under the expected team/member transcript root or matches known attribution.

Never enqueue based only on `cwd` when more than one team can match the same project path. Worktrees and restarted teams make CWD ambiguous.

### 9.1 Explicit Hints Are Not Trusted Alone

If a hook event includes hints:

```ts
{
  hints: {
    teamName: 'atlas',
    memberName: 'bob'
  }
}
```

The resolver must still verify:

- team exists;
- member exists in config/meta;
- member is active;
- event session/transcript is compatible if those fields are present.

### 9.2 Lead Sessions

Lead sessions may emit Stop events too.

Policy:

- Ignore lead Stop for member-specific work sync in v1, because task/inbox events already cover most team-wide changes.
- Do not fan out a lead Stop to all active members unless a later phase explicitly adds a separate team-level policy with its own anti-spam tests.

Recommended v1 default: ignore unresolved lead events.

If a lead event is strongly resolved as lead, record `ignored_lead_turn_settled` and do not enqueue all members in v1. Team-wide task/inbox changes already trigger member sync, and fan-out from lead Stop could create noisy false positives.

### 9.3 OpenCode Sessions

This plan is not for OpenCode. OpenCode runtime already has separate delivery/watchdog mechanisms.

Do not infer OpenCode member work sync from Claude Stop events.

---

## 10. Member Work Sync Integration

Add trigger reason:

```ts
export type MemberWorkSyncTriggerReason =
  | ...
  | 'turn_settled';
```

Add event type:

```ts
export interface TeamChangeEvent {
  type:
    | ...
    | 'member-turn-settled';
  teamName: string;
  runId?: string;
  detail?: string;
  taskId?: string;
}
```

Current `TeamChangeEvent.detail` is a string used broadly across preload, renderer store, and log/task panels. Do not change it to `unknown` in this cut. Encode a small JSON detail string and validate it at the router boundary:

```ts
export interface MemberTurnSettledTeamChangeDetail {
  memberName: string;
  provider: 'claude' | 'codex';
  sourceId: string;
}

function serializeMemberTurnSettledDetail(
  detail: MemberTurnSettledTeamChangeDetail
): string {
  return JSON.stringify(detail);
}
```

Router behavior:

```ts
if (event.type === 'member-turn-settled') {
  const detail = parseMemberTurnSettledDetail(event.detail);
  if (!detail) {
    return;
  }

  queue.enqueue({
    teamName: event.teamName,
    memberName: detail.memberName,
    triggerReason: 'turn_settled',
    runAfterMs: 15_000,
  });
  return;
}
```

Parsing detail explicitly avoids fragile string conventions and gives future Codex/Claude diagnostics without changing the queue contract again. `sourceId` is intentionally not added to the queue item in v1, because queue coalescing is keyed by `team/member`. Keep `sourceId` in drain/router debug logs only.

`parseMemberTurnSettledDetail()` should reject missing JSON, non-object JSON, empty `memberName`, and unknown provider values. Invalid detail is ignored, not routed as team-wide.

Why `15_000` instead of immediate:

- allows logs/task writes from the just-finished turn to land;
- coalesces repeated hook events;
- avoids racing with task/comment writes emitted near turn end.

The existing queue still applies normal quiet/coalescing behavior.

---

## 11. Watchdog Interaction

Stop hook events must not conflict with `TeamTaskStallMonitor`.

Rules:

- Stop hook event is a fast consistency trigger.
- It does not count as progress proof.
- It does not suppress watchdog by itself.
- If `member-work-sync` sends a nudge, the existing watchdog cooldown adapter can suppress near-duplicate task-stall nudges.
- If watchdog sends a nudge first, `member-work-sync` dispatcher must see that cooldown and avoid duplicate member sync pings.

This keeps responsibilities separate:

```text
member-work-sync: does the member know the current actionable agenda?
watchdog: has meaningful task progress stalled for too long?
delivery ledger: did a specific message reach a runtime?
runtime liveness: is a process/session alive?
```

Required anti-spam contract:

- A `turn_settled` enqueue may cause at most one `member-work-sync` reconciliation for `(teamName, memberName)` after coalescing.
- It must not create a nudge if the agenda fingerprint is already caught up or covered by a valid lease/report.
- If a watchdog nudge was recently sent for the same member/task, `member-work-sync` must respect the existing cooldown adapter.
- If `member-work-sync` sends a nudge first, watchdog must see the same cooldown signal through the already-existing `TeamTaskStallJournalWorkSyncCooldown`.
- Stop hook events do not reset leases and do not extend leases. Only explicit report/tool/task state can do that.

---

## 12. Security And Reliability

### 12.1 No Network In Hook

The hook must not call local HTTP control endpoints. Reasons:

- app may be down;
- hook could hang;
- local ports can change;
- network calls increase Stop latency.

File spool is safer.

### 12.2 No Secrets In Spool

Do not persist:

- API keys;
- full env;
- full assistant messages;
- user prompt content beyond what Claude already puts in raw Stop payload.

If raw payload includes `last_assistant_message`, the app normalizer should not copy it into normalized event. Optionally hash it for dedupe.

### 12.3 Bounded IO

Every read/list operation must be bounded:

- max event file size;
- max files per drain tick;
- bounded retention cleanup;
- no recursive scanning outside known spool dirs.

### 12.4 Fail Open

If hook settings cannot be installed, launch continues.

If hook command cannot write, it exits `0`.

If event cannot resolve, no nudge is sent.

---

## 13. Implementation Phases

Commit order should follow dependency direction. Each commit must leave tests for touched layer green.

```text
commit 1: domain ports + hook settings merge + script installer
commit 2: file spool store + normalizers + ingestor
commit 3: target resolver + router integration
commit 4: launch integration + composition wiring
commit 5: docs/test hardening and optional Codex contract adapter
```

Do not wire launch integration before `RuntimeTurnSettledHookSettings.test.ts` and store/ingestor tests exist. Otherwise a bad hook command could silently ship into every launched Claude teammate.

### Phase 0: Preflight And Existing-Code Assertions

`🎯 10   🛡️ 9   🧠 2`, roughly `40-90 LOC`.

Tasks:

- add characterization tests for current `mergeJsonSettingsArgs` or equivalent `--settings` helper;
- add characterization test that `createMemberWorkSyncFeature()` exposes stable startup/dispose lifecycle;
- add a small fixture for a Claude Stop payload with `session_id`, `transcript_path`, and `cwd`;
- confirm no renderer import path is needed.

Why this phase exists: it locks current behavior before adding hook-aware merge and prevents accidental breakage of existing Claude fast mode settings.

### Phase 1: Hook Settings And Spool Foundation

`🎯 9   🛡️ 9   🧠 5`, roughly `300-450 LOC`.

Tasks:

- add `RuntimeTurnSettledSpoolPaths`;
- add shell hook script installer;
- add hook-aware settings merge helper;
- add Claude Stop settings patch builder;
- wire launch path to include patch through public member-work-sync main helper/facade;
- keep failure non-fatal.
- if the orchestrator can still receive multiple inline app-owned settings fragments, add the same hook-aware merge test/fix there before wiring production launch.

Tests:

- script installer writes executable content;
- settings merge preserves existing user hooks;
- settings merge dedupes our hook marker;
- fastMode settings and hook settings both survive.

### Phase 2: Drainer And Resolver

`🎯 9   🛡️ 9   🧠 6`, roughly `350-600 LOC`.

Tasks:

- add file event store;
- add Claude payload normalizer;
- add target resolver;
- add drain scheduler;
- add startup recovery for stale processing files;
- emit `member-turn-settled` only for resolved active member.
- add structured drain summary for diagnostics but do not expose it to UI yet.

Tests:

- concurrent file claims are safe;
- malformed and oversized payloads are quarantined;
- unresolved events do not enqueue;
- sessionId and transcriptPath resolution works;
- stopped team and removed member are ignored.

### Phase 3: Member Work Sync Router Integration

`🎯 10   🛡️ 9   🧠 3`, roughly `100-180 LOC`.

Tasks:

- add `turn_settled` trigger reason;
- add `member-turn-settled` event type;
- route to one member with a short delay;
- include trigger reason in diagnostics.
- verify watchdog cooldown path is unchanged.

Tests:

- router enqueues only target member;
- missing detail is ignored;
- coalescing works with existing queue.

### Phase 4: Codex Contract-Ready Adapter, No Production Launch Yet

`🎯 7   🛡️ 8   🧠 5`, roughly `150-300 LOC`.

Tasks:

- add `CodexStopHookPayloadNormalizer` behind tests only;
- add synthetic captured-payload tests;
- do not install Codex Stop hook in production until runtime launch and config format are verified.

Tests:

- Codex payload maps into same normalized event;
- unsupported event names are ignored;
- missing identity fields stay unresolved.

---

## 14. Testing Plan

### Unit

```bash
pnpm vitest run \
  test/features/member-work-sync/main/RuntimeTurnSettledHookSettings.test.ts \
  test/features/member-work-sync/main/RuntimeTurnSettledSpool.test.ts \
  test/features/member-work-sync/main/RuntimeTurnSettledIngestor.test.ts \
  test/features/member-work-sync/main/RuntimeTurnSettledTargetResolver.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncTeamChangeRouter.test.ts
```

### Existing Regression

```bash
pnpm vitest run \
  test/features/member-work-sync/core/MemberWorkSyncUseCases.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncEventQueue.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncNudgeDispatchScheduler.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncToolActivityBusySignal.test.ts
```

### Broader Regression

```bash
pnpm typecheck --pretty false
git diff --check
```

### Optional Live Claude Hook Probe

Only if token/cost is acceptable:

```bash
CLAUDE_TEAM_LIVE_HOOK_PROBE=1 pnpm vitest run test/features/member-work-sync/live/ClaudeStopHook.live.test.ts
```

The live probe should:

- create temp settings with only our Stop hook;
- launch a minimal Claude runtime turn;
- verify one spool event;
- not assert any model behavior.

Do not run this in normal CI.

---

## 15. Edge Cases

### 15.1 App Closed While Agent Stops

Hook still writes event file. On next app startup, drainer processes it if still relevant. If team/member is no longer active, event is ignored.

### 15.2 Many Agents Stop Together

Each hook writes a separate file. Drainer claims a bounded batch. Queue coalesces by team/member.

### 15.3 Hook Script Missing After App Update

Launch calls installer before creating settings patch. If script path changes, new settings patch uses new path. Old running agents may keep old hook command. If old script is gone, hook exits fail-open or shell fails. No runtime break.

Recommended improvement: keep versioned scripts for at least one app session after update.

### 15.4 `--settings` Inheritance

Inherited settings are expected. The hook is generic. Resolver validates identity post-fact.

### 15.5 User Has Their Own Stop Hook

Hook-aware merge appends our hook and preserves the user's hook. If the user hook fails or blocks, that is outside our control, but our hook should be independent.

### 15.6 Invalid User Project Settings

Because we do not mutate project settings, invalid project `.claude/settings.local.json` does not affect hook installation beyond normal Claude settings loading behavior.

### 15.7 Duplicate Events

Dedupe can use:

- provider;
- sessionId;
- turnId if present;
- payloadHash;
- recordedAt bucket.

Even without perfect dedupe, queue coalescing and outbox one-per-fingerprint prevent duplicate nudges.

### 15.8 Runtime Payload Has No Session ID

Resolver may use transcript path. If both are missing, event is unresolved and ignored.

### 15.9 Codex Payload Differs From Claude

Codex normalizer is separate. It must not force Claude assumptions into the core event model.

---

## 16. Open Questions

No blocker questions for v1.

Non-blocking decisions with recommended defaults:

1. Processed event retention
   Recommended: keep `24h` or `1000` files.
   `🎯 9   🛡️ 9   🧠 2`, roughly `20-40 LOC`.
   This gives enough debugging signal without making hook files a growing log store.

2. Turn-settled queue delay
   Recommended: `15s`.
   `🎯 8   🛡️ 9   🧠 1`, roughly `5-15 LOC`.
   Short enough to feel responsive, long enough for task/comment writes from the just-finished turn to appear.

3. Max event file size
   Recommended: `256KB`.
   `🎯 8   🛡️ 9   🧠 1`, roughly `10-20 LOC`.
   Claude Stop payloads should be small for our use case. Large payloads likely contain message text we do not need.

4. Lead Stop events
   Recommended: ignore in v1.
   `🎯 8   🛡️ 9   🧠 2`, roughly `10-30 LOC`.
   Fan-out from lead Stop is the highest-noise path and current task/inbox events already cover team-wide changes.

5. Codex production hook installation
   Recommended: not in v1.
   `🎯 7   🛡️ 8   🧠 5`, roughly `150-300 LOC` later.
   Keep the adapter seam and tests, but do not install until Codex hook payload and config semantics are proven.

The only question worth escalating before implementation is this:

```text
Should processed hook payload files be retained for 24h for debugging, or deleted immediately after metrics?
```

Default if no answer: retain short-term with bounded cleanup.

---

## 17. Acceptance Criteria

Implementation is accepted when:

- Claude launches include exactly one managed member-work-sync Stop hook.
- Existing user `hooks.Stop` entries are preserved.
- Existing app inline settings such as fast mode are preserved.
- Hook command writes raw payload files atomically.
- App drains payloads without blocking launch or UI.
- Resolved Claude Stop event enqueues one `turn_settled` reconcile for the correct active member.
- Unresolved, inactive, oversized, and malformed events never send nudges.
- Existing watchdog tests remain green.
- Codex support can be added by implementing provider adapter only, without rewriting core or Claude adapter.
- `member-work-sync` does not nudge if current agenda fingerprint is already caught up or covered by valid lease/report.
- A Stop hook event alone is not counted as task progress.
- Stopped teams, removed members, stale run ids, unresolved lead events, and ambiguous CWD matches are ignored.
- No renderer code is required for v1.
- No user project settings file is mutated.
