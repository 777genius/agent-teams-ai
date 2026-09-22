# Codex Native Runtime - Phase 0 Implementation Spec

Status:

- working spec, implementation-backed
- intended companion to [codex-native-runtime-integration-decision.md](codex-native-runtime-integration-decision.md)
- scope: minimal safe spike, not broad rollout
- audited against current code and a live local `codex exec` run on 2026-04-19
- safe to continue coding against
- not ready to unlock `codex-native` for normal runtime selection yet

## Purpose

This document turns the Codex-native decision doc into an execution spec for Phase 0.

Phase 0 is not the full migration.

Its only job is to prove that we can add a feature-flagged `codex-native` lane without:

- breaking current transcript consumers
- lying about status/capabilities in UI
- silently changing launch, replay, or approval semantics

If Phase 0 succeeds, we should know whether the first implementation wave can proceed as a minimal safe swap.

## Current Readiness Verdict

The spec itself is now ready to drive implementation.

Phase 0 implementation is now wired and evidence-backed.

Current state:

- ✅ ready and already implemented:
  - `codex-native` backend vocabulary in `agent_teams_orchestrator`
  - `codex-native` backend vocabulary in `claude_team` config and validation
  - backend-aware Codex connection-routing in `claude_team`
  - lane-aware Codex status/copy in `claude_team`
  - raw `codex exec` arg builder
  - raw JSONL-to-normalized-event mapper
  - real process-owned `codex exec` runner
  - transcript-compatible projector
  - persisted history wiring through the native lane
  - native executable identity, credential source, and completion metadata capture
  - parser coverage for native projected assistant rows
  - parser coverage for modern system warning rows
  - conservative selector lock policy
  - targeted tests for the above slices
- ⚠️ partially implemented:
  - `codex-native` runtime status can now represent the lane honestly, and the execution lane is real, but the lane remains intentionally locked and non-selectable
  - native lane credentials are routed honestly end-to-end, but the lane still exposes only a conservative headless-limited capability profile
  - the lane remains intentionally conservative in UI exposure and unlock policy even though transcript authority is now stronger
- ✅ sign-off evidence package is now captured in
  [codex-native-runtime-phase-0-signoff-evidence.md](./codex-native-runtime-phase-0-signoff-evidence.md)

Practical meaning:

- the Phase 0 contract is now strong enough to keep implementing against
- the product is still protected from false rollout because `codex-native` remains a locked experimental lane

## Spec Maintenance Rule

This document is allowed to evolve only in two ways:

1. to reflect implementation-backed reality more accurately
2. to tighten gates when a new risk is discovered

It must not drift into a second speculative architecture document.

Required maintenance behavior:

- if a Phase 0 PR changes authority order, capability truth, lock policy, or exit criteria, this spec must be updated in the same PR
- if a Phase 0 PR only adds implementation under an already-frozen contract, this spec should update only its status/checklist sections
- if current code and this spec disagree, either the code is wrong, or the spec is stale - do not leave the disagreement implicit
- if the implementation-status snapshot changes materially, update the `Implementation Status As Of ...` date in the same PR

## Phase 0 Source Of Truth Rule

For Phase 0 implementation work:

- this document is the execution contract
- [codex-native-runtime-integration-decision.md](codex-native-runtime-integration-decision.md) remains the broader strategy and risk document

If the two documents appear to disagree on a Phase 0 implementation detail:

- this spec wins until both documents are reconciled

Reason:

- the decision doc is intentionally broader
- this spec is intentionally narrower and implementation-facing

## Implementation Status As Of 2026-04-19

### Foundation already landed

- `agent_teams_orchestrator` now knows `codex-native` as a first-class backend id
- `agent_teams_orchestrator` status and registry surfaces can describe the lane without auto-resolving into it
- `claude_team` config vocabulary, validation, connection routing, and runtime UI copy are lane-aware
- old Codex auth mode no longer silently chooses the runtime lane
- raw exec Phase 0 modules already exist for:
  - arg building
  - JSONL mapping
  - normalized event shape
- the live orchestrator execution path now has:
  - a real `codex exec` runner
  - transcript-compatible projection
  - persisted history writes
  - executable identity and completion metadata capture
- native projected transcript rows now carry:
  - thread-status authority
  - warning-source attribution
  - execution-summary and history-completeness metadata
- targeted tests now exist for resolver, registry, config validation, connection routing, lane-aware UI, exec arg building, JSONL mapping, transcript projection, thread-status authority, turn execution, JSONL parsing, exact-log parsing, and session parsing

### Foundation intentionally still locked

- `codex-native` is not selectable for normal users
- `auto` never resolves to `codex-native`
- targeted client guard still rejects live interactive execution on the lane
- renderer/status surfaces may show the lane diagnostically, but not as a fully usable runtime

### Remaining Phase 0 blockers

- no code blockers remain inside Phase 0
- lane unlock remains intentionally blocked by rollout policy

### Phase 0 readiness verdict

- ✅ implementation-complete
- ✅ sign-off evidence captured
- ✅ raw-exec execution slice is landed
- ✅ ready to treat the spec as the contract for remaining work
- ✅ ready to declare Phase 0 complete
- ⚠️ still not ready to unlock `codex-native` as a selectable runtime lane

## Observed Current Codex Exec Facts

The following are no longer assumptions. They were observed locally on 2026-04-19 with:

- `codex-cli 0.117.0`
- `codex exec --json --ephemeral --skip-git-repo-check -C /tmp 'Reply only with OK'`

Observed event shape:

- `thread.started`
- `turn.started`
- `item.completed`
- `turn.completed`

Observed successful assistant payload:

- `item.completed.item.type = "agent_message"`
- `item.completed.item.text = "OK"`

Observed usage payload:

- `turn.completed.usage.input_tokens`
- `turn.completed.usage.cached_input_tokens`
- `turn.completed.usage.output_tokens`

Observed seam-critical warning:

- `thread/read failed while backfilling turn items for turn completion`
- `ephemeral threads do not support includeTurns`
- non-JSON warning lines may be interleaved with JSONL and must stay source-attributed

Observed practical implication:

- `--ephemeral` gives useful live events
- `--ephemeral` does not give final completion backfill via `thread/read`
- this confirms the Phase 0 rule that live stream and canonical history are different authorities

## Current Implemented Routing Facts

These are current implementation-backed truths, not future intentions:

- `codex-native` is a distinct backend lane, not a rename of old Codex `api` or `adapter`
- `auto` does not resolve to `codex-native`
- `codex-native` requires its own native-lane readiness path
- the native credential surface is `CODEX_API_KEY`, not implicit old-lane readiness
- `claude_team` now keeps auth routing and backend-lane routing separate
- when the selected backend is `codex-native`, app-side credential bridging may populate `CODEX_API_KEY`
- manual early routing into live `codex-native` execution is still protected by a targeted runtime guard
- once a real native runner exists, native-lane truth must also carry executable identity, not only backend id

Practical rule:

- if later code or copy contradicts any item above, it should be treated as regression unless the Phase 0 contract is intentionally amended

## Scope

In scope:

- one experimental `codex-native` backend lane
- one chosen execution seam for the spike
- normalized runtime events for the spike lane
- transcript-compatible projection for the spike lane
- explicit authority order for:
  - history
  - status
  - warnings
  - launch intent versus native thread defaults
  - credential routing
- feature-flagged runtime exposure only
- explicit unsupported-state treatment for headless-limited interactions

Out of scope:

- making `codex-native` the default
- broad plugin UX rollout
- detached review parity
- full app-server integration
- changing `claude_team` transcript parser format
- removing the old Codex `adapter/api` lane

## Phase 0 Deliverable

Phase 0 is complete only if all of the following are true:

- `agent_teams_orchestrator` can run one real Codex-native session through a feature-flagged lane
- the spike emits normalized events
- normalized events can be projected into transcript-compatible persisted history
- current `claude_team` transcript readers still parse the output without schema rewrite
- runtime status can represent the lane honestly as selected, resolved, degraded, or unavailable
- UI copy does not overclaim:
  - plugin support
  - approval support
  - interactive prompt support
  - current-session plugin activation
  - thread health from process health

## Phase 0 Exit Checklist

Use this as the stop/go gate before declaring Phase 0 done.

| Gate | Current state | Requirement to pass |
| --- | --- | --- |
| `codex-native` backend truth exists in both repos | ✅ done | keep green |
| lane remains additive and non-default | ✅ done | keep green |
| lane remains locked until execution is real | ✅ done | keep green |
| old Codex `api/adapter` lane remains behaviorally unchanged | ✅ targeted regression coverage green | required |
| old Codex lane remains the safe fallback when native lane is absent, locked, or degraded | ✅ targeted regression coverage green | required |
| real `codex exec` process run is wired into orchestrator | ✅ done | keep green |
| executable identity is captured per run | ✅ done | keep green |
| runner records executable source and completion policy | ✅ done | keep green |
| normalized native events flow from live process output | ✅ done | keep green |
| native lane capability profile remains explicit and conservative | ✅ done | keep green |
| transcript-compatible projection is written to persisted history | ✅ done | keep green |
| current parser and exact-log paths still parse the projection | ✅ parser and exact-log proof green | keep green |
| native thread-status authority exists or degrades honestly | ✅ projected thread-status rows and targeted tests green | keep green |
| warning sources remain separated end-to-end | ✅ warning-source attribution survives projected transcript rows | keep green |
| replay and history fixtures exist for `ephemeral` and non-ephemeral runs | ✅ targeted replay/history fixtures green | keep green |
| UI copy stays lane-aware and capability-honest | ✅ targeted UI/runtime tests green | keep green |

## Completion Versus Unlock Policy

Phase 0 completion and lane unlock are related, but they are not the same event.

Phase 0 completion means:

- one real `codex-native` execution path works end-to-end
- transcript, status, warning, and history truth stay honest
- internal fixtures prove the chosen seam well enough to proceed

Phase 0 completion does **not** mean:

- `codex-native` becomes default
- `auto` may resolve to `codex-native`
- the lane is generally available without a feature flag
- the lane suddenly gains plugin, MCP, approval, or app-server-grade interactive claims

Default post-Phase-0 policy:

- keep `codex-native` feature-flagged
- keep capability truth conservative
- unlock only for explicit internal usage first
- treat broader rollout as a later decision after Phase 1 gates, not as an automatic consequence of finishing Phase 0

## Old Codex Lane Regression Guardrail

Phase 0 is not allowed to “succeed” by quietly making the existing Codex lane worse.

Required rule:

- all `codex-native` work remains additive until a later explicit migration decision

That means:

- old Codex `api/adapter` execution remains routable
- old Codex connection/auth behavior remains valid for the old lane
- `auto` keeps today’s old-lane behavior
- status, settings, and selector surfaces keep showing a truthful fallback path when native lane is absent, locked, or degraded
- a failed or unavailable `codex-native` lane must not make the whole Codex provider story look unavailable if the old lane still works

Not allowed:

- reinterpreting old-lane readiness as native-lane readiness
- changing old-lane defaults only because the new lane exists
- breaking old-lane tests while claiming the work is “only for native”

## Chosen Phase 0 Default

Phase 0 default:

- execution seam: raw `codex exec` wrapper first
- lane shape: headless-limited until proven otherwise
- old Codex lane remains intact and is the fallback
- `codex-native` is additive, behind feature flag

Reason:

- raw exec exposes session ownership and `--ephemeral` tradeoffs more honestly than the current TypeScript SDK wrapper
- it reduces the chance of hiding critical persistence or capability differences under a convenience API too early

## Execution Seam Freeze Rule

Phase 0 currently chooses one seam:

- raw `codex exec` wrapper first

That choice is now frozen for the remainder of Phase 0 unless explicitly amended.

Practical rule:

- do not quietly switch the live implementation to current TypeScript SDK mid-Phase-0 while keeping the same checklist and evidence package
- if the chosen seam changes, the following must be re-evaluated and updated together:
  - capability matrix
  - credential-routing contract
  - history-completeness contract
  - sign-off evidence package
  - sign-off command package

Reason:

- otherwise Phase 0 can look “complete” while its evidence package still proves a different seam than the one actually being shipped

## Current Phase 0 Contract State

This spec now serves two jobs at once:

1. freeze the minimum safe contract for the remaining Phase 0 work
2. record which pieces of that contract already exist in code

That distinction matters because Phase 0 is no longer theoretical.

It already has grounded slices in both repos and is now implementation-complete, but it remains deliberately rollout-limited.

Rule:

- if a section below describes authority or capability truth that is not implemented yet, it is still binding for the next code slices
- if current code violates that truth, current code must change before `codex-native` is unlocked

## Repo Ownership

### `agent_teams_orchestrator`

Owns:

- Codex-native execution seam
- normalized event schema
- raw native event mapping
- transcript-compatible projector
- lane capability truth
- thread-status and warning authority
- credential routing for the chosen seam

Recommended touched areas:

- `src/services/runtimeBackends/types.ts`
- `src/services/runtimeBackends/registry.ts`
- `src/services/runtimeBackends/codexBackendResolver.ts`
- `src/services/boardTaskActivity/contract.ts`
- `src/services/boardTaskActivity/BoardTaskTranscriptProjector.ts`
- `src/query.ts`
- `src/utils/config.ts`

Path note:

- the paths above are in the `agent_teams_orchestrator` repo, not in `claude_team`

Recommended new module split for the spike:

- `src/services/codexNative/execRunner.ts`
- `src/services/codexNative/jsonlMapper.ts`
- `src/services/codexNative/normalizedEvents.ts`
- `src/services/codexNative/capabilities.ts`
- `src/services/codexNative/statusAuthority.ts`
- `src/services/codexNative/transcriptProjector.ts`

Current implementation status:

- ✅ created:
  - `src/services/codexNative/execRunner.ts`
  - `src/services/codexNative/jsonlMapper.ts`
  - `src/services/codexNative/normalizedEvents.ts`
  - `src/services/codexNative/capabilities.ts`
  - `src/services/codexNative/statusAuthority.ts`
  - `src/services/codexNative/transcriptProjector.ts`
  - `src/services/codexNative/signOffHarness.ts`

### `claude_team`

Owns:

- backend-lane-aware status ingestion
- lane-aware copy
- feature-flag exposure
- preserving current transcript/read-model path

Recommended touched areas:

- [ClaudeMultimodelBridgeService.ts](../../src/main/services/runtime/ClaudeMultimodelBridgeService.ts)
- [CliStatusBanner.tsx](../../src/renderer/components/dashboard/CliStatusBanner.tsx)
- [CliStatusSection.tsx](../../src/renderer/components/settings/sections/CliStatusSection.tsx)
- [providerConnectionUi.ts](../../src/renderer/components/runtime/providerConnectionUi.ts)
- [ProviderRuntimeSettingsDialog.tsx](../../src/renderer/components/runtime/ProviderRuntimeSettingsDialog.tsx)
- [SessionParser.ts](../../src/main/services/parsing/SessionParser.ts)
- [BoardTaskExactLogStrictParser.ts](../../src/main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser.ts)

### `plugin-kit-ai`

Not required for the Phase 0 spike.

Only Phase-0-adjacent requirement:

- no UI or status copy may imply plugin execution support for `codex-native` before Phase 3

## Recommended Coding Order

Phase 0 should be cut in this order:

1. `agent_teams_orchestrator` type freeze
- add `codex-native` backend id to runtime backend types
- keep old Codex lane untouched
- add feature flag gates only, no behavior switch yet
- status: ✅ done
  - grounded by:
    - backend id additions
    - resolver gates
    - registry/status exposure
    - targeted runtime backend tests

2. raw exec spike seam
- add a tiny native runner that can start one Codex-native session
- capture raw JSONL
- record executable source, credential path, and `ephemeral` policy
- status: ✅ done
  - grounded by:
    - arg builder
    - real process runner in orchestrator
    - live event fixture mapping
    - observed local seam validation
    - executable-source capture
    - executable-version capture
    - completion-policy and backfill metadata capture
    - explicit client guard that keeps rollout conservative

3. normalized mapper
- map raw events into the Phase-0 normalized schema
- do not wire UI to raw events
- status: ✅ done
  - grounded by:
    - thread started
    - turn started
    - assistant text
    - usage updated
    - turn completed
    - stderr warning passthrough
    - unsupported raw event preservation
    - stable minimal Phase-0 event contract frozen in code

4. transcript-compatible projector
- project the normalized subset into persisted transcript-compatible history
- verify current parser path still works
- status: ✅ done
  - grounded by:
    - persisted assistant projection
    - projected warning rows with source attribution
    - projected thread-status rows
    - projected execution-summary rows with history-completeness metadata
    - green parser and exact-log fixtures

5. status and warning authority
- keep lane status, thread status, and warning-source truth separate
- update bridge payloads before touching UI copy
- status: ✅ done
  - grounded by:
    - backend lane truth in runtime status
    - selectable-vs-available distinction
    - codex-native remains locked
    - targeted UI copy no longer claims auth mode equals runtime lane
    - projected thread-status authority in persisted history
    - projected warning-source attribution in persisted history
    - sign-off evidence for `process` versus `history` warning attribution

6. `claude_team` feature-flagged exposure
- show lane only when the backend truth can already represent it honestly
- keep unsupported capabilities visibly unsupported
- status: ✅ done
  - grounded by:
    - lane-aware config vocabulary
    - lane-aware connection/runtime copy
    - lane-aware selector behavior
    - backend env kept independent from auth mode
    - locked-lane affordance in runtime settings surfaces
    - targeted UI/runtime tests for locked-lane truth

7. fixture and regression pass
- add the mandatory Phase-0 fixtures
- only then allow limited internal usage of the new lane
- status: ✅ done
  - grounded by:
    - resolver fixtures
    - runtime status fixtures
    - raw exec arg-builder fixtures
    - raw JSONL mapper fixtures
    - `claude_team` config/routing/UI fixtures
    - transcript/replay/history fixtures
    - thread-status authority fixtures
    - exact-log compatibility fixtures
    - repo-visible sign-off evidence package

## Authority Order

This is the most important part of the spec.

### 1. Execution authority

For the spike lane:

1. raw `codex exec` JSONL output
2. normalized-event mapping
3. transcript-compatible projection
4. current `claude_team` transcript/read-model path

Rule:

- no UI surface consumes raw native events directly in Phase 0

### 2. History authority

History truth order:

1. explicit seam-owned completion or hydration source for the chosen lane
2. persisted transcript-compatible projection written by orchestrator
3. live event cache for activity only

Rule:

- live stream is never canonical history by itself

### 3. Status authority

Status truth must stay split by scope:

1. native thread status
2. provider-lane status
3. host process/provisioning status

Rules:

- thread health is not inferred from process liveness
- provider-global runtime banners are not allowed to masquerade as thread-specific health
- if native thread status is unavailable on the chosen seam, UI must say degraded or unavailable, not synthesize `active`

### 4. Warning authority

Warning channels remain separate:

1. native thread warnings
2. config/startup warnings
3. provisioning/process warnings

Rules:

- do not merge these channels into one generic warning field
- if a UI surface can only show one summary line, it must still preserve source attribution in detail text

### 5. Launch-intent authority

There are two different truths:

- host launch intent
- live native thread defaults

Rules:

- `provider/model/effort` in launch config is launch intent only
- resumed native thread defaults may differ
- if they differ, UI must show either:
  - inherited native defaults
  - explicit override pending
  - or forced fresh-thread policy

### 6. Credential authority

Rules:

- old Codex lane auth truth and `codex-native` auth truth must not share one fake readiness source
- old lane may still use current app-side `OPENAI_API_KEY` flow
- `codex-native` must use only the credential contract actually required by the chosen seam
- UI must not infer native readiness from old-lane auth success

## Phase 0 Capability Matrix

Phase 0 should assume the following unless the spike proves otherwise:

| Capability | Old Codex lane | `codex-native` spike lane |
| --- | --- | --- |
| Team launch | supported | supported behind flag |
| Transcript-compatible history | supported | required |
| Plugins | unsupported | unsupported in Phase 0 |
| MCP | unsupported or existing-lane-specific | unsupported unless explicitly proven on chosen seam |
| Skills | unsupported or existing-lane-specific | unsupported unless explicitly proven on chosen seam |
| Manual approvals | current lane semantics | unsupported or limited unless explicitly proven |
| Generic interactive prompts | n/a | unsupported in Phase 0 |
| Detached review | current lane semantics | unsupported in Phase 0 |
| Lane-aware status | partial | required |

Practical rule:

- Phase 0 defaults to conservative capability truth
- nothing upgrades from unsupported to supported by implication
- if the live seam only proves diagnostic readiness, capability must remain diagnostic-only

## Current Lock Policy

This is now a required Phase 0 rule, not a suggestion.

`codex-native` may be:

- visible in runtime status
- visible in backend options
- resolved diagnostically

But it must remain:

- `selectable: false`
- non-default
- non-auto-resolved
- non-routable into live execution without an explicit execution-lane implementation
- protected by a targeted runtime error if manually forced too early

Reason:

- Phase 0 now has honest backend truth, real end-to-end native execution, and transcript projection
- the remaining lock is now a rollout-policy choice, not a missing-code problem
- therefore unlocking the lane would still create worse product truth than the current state

## Normalized Event Schema

Phase 0 does not need the full future schema.

It does need a small, stable subset with explicit source attribution.

The important distinction is:

- one minimal schema is already implemented and should now be treated as frozen groundwork
- a richer schema is still allowed later, but only as an additive expansion

### Current minimal schema already frozen in code

Current grounded contract in `src/services/codexNative/normalizedEvents.ts`:

```ts
type CodexNativeNormalizedEvent =
  | {
      type: 'thread_started'
      threadId: string
    }
  | {
      type: 'turn_started'
    }
  | {
      type: 'assistant_text'
      itemId: string
      text: string
    }
  | {
      type: 'usage_updated'
      inputTokens: number
      cachedInputTokens: number
      outputTokens: number
    }
  | {
      type: 'turn_completed'
    }
  | {
      type: 'warning'
      source: 'stderr'
      text: string
    }
  | {
      type: 'unsupported_raw_event'
      rawType: string
      payload: unknown
    }
```

Rules for this already-landed minimal schema:

- it is sufficient for the raw-exec spike groundwork
- it is not yet sufficient for final Phase 0 completion
- it must not be broken or renamed casually while the runner and projector are being wired
- any richer shape added next must be additive or accompanied by projector updates in the same slice

### Target additive schema before Phase 0 can be called complete

This is the richer schema the remaining implementation should converge toward:

```ts
type NormalizedProviderId = 'anthropic' | 'codex' | 'gemini'
type NormalizedRuntimeLaneId = 'anthropic' | 'gemini-cli-sdk' | 'codex-adapter' | 'codex-api' | 'codex-native'

type NativeThreadStatus =
  | { type: 'not_loaded' }
  | { type: 'idle' }
  | { type: 'active'; activeFlags?: string[] }
  | { type: 'system_error' }

type NativeWarningSource = 'thread' | 'config' | 'process' | 'provisioning'

type NormalizedRuntimeEvent =
  | {
      kind: 'thread_started'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      requestId?: string
      status?: NativeThreadStatus
      timestamp: string
    }
  | {
      kind: 'thread_status_changed'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      status: NativeThreadStatus
      timestamp: string
    }
  | {
      kind: 'thread_defaults_restored'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      model?: string
      reasoningEffort?: string
      timestamp: string
    }
  | {
      kind: 'turn_started'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      turnId?: string
      requestId?: string
      timestamp: string
    }
  | {
      kind: 'assistant_text'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      requestId?: string
      text: string
      isDelta: boolean
      timestamp: string
    }
  | {
      kind: 'reasoning'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      requestId?: string
      text?: string
      timestamp: string
    }
  | {
      kind: 'usage_updated'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      requestId?: string
      inputTokens?: number
      outputTokens?: number
      contextWindow?: number
      timestamp: string
    }
  | {
      kind: 'model_rerouted'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      requestId?: string
      configuredModel?: string
      effectiveModel?: string
      reasoningEffort?: string
      timestamp: string
    }
  | {
      kind: 'turn_plan_updated'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      requestId?: string
      summary?: string
      timestamp: string
    }
  | {
      kind: 'turn_diff_updated'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      requestId?: string
      summary?: string
      timestamp: string
    }
  | {
      kind: 'warning_emitted'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      source: NativeWarningSource
      threadId?: string
      requestId?: string
      message: string
      detail?: string
      timestamp: string
    }
  | {
      kind: 'turn_completed'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      requestId?: string
      timestamp: string
    }
  | {
      kind: 'turn_failed'
      provider: NormalizedProviderId
      laneId: NormalizedRuntimeLaneId
      threadId: string
      requestId?: string
      error: string
      timestamp: string
    }
```

Schema rules:

- every event carries `provider` and `laneId`
- every event is source-attributed
- thread status and warnings are not hidden inside generic `detailMessage`
- `requestId` is optional on the wire but mandatory once known
- expansion from the current minimal schema must be additive until projector and fixture coverage are in place

## Transcript Projector Contract

Phase 0 projector requirements:

- produce persisted history that current `SessionParser` and exact-log readers can parse
- preserve request-correlation fields where available
- preserve board-task carrier fields
- never require `claude_team` to understand raw Codex item shapes

Projector rules:

1. `assistant_text`
- may append or extend assistant transcript content

2. `usage_updated`
- does not need to become a visible assistant row
- may project into additive metadata or side-channel metadata
- must not be silently dropped if it is the only authoritative usage source

3. `thread_status_changed`
- does not become canonical transcript history by default
- stays in normalized/status layer

4. `warning_emitted`
- thread and config warnings should be projectable to later UI/debug surfaces
- do not force them into fake assistant rows

5. `thread_defaults_restored`
- must not rewrite old launch config
- must remain explicit metadata

6. `model_rerouted`
- must not overwrite configured model copy invisibly
- may project to normalized-only metadata in Phase 0 if transcript row shape has no truthful home

## Raw Exec Spike Contract

The spike runner must prove all of the following:

- start a Codex-native session in a chosen working directory
- pass native credentials in the seam-native way
- capture JSONL events
- map them to normalized events
- persist transcript-compatible projection
- record:
  - thread id
  - executable identity
  - whether run was `ephemeral`
  - whether completion backfill existed
  - whether final usage/model truth came from live stream or explicit seam-owned completion path

The spike runner must explicitly capture these facts:

- executable source:
  - bundled
  - external CLI
- executable version:
  - exact reported version string when available
- runtime identity:
  - backend lane id
  - executable source
  - executable version
- credential source:
  - native API-key path
  - or explicit unsupported state
- interactive capability:
  - unsupported
  - limited
  - proven
- final history completeness:
  - live-only
  - backfilled
  - explicit hydration required

Current implementation note:

- the spec is already grounded by one live local run
- the next required step is to turn that manual seam proof into a reusable runner contract
- until that happens, `codex-native` remains a locked diagnostic lane
- current code already enforces this lock from both status/selectability truth and live client guardrails

## Status Contract

Phase 0 status payload changes must allow `claude_team` to say all of the following truthfully:

- lane exists but is not selected
- lane is selected but not verified
- lane is resolved but degraded
- lane is running but the thread is not loaded
- lane process is alive but the thread is in `systemError`

Minimum required additions for the spike path:

- keep `selectedBackendId`
- keep `resolvedBackendId`
- keep `availableBackends`
- keep native executable identity in diagnostic or detail truth once the runner exists
- do not let degraded transport erase backend truth
- keep thread health separate from provider-global health

Current implementation note:

- backend-level status truth is already in place
- thread-level status truth is not
- therefore current Phase 0 must still describe `codex-native` as execution-locked

If native thread status is unavailable on the chosen seam:

- surface `unknown` or `degraded`
- do not synthesize `active`

## Warning Contract

Phase 0 UI must be able to distinguish:

- startup/config warning
- native thread warning
- provisioning/process warning

Allowed compromise:

- a single banner may summarize all warning presence

Not allowed:

- one combined warning string with no source attribution anywhere

## Launch Intent vs Native Defaults Contract

Phase 0 must choose one of these policies and implement it explicitly:

1. fresh-thread only
2. resume with inherited native defaults
3. resume but force explicit override

Default for the spike:

- support resume only behind flag
- if resumed defaults differ from launch intent, keep that drift explicit

Minimum required surfaced truth:

- requested launch model/effort
- effective native defaults after resume, if known
- warning or degraded state when they differ

## Credential Routing Contract

Phase 0 must not reuse old-lane readiness assumptions.

Rules:

- `codex-native` readiness is computed only from the chosen seam's credential contract
- old Codex API-key success does not imply native-lane readiness
- missing or wrong native credentials must degrade only the native lane, not the entire provider story

## Test Matrix

Minimum must-exist tests for Phase 0:

### `agent_teams_orchestrator`

- `codex-native-api-key-routing`
- `native-binary-identity-metadata`
- `exec-headless-rejects-interactive-server-requests`
- `live-turn-stream-vs-hydrated-history`
- `thread-system-error-vs-process-alive`
- `thread-not-loaded-vs-runtime-still-running`
- `thread-warning-vs-config-warning-truth`
- `resume-persisted-thread-defaults-vs-launch-intent`
- `resume-model-switch-warning-vs-runtime-copy`
- `ephemeral-turn-completed-without-backfill`
- `non-ephemeral-completed-turn-backfill`
- `request-chain-invariants`

### `claude_team`

- `runtime-selector-visible-but-not-ready`
- `headless-lane-capability-copy`
- `native-lane-auth-copy`
- `exact-log-hydrated-after-live-stream`
- `approval-cleared-on-lifecycle`
- `native-thread-status-vs-process-copy`
- `warning-channel-copy`
- `launch-intent-vs-native-defaults-copy`

## Required Evidence Package For Phase 0 Sign-off

Phase 0 should not be declared complete from code inspection alone.

Minimum sign-off evidence must include all of the following:

1. one real successful `codex exec`-backed native run through the orchestrator lane
2. persisted transcript-compatible output from that run
3. recorded native executable identity for that run:
   - source
   - exact version string when available
4. parser proof that current `claude_team` transcript readers still parse it
5. exact-log or replay proof for both:
   - `--ephemeral`
   - non-ephemeral or explicit replacement hydration path
6. one degraded-path proof showing native lane failure does not erase old-lane fallback truth
7. one status proof showing process-alive does not masquerade as native thread healthy
8. one warning proof showing config warnings and native thread warnings remain attributable
9. green targeted test runs for:
   - existing old-lane fallback/regression coverage
   - new native-lane runner/mapper/projector coverage

Practical rule:

- if any one of the nine items above is missing, Phase 0 is still implementation-in-progress, not sign-off ready

Recommended evidence placement:

- keep sign-off artifacts close to this doc under `docs/research/` or another explicit repo-visible location
- do not rely only on terminal memory or one-off local runs as the sole proof of completion

## Minimum Sign-off Command Package

Phase 0 sign-off should include a reproducible command package, not only prose.

Minimum command set:

### In `agent_teams_orchestrator`

- `bun test src/services/runtimeBackends/codexBackendResolver.test.ts`
- `bun test src/services/runtimeBackends/registry.agentTeams.test.ts`
- `bun test src/services/codexNative/execRunner.test.ts`
- `bun test src/services/codexNative/jsonlMapper.test.ts`
- `bun test src/services/codexNative/transcriptProjector.test.ts`
- `bun test src/services/codexNative/statusAuthority.test.ts`
- `bun test src/services/codexNative/turnExecutor.test.ts`
- `bun test src/services/codexNative/signOffHarness.test.ts`
- `git diff --check`

### In `claude_team`

- `pnpm exec vitest run test/main/ipc/configValidation.test.ts`
- `pnpm exec vitest run test/main/services/runtime/ProviderConnectionService.test.ts`
- `pnpm exec vitest run test/main/services/runtime/providerAwareCliEnv.test.ts`
- `pnpm exec vitest run test/main/services/runtime/ClaudeMultimodelBridgeService.test.ts`
- `pnpm exec vitest run test/renderer/components/runtime/providerConnectionUi.test.ts`
- `pnpm exec vitest run test/renderer/components/runtime/ProviderRuntimeSettingsDialog.test.ts`
- `pnpm exec vitest run test/renderer/components/cli/CliStatusVisibility.test.ts`
- `pnpm exec vitest run test/main/utils/jsonl.test.ts`
- `pnpm exec vitest run test/main/services/parsing/SessionParser.test.ts`
- `pnpm exec vitest run test/main/services/team/BoardTaskExactLogStrictParser.test.ts`
- `git diff --check`

### Manual native-lane proof

- one real `codex exec --json` run through the chosen orchestrator seam
- `bun run ./scripts/codex-native-phase0-signoff.ts --cwd /tmp --prompt 'Reply only with OK' --ephemeral`
- `bun run ./scripts/codex-native-phase0-signoff.ts --cwd /tmp --prompt 'Reply only with OK' --persistent`
- one recorded native executable identity proof:
  - source
  - version string when available
- one explicit `--ephemeral` proof
- one non-ephemeral or explicit replacement-hydration proof
- one degraded-lane proof that old Codex fallback still stays truthful

Rule:

- if the command package is not written down and reproducible, the evidence package is incomplete even if one local run looked good

## Tests Already In Place

The following tests already exist and should remain green while Phase 0 continues:

### `agent_teams_orchestrator`

- `src/services/runtimeBackends/codexBackendResolver.test.ts`
- `src/services/runtimeBackends/registry.agentTeams.test.ts`
- `src/services/codexNative/execRunner.test.ts`
- `src/services/codexNative/jsonlMapper.test.ts`
- `src/services/codexNative/transcriptProjector.test.ts`
- `src/services/codexNative/statusAuthority.test.ts`
- `src/services/codexNative/turnExecutor.test.ts`
- `src/services/codexNative/signOffHarness.test.ts`

### `claude_team`

- `test/main/services/parsing/CodexNativePhase0Smoke.test.ts`
- `test/main/ipc/configValidation.test.ts`
- `test/main/utils/jsonl.test.ts`
- `test/main/services/parsing/SessionParser.test.ts`
- `test/main/services/runtime/ProviderConnectionService.test.ts`
- `test/main/services/runtime/providerAwareCliEnv.test.ts`
- `test/main/services/runtime/ClaudeMultimodelBridgeService.test.ts`
- `test/main/services/team/BoardTaskExactLogStrictParser.test.ts`
- `test/renderer/components/runtime/providerConnectionUi.test.ts`
- `test/renderer/components/runtime/ProviderRuntimeSettingsDialog.test.ts`
- `test/renderer/components/cli/CliStatusVisibility.test.ts`

## Exact Remaining Work Before Phase 0 Can Be Called Complete

There is no remaining required Phase 0 code work.

The remaining steps are rollout-policy decisions:

1. decide whether to keep the lane locked through early internal rollout
2. if unlock is proposed later, make that a separate rollout decision rather than a hidden consequence of Phase 0 completion

## Remaining Implementation Surface From Today

The original Phase 0 estimate was:

- `agent_teams_orchestrator`: `450-1100` lines
- `claude_team`: `180-450` lines
- tests: `250-700` lines

That estimate still looks directionally correct for total Phase 0 scope.

But from the current implementation state, the remaining required surface is now:

- `agent_teams_orchestrator`: `0` lines required for Phase 0
- `claude_team`: `0` lines required for Phase 0
- tests and fixtures: `0` lines required for Phase 0

Remaining total from today:

- roughly `0` lines of required Phase 0 code
- rollout decisions remain separate from implementation completion

Practical reading:

- the big architecture uncertainty is mostly resolved
- execution wiring, projection, parser truth, and proof fixtures are already landed
- the remaining work is rollout policy only

## No-Go Rules For Starting Phase 1 Code

Do not move past Phase 0 if any of these remain ambiguous:

- whether the chosen seam is headless-limited
- whether final history completeness depends on seam-specific backfill
- whether thread status is authoritative or only guessed from process truth
- whether native thread warnings can be attributed separately from config and provisioning warnings
- whether resumed native defaults can diverge from launch intent without visible warning
- whether native credentials are routed independently from the old Codex lane

## Estimated Implementation Surface

For Phase 0 only:

- `agent_teams_orchestrator`: `450-1100` lines
- `claude_team`: `180-450` lines
- tests: `250-700` lines

Total Phase 0 expectation:

- roughly `900-2250` lines

That is intentionally smaller than the broader first-wave rollout.

## Practical Rule

Phase 0 is successful if it proves one thing:

- we can run a real `codex-native` lane and keep our current transcript/UI world honest without pretending Codex is just another Anthropic-shaped transport.
