# Codex Native Runtime Integration Decision

**Status**: Decision  
**Date**: 2026-04-19  
**Owner repos**:

- `claude_team`
- `agent_teams_orchestrator`
- `plugin-kit-ai`

## Purpose

Record the chosen direction for improving Codex integration in the multimodel runtime without losing native Codex capabilities such as plugins, skills, and MCP.

## Chosen Plan Assessment

- Chosen plan: normalized internal event/log layer plus staged `Codex-native` backend lane
- Assessment: `🎯 9   🛡️ 9   🧠 7`
- Estimated first serious wave: `2200-4500` lines across `agent_teams_orchestrator`, `claude_team`, and `plugin-kit-ai`

## Current Status As Of 2026-04-19

The staged cutover is now complete through Phase 4.

- Phase 0 - implementation-complete and evidence-backed
- Phase 1 - rollout-state preparation complete
- Phase 2 - limited internal unlock completed
- Phase 3 - native-first default switch completed
- Phase 4 - legacy Codex lane removal completed

Current product truth:

- Codex now runs only through the `codex-native` lane in normal product flows
- legacy `adapter` and `api` Codex runtime lanes have been removed from active runtime selection and launch paths
- runtime status now exposes a single native Codex backend option
- stored legacy Codex backend values normalize forward to `codex-native`
- the remaining supported credential surface for native Codex is:
  - `CODEX_API_KEY`
  - `OPENAI_API_KEY`

Repo-visible evidence:

- [codex-native-runtime-phase-0-signoff-evidence.md](./codex-native-runtime-phase-0-signoff-evidence.md)
- [codex-native-runtime-phase-1-signoff-evidence.md](./codex-native-runtime-phase-1-signoff-evidence.md)
- [codex-native-runtime-phase-4-signoff-evidence.md](./codex-native-runtime-phase-4-signoff-evidence.md)

## One-Page Summary

We are **not** doing a one-shot swap from the current Codex backend to `@openai/codex-sdk / codex exec`.

We are doing this instead:

- keep the current Codex adapter/API path as the fallback lane initially
- add a new provider-neutral normalized event/log layer inside `agent_teams_orchestrator`
- add a separate `Codex-native` lane that uses the real Codex runtime through `@openai/codex-sdk / codex exec`
- keep unified logs, transcript projection, and UI-facing activity summaries on top of the normalized layer
- use `plugin-kit-ai` for plugin catalog/discover/install/update/remove/repair and native Codex plugin placement
- keep `codex app-server` out of the first critical path, except maybe later as selective control-plane enrichment
- keep native capability truth keyed to the actual runtime identity, not just to one coarse backend id

Core rule:

- if we need unified logs, we normalize events
- if we need native Codex capabilities, we do not fake Codex into Anthropic runtime semantics
- if we claim native capability parity, we key that claim to the real native runtime identity, not only to `codex-native`

## Current Reality

Today, `Codex` inside our multimodel runtime is **not** executed through the real Codex runtime.

Instead, the current path is:

- `claude_team`
- `agent_teams_orchestrator`
- internal Codex backend
- OpenAI Responses API

In practice this means:

- the orchestrator keeps Anthropic-style streaming semantics
- `Codex` is treated as a model backend, not as a native runtime
- native Codex plugins are not honestly end-to-end supported
- current `Codex` capability support is limited by our adapter, not by the real Codex runtime

## Current-Code Seams That Matter

These are the important code facts that shape the decision.

### 1. Current Codex backend selection is adapter/API only

Today the runtime only resolves:

- `adapter`
- `api`

That lives in:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/runtimeBackends/codexBackendResolver.ts`

Important consequence:

- current Codex runtime selection does **not** have a real `codex-cli` or `codex-sdk` lane yet

### 2. Current Codex path translates into Anthropic-style semantics

The current Codex fetch adapter explicitly translates between:

- Anthropic Messages API shape
- OpenAI Responses API shape

That lives in:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/api/codex-fetch-adapter.ts`

Important consequence:

- current Codex support is not just “another provider”
- it is intentionally shaped to preserve Anthropic-style turn/tool semantics

### 3. The main query loop is deeply coupled to Anthropic-style tool flow

The current query loop and tool pipeline are built around:

- `tool_use`
- `tool_result`
- `content_block_start`
- `input_json_delta`
- `message_delta`

That coupling is visible in:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/query.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/tools/toolOrchestration.ts`

Important consequence:

- a full swap to `codex exec` is **not** a transport-only replacement
- it changes the execution model and the tool ownership model

### 4. Current runtime capability reporting is already backend-aware

The runtime backend registry already distinguishes provider/backend status and currently marks Codex plugins as unsupported for the current lanes.

That lives in:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/runtimeBackends/registry.ts`

Important consequence:

- we already have a good seam for capability-gated rollout
- Codex plugin support can stay honest and lane-dependent

### 5. The repo already has an adapter pattern for message projection

`sdkMessageAdapter` already converts one SDK-ish message model into REPL-facing messages and stream events.

That lives in:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/remote/sdkMessageAdapter.ts`

Important consequence:

- adding a normalized layer is aligned with the current direction of the codebase
- this is an extension of an existing pattern, not a foreign architecture

### 6. `claude_team` UI is protected by transcript/read-model layers, not raw runtime streams

`claude_team` primarily reads runtime history through:

- `ParsedMessage`
- `parseJsonlLine(...)`
- strict exact-log transcript parsing
- explicit task-log read models

Important files:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/types/jsonl.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/types/messages.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/utils/jsonl.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/parsing/SessionParser.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/discovery/TeamTranscriptSourceLocator.ts`

Important consequence:

- `claude_team` does **not** want raw Codex-native events directly as the first migration step
- the safest plan is to keep the current transcript/read-model contract stable and additive

### 7. Existing task-log metadata already uses additive transcript fields successfully

The current system already adds task-log metadata to transcript messages without changing the base message parser contract.

Important files:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/boardTaskActivity/BoardTaskTranscriptProjector.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/boardTaskActivity/contract.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/contract/BoardTaskTranscriptContract.ts`

Important consequence:

- we already have a proven pattern for additive transcript enrichment
- normalized Codex-native projection should follow the same discipline instead of replacing the transcript contract wholesale

### 8. Backend ids already cross the orchestrator/main/preload/renderer boundary

Current backend identity is already shared through:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/runtimeBackends/types.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/utils/config.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/types/cliInstaller.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/ClaudeMultimodelBridgeService.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/ProviderRuntimeBackendSelector.tsx`

Important consequence:

- `codex-native` is not just a new orchestrator enum value
- it must be introduced additively across config, runtime status payloads, main/preload bridges, renderer selectors, and tests
- we must not overload `api` or `adapter` with new semantics just to avoid touching those seams

### 9. Transcript invariants are narrower and more coupled than they first look

Current `claude_team` transcript consumers rely not only on entry types, but also on exact enriched fields such as:

- `requestId`
- `sourceToolUseID`
- `sourceToolAssistantUUID`
- `toolUseResult`
- `boardTaskLinks`
- `boardTaskToolActions`

Important files:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/utils/jsonl.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/types/jsonl.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/types/messages.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/analysis/ToolExecutionBuilder.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/analysis/ToolResultExtractor.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser.ts`

Important consequence:

- transcript compatibility in phase 1 is not satisfied by preserving only `user` / `assistant` / `system`
- the projector must preserve the linking and dedupe semantics those fields carry
- exact-log selectors already deduplicate assistant streaming rows with `requestId` plus anchor evidence, so vague “close enough” projection is not safe
- if a Codex-native event cannot be projected without violating these invariants, it should stay in the normalized layer first

### 10. `codex-sdk` thread persistence and raw `codex exec` persistence control are not equivalent yet

Current upstream reality:

- `@openai/codex-sdk` persists threads in `~/.codex/sessions`
- `resumeThread()` exists
- `ThreadOptions` expose `workingDirectory`, `sandboxMode`, `approvalPolicy`, and `additionalDirectories`
- raw `codex exec` supports `--ephemeral`
- current TypeScript SDK does **not** expose `ephemeral` in `ThreadOptions`

Important sources:

- `/tmp/openai-codex/sdk/typescript/README.md`
- `/tmp/openai-codex/sdk/typescript/src/threadOptions.ts`
- `/tmp/openai-codex/sdk/typescript/src/thread.ts`
- `/tmp/openai-codex/sdk/typescript/src/exec.ts`
- `/tmp/openai-codex/codex-rs/exec/src/cli.rs`
- `/tmp/openai-codex/codex-rs/README.md`

Important consequence:

- we cannot assume `@openai/codex-sdk` and raw `codex exec` are interchangeable for session ownership
- phase 0 must explicitly decide whether the first `Codex-native` spike is SDK-first, raw-exec-first, or dual-path
- otherwise we risk baking unwanted durable Codex session persistence into the rollout before we have UI/session ownership clarity

### 11. Approval UX and live runtime state already depend on request-correlation semantics

Current `claude_team` runtime UX tracks live approval state through:

- `pendingApprovals`
- `resolvedApprovals`
- `requestId`
- permission request payloads

Important files:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/types/team.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/index.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/ToolApprovalSheet.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/activity/ActivityItem.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamProvisioningService.ts`

Important consequence:

- phase 1 must preserve a stable request-correlation contract for live activity, not just for persisted transcript parsing
- approval request state, approval result icons, and some streaming dedupe logic already assume `requestId` is stable and meaningful
- the normalized layer needs a first-class request-correlation story, not an implicit one

### 12. Transcript chain and sidechain semantics are already part of the contract

Current transcript/runtime plumbing already treats these fields as meaningful behavior, not decorative metadata:

- `parentUuid`
- `logicalParentUuid`
- `isSidechain`
- `isMeta`
- `sessionId`
- `agentId`
- `agentName`

Important files:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/types/logs.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/utils/sessionStorage.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/parsing/SessionParser.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/analysis/ConversationGroupBuilder.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TaskBoundaryParser.ts`

Important consequence:

- phase 1 must preserve parent/chain semantics for persisted transcript rows
- sidechain versus main-thread identity must remain truthful
- internal-user/tool-result rows must not drift in `isMeta` semantics
- if Codex-native projection cannot preserve those semantics truthfully, it should stay normalized-only first instead of emitting misleading transcript rows

### 13. Runtime status/settings already assume specific Codex backend semantics

Current runtime settings and status surfaces already depend on concrete Codex backend assumptions through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/providerConnectionUi.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/ProviderRuntimeSettingsDialog.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/ProviderRuntimeBackendSelector.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/dialogs/ProvisioningProviderStatusList.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/ClaudeMultimodelBridgeService.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/CliProviderModelAvailabilityService.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/providerModelProbe.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/infrastructure/CliInstallerService.ts`

Important current-code facts:

- `isConnectionManagedRuntimeProvider(...)` currently special-cases `codex`, so UI assumes Codex runtime follows the selected connection mode instead of an independent backend selector
- runtime settings, provisioning checks, and installer snapshots already carry `selectedBackendId`, `resolvedBackendId`, `availableBackends`, and `externalRuntimeDiagnostics`
- model verification cache signatures already depend on `selectedBackendId`, `resolvedBackendId`, and `backend.endpointLabel`
- current Codex model probe arguments are still generic Claude-CLI provider probes, not a separate Codex-native probing contract

Important consequence:

- `codex-native` cannot be introduced as an orchestrator-only backend enum
- phase 0 must explicitly decide whether Codex remains connection-managed in UI or gains an independently selectable runtime lane
- phase 1 must give `codex-native` an explicit runtime status/settings contract and explicit model-probe policy
- otherwise runtime summary UI, provisioning checks, installer snapshots, and model verification can quietly drift out of sync

### 14. Approval UX depends on a concrete control/permission protocol, not a generic concept

Current approval behavior already depends on specific protocol shapes through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamProvisioningService.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/types/team.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/slices/teamSlice.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/ToolApprovalSheet.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/activity/ActivityItem.tsx`

Important current-code facts:

- the lead-runtime path emits manual approvals from CLI `control_request` messages and only `subtype=can_use_tool` becomes a `ToolApprovalRequest`
- non-`can_use_tool` control requests are auto-allowed explicitly to avoid deadlock
- teammate approval fallback already exists as a separate `permission_request` inbox/message path
- renderer approval icons and pending states inspect `structured.type === 'permission_request'` and correlate them through `request_id` into `pendingApprovals` and `resolvedApprovals`

Important consequence:

- phase 1 cannot claim Codex-native approval parity unless there is a truthful adaptation path into the current `ToolApprovalRequest` + `requestId` contract
- if Codex-native cannot yet provide a safe allow/deny response loop, the lane must stay limited instead of pretending approval UX still works
- approval/control adaptation must be treated as its own contract layer, not as a vague future cleanup

### 15. Connection auth mode and Codex runtime backend are currently coupled in env construction

Current Codex connection and runtime routing already mutate the execution env through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/ProviderConnectionService.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/providerAwareCliEnv.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/providerRuntimeEnv.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/providerConnectionUi.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/test/renderer/components/runtime/providerConnectionUi.test.ts`

Important current-code facts:

- current Codex API-key mode explicitly writes `CLAUDE_CODE_CODEX_BACKEND=api`
- current Codex OAuth mode explicitly writes `CLAUDE_CODE_CODEX_BACKEND=adapter`
- current UI copy and tests already assume `Codex API key` means the public Responses API path and `Codex subscription` means the built-in adapter path
- runtime backend selection env and provider-connection env are both applied during CLI env construction, so stale coupling here can silently override a new lane

Important consequence:

- `codex-native` cannot be added safely without explicitly decoupling “how Codex authenticates” from “which Codex execution lane runs”
- phase 0 must define whether API-key mode for Codex-native still uses the real Codex runtime or only the old Responses API lane
- runtime env construction must stop assuming that Codex auth mode alone determines the backend lane

### 16. App config validation and launch granularity currently lag behind backend-lane truth

Current app config and launch surfaces already constrain how backend truth can evolve through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/ipc/configValidation.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/infrastructure/ConfigManager.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/types/team.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamProvisioningService.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/runtimeBackends/codexBackendResolver.ts`

Important current-code facts:

- app-side `RuntimeConfig.providerBackends.codex` currently only allows `auto | adapter`
- app IPC validation for `runtime.providerBackends.codex` also only allows `auto | adapter`
- orchestrator-side Codex backend resolution already knows `auto | adapter | api`
- `TeamLaunchRequest` carries `providerId`, `model`, and `effort`, but no per-launch backend id
- provisioning summaries and probe cache keys currently reason about provider-level launch truth, not launch-specific backend overrides

Important consequence:

- `codex-native` is not just a new orchestrator backend enum - it is also a config-schema and launch-contract change
- phase 0 must explicitly decide whether the first rollout keeps backend selection global per provider or introduces per-launch backend override
- if the rollout keeps global provider backend selection, the plan must say that clearly and keep team launch/provisioning UX honest about that limitation

### 17. Codex backend routing currently behaves like process-level state, not member-level launch state

Current team launch and teammate spawn plumbing already suggests backend routing is process-scoped through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamProvisioningService.ts`
- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/tools/shared/spawnMultiAgent.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/types/team.ts`

Important current-code facts:

- `buildProvisioningEnv(providerId)` resolves env per provider, not per requested backend lane
- `TeamLaunchRequest` and member provider overrides carry `providerId`, but not backend id
- teammate spawn diagnostics log `process.env.CLAUDE_CODE_CODEX_BACKEND`, which indicates current Codex backend selection is inherited from process env at spawn time
- current team launch/provisioning summaries can show provider-level runtime/backend info, but they do not expose member-level Codex backend selection

Important consequence:

- phase 1 must not imply that different Codex teammates inside one orchestrator process can independently choose different Codex backend lanes unless the launch contract is explicitly expanded
- the safest first rollout assumption is that Codex backend selection remains process-wide or at most provider-global for the launched runtime
- provisioning, launch UI, and team-member overrides must stay honest about that limitation

### 18. Provisioning probe cache is still provider-scoped and can outlive backend/auth changes

Current provisioning-readiness and warm-up cache behavior is defined through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamProvisioningService.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/infrastructure/ConfigManager.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/ipc/config.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/http/config.ts`

Important current-code facts:

- `createProbeCacheKey(cwd, providerId)` currently keys probe results only by absolute `cwd`, `getClaudeBasePath()`, and resolved `providerId`
- `getCachedOrProbeResult(...)` checks that cache **before** rebuilding provider env, so a cached hit bypasses newer backend/auth env resolution
- `buildProvisioningEnv(providerId)` already derives backend-sensitive env through provider connection settings and runtime backend settings, but that identity is not part of the probe cache key
- `clearProbeCache(...)` is currently only used by explicit `forceFresh` paths, while normal config updates through `ConfigManager.updateConfig(...)` do not invalidate affected probe entries
- probe cache TTL is currently `36h`
- model verification already uses backend-aware signatures, so provisioning readiness can disagree with model verification after a backend/auth switch

Important consequence:

- switching Codex auth mode, runtime backend selection, or probe policy can leave stale provider-level readiness truth alive for up to the cache TTL
- `codex-native` rollout needs an explicit backend-aware probe-cache identity or explicit invalidation contract
- provisioning banners, readiness checks, and backend-aware model verification must not be allowed to drift into split-brain truth

### 19. External runtime diagnostics already surface Codex CLI presence, but that is not lane readiness

Current runtime-status and installer snapshot plumbing already carries external runtime diagnostics through:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/runtimeBackends/registry.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/ClaudeMultimodelBridgeService.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/infrastructure/CliInstallerService.ts`

Important current-code facts:

- current Codex runtime status always includes `externalRuntimeDiagnostics: [detectExternalBinary('codex', 'Codex CLI')]`
- that diagnostic is published even while current selected/resolved backend truth is still only `adapter/api`
- current Codex capability truth still marks plugins as `unsupported` despite surfacing Codex CLI detection
- installer snapshots and bridged provider status already persist/copy these diagnostics forward

Important consequence:

- finding a local `codex` binary must not be treated as proof that `codex-native` is selectable, ready, authenticated, or safe to advertise
- phase 1 needs an explicit rule for how external binary detection relates to backend availability and lane readiness
- runtime status and installer/provisioning UI must not collapse “CLI detected” into “Codex-native ready”

### 20. Backend option status already distinguishes `selectable` from `available`, but UI mostly behaves as if only `available` matters

Current backend-option status and runtime selector plumbing already exposes:

- `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/runtimeBackends/types.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/ProviderRuntimeBackendSelector.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/ClaudeMultimodelBridgeService.ts`

Important current-code facts:

- `RuntimeBackendOptionStatus` already has both `selectable` and `available`
- runtime bridge preserves `selectable` into `CliProviderStatus.availableBackends`
- current renderer selector effectively disables options based on `!option.available`, not on `option.selectable`
- current Codex statuses for `adapter/api` mostly collapse these concepts anyway, so the mismatch has not hurt much yet

Important consequence:

- `codex-native` can create a new state we do not model well today: backend option is visible and intentionally selectable, but not yet authenticated/verified
- phase 1 needs an explicit semantics split between:
  - backend can be selected
  - backend is currently available
  - backend is currently resolved
  - backend is currently verified for execution
- otherwise UI can either hide the lane until too late or misrepresent it as fully ready when it is only selectable

### 21. Unified runtime-status fallback currently drops backend-rich truth

Current main-process runtime-status bridging still has a legacy fallback path through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/ClaudeMultimodelBridgeService.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/providerConnectionUi.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/ProviderRuntimeSettingsDialog.tsx`

Important current-code facts:

- when `runtime status --json` fails or is unsupported, `ClaudeMultimodelBridgeService` falls back to legacy `auth status` and `model list` probes
- that legacy path rebuilds provider status from `createDefaultProviderStatus(...)`, which starts with:
  - `selectedBackendId: null`
  - `resolvedBackendId: null`
  - `availableBackends: []`
  - `externalRuntimeDiagnostics: []`
- the fallback path partially restores generic provider auth/model truth, but it does not restore backend-option truth for Codex
- current renderer still special-cases Codex as connection-managed, so losing backend-rich status can silently reinforce old Codex semantics during transient failures

Important consequence:

- `codex-native` rollout needs an explicit rule for degraded status transport
- transient runtime-status failures must not erase backend-lane truth so completely that the lane disappears or reverts to old connection-managed-only semantics in UI
- if backend-rich truth is unavailable, the degraded state must be explicit, not silently collapsed into legacy provider-only status

### 22. Current Codex status copy still derives “runtime” mostly from auth mode, not from backend lane

Current renderer/runtime copy for Codex still flows through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/providerConnectionUi.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/ProviderRuntimeSettingsDialog.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/dashboard/CliStatusBanner.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/settings/sections/CliStatusSection.tsx`

Important current-code facts:

- `isConnectionManagedRuntimeProvider(provider)` still returns `provider.providerId === 'codex'`
- `getProviderCurrentRuntimeSummary(provider)` for Codex currently derives “Current runtime” from `authMethod` or `configuredAuthMode`, not from `selectedBackendId` / `resolvedBackendId`
- current Codex connection copy still revolves around:
  - `Codex subscription`
  - `OpenAI API key`
- settings/dashboard sections choose between “managed runtime summary” and backend summary using that Codex-specific connection-managed branch

Important consequence:

- `codex-native` can be selected correctly in backend truth while UI copy still describes only old auth-world semantics
- phase 1 needs an explicit rule for when Codex copy is allowed to talk about connection method versus execution lane
- otherwise status banners, settings summaries, and empty/error states can quietly misdescribe the active lane even when backend plumbing is correct

### 23. Runtime status currently has two renderer write paths, and the progressive snapshot path bypasses epoch/loading reconciliation

Current status transport and renderer-store plumbing already flows through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/infrastructure/CliInstallerService.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/ipc/cliInstaller.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/index.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/slices/cliInstallerSlice.ts`

Important current-code facts:

- `CliInstallerService.getStatus()` seeds `latestStatusSnapshot` immediately, then progressively publishes status snapshots from:
  - `gatherStatus(...)`
  - the multimodel provider callback inside `checkAuthStatus(...)`
  - later model-availability updates through `handleProviderModelAvailabilityUpdate(...)`
- IPC `cliInstaller:getStatus` also returns a cached/final response path, while `cliInstaller:getProviderStatus` separately patches cached provider truth through `patchCachedProviderStatus(...)`
- renderer progress handling currently does `useStore.setState({ cliStatus: progress.status })` for `progress.type === 'status'`
- that progress-driven write path bypasses:
  - `cliStatusEpoch`
  - `cliProviderStatusSeq`
  - `cliStatusLoading`
  - `cliProviderStatusLoading`
  - `cliStatusError`
- slice-driven `fetchCliStatus()` and `fetchCliProviderStatus()` still do their own request sequencing and loading-state management, so the store already has two independent status-write paths

Important consequence:

- `codex-native` rollout can otherwise race between:
  - request/response status fetches
  - background progressive status snapshots
  - provider-specific refreshes
  - late model-verification updates
- phase 1 needs an explicit in-flight snapshot contract so partial or older status pushes cannot silently overwrite fresher backend-lane truth
- renderer/store must be able to distinguish:
  - in-flight partial snapshot
  - settled status truth
  - degraded transport truth

### 24. Extension preflight and action gating still rely on coarse runtime truth, not backend-lane truth

Current extension store and action-gating logic already flows through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/utils/extensionNormalizers.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/slices/extensionsSlice.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/extensions/ExtensionStoreView.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/extensions/common/InstallButton.tsx`

Important current-code facts:

- extension mutations currently preflight only against coarse store state like:
  - `cliStatus === null`
  - `cliStatusLoading`
  - runtime installed/startable truth
  - provider-level authenticated/mutable capability truth
- `getExtensionActionDisableReason(...)` does not currently express backend-lane-specific states like:
  - selected lane exists but is not yet verified
  - runtime status is degraded but last known lane truth still exists
  - provider supports plugins only on one backend lane, not on another
- extension store copy already says support can differ by section and provider, but mutation gating is still mostly global-runtime and provider-capability driven
- this is acceptable today only because current Codex plugin truth is still effectively one-dimensional: unsupported on the old lane

Important consequence:

- once `codex-native` exists, plugin management can otherwise become enabled or disabled based on provider-wide truth that is too coarse for backend-lane reality
- phase 1 needs backend-aware extension preflight semantics, not just provider-wide auth/capability semantics
- install/uninstall buttons, extension banners, and mutation preflight must stay honest when the selected lane is:
  - supported but not verified
  - degraded
  - still on the old Codex backend

### 25. Team model selectors and provisioning diagnostics still see a provider-wide runtime shape, not full backend-lane identity

Current team model/runtime plumbing already flows through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/utils/teamModelCatalog.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/utils/teamModelAvailability.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/dialogs/TeamModelSelector.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/dialogs/CreateTeamDialog.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/dialogs/LaunchTeamDialog.tsx`

Important current-code facts:

- `RuntimeAwareProviderStatus` in `teamModelCatalog.ts` is currently only:
  - `providerId`
  - `authMethod`
  - `backend`
- `TeamModelRuntimeProviderStatus` in `teamModelAvailability.ts` still omits:
  - `selectedBackendId`
  - `resolvedBackendId`
  - `availableBackends`
  - `externalRuntimeDiagnostics`
- launch/create dialogs build `runtimeProviderStatusById` from full provider status, but team-model helpers immediately narrow that truth to the smaller provider-wide shape above
- current runtime-aware model disabling for Codex therefore still reasons mostly from auth/backend summary heuristics, not from explicit backend-lane identity

Important consequence:

- `codex-native` can otherwise have different model-visibility or model-selection truth than old Codex while team selectors still reason as if Codex were one provider-wide runtime
- phase 1 needs an explicit lane-aware runtime shape for team model selectors and provisioning diagnostics
- otherwise create/launch dialogs can quietly validate, hide, or explain models using stale old-Codex assumptions

### 26. Provisioning prepare-cache identity currently depends on backend summary display text, not canonical backend identity

Current provisioning warmup/model cache plumbing already flows through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/dialogs/providerPrepareCacheKey.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/dialogs/ProvisioningProviderStatusList.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/dialogs/CreateTeamDialog.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/dialogs/LaunchTeamDialog.tsx`

Important current-code facts:

- `buildProviderPrepareModelCacheKey(...)` currently keys warmup/model-cache reuse by:
  - `cwd`
  - `providerId`
  - `backendSummary`
  - `limitContext`
- `backendSummary` is derived from `getProvisioningProviderBackendSummary(...)`
- that summary is a display-oriented string derived from:
  - selected/resolved backend ids when labels exist
  - backend labels
  - fallback labels/copy
- both launch and create dialogs reuse that display-derived summary as cache identity for provider prepare diagnostics

Important consequence:

- `codex-native` rollout can otherwise tie cache correctness to UI wording rather than canonical backend identity
- copy changes, label collisions, or fallback-summary drift can produce false cache hits or misses across Codex lanes
- phase 1 needs canonical provisioning cache identity based on backend/auth/probe truth, not backend summary text

### 27. Persisted team identity, replay flows, runtime snapshots, and resume guards are still lane-agnostic

Current team persistence and replay plumbing already flows through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/types/team.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/ipc/teams.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamMetaStore.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamMembersMetaStore.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamMemberResolver.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamBackupService.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/slices/teamSlice.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/dialogs/launchDialogPrefill.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamProvisioningService.ts`

Important current-code facts:

- `TeamLaunchRequest` and `TeamCreateRequest` currently carry:
  - `providerId`
  - `model`
  - `effort`
  - `limitContext`
  but no backend lane id or canonical runtime-lane identity
- shared `TeamConfig` and `TeamMember` persistence also carry only:
  - `providerId`
  - `model`
  - `effort`
  with no backend lane field in config-level or member-level identity
- `team.meta.json` (`TeamMetaFile`) persists:
  - `providerId`
  - `model`
  - `effort`
  - `skipPermissions`
  - `worktree`
  - `extraCliArgs`
  - `limitContext`
  but no canonical backend lane identity
- `members.meta.json` persists per-member:
  - `providerId`
  - `model`
  - `effort`
  but no backend lane identity
- renderer-side `TeamLaunchParams` persisted in local storage also only stores:
  - `providerId`
  - `model`
  - `effort`
  - `limitContext`
- `resolveLaunchDialogPrefill(...)` reuses `savedRequest` and `previousLaunchParams`, but neither source can preserve selected/resolved backend lane truth
- `teams:getDraftLaunchPayload` reconstructs draft launch truth from `team.meta.json` and `members.meta.json`, but that payload also only contains provider/model/effort-level identity
- draft-team replay path reconstructs `TeamCreateRequest` from `team.meta.json` plus `members.meta.json`, so retry-after-failure also replays only provider/model/effort truth
- `TeamMemberResolver` merges `config.json` and `members.meta.json` member identity only through `providerId/model/effort`, so downstream team/runtime views cannot recover lane truth later
- `TeamAgentRuntimeEntry` / `TeamAgentRuntimeSnapshot` expose backend process shape (`lead`, `tmux`, `in-process`, etc.), but not provider backend lane identity
- `handleLaunchTeam(...)` and draft-launch-to-create flow validate/request only provider/model/effort fields, so launch IPC cannot explicitly carry `codex-native` lane identity yet
- `TeamProvisioningService.shouldSkipResumeForProviderRuntimeChange(...)` currently compares only:
  - provider id
  - model
  and does not compare backend-lane identity
- `TeamProvisioningService.getConfiguredRuntimeBackend(providerId)` resolves launch-time backend from current global runtime config, so relaunch after a settings change can silently use a different Codex lane than the original launch assumed
- `TeamBackupService` durable restore path is centered on `config.json` plus `members.meta.json` and does not restore backend-lane-aware identity today, so launched-team restore also replays lane-agnostic identity unless those files gain canonical backend identity
- `TeamBackupService` root file set does not currently include `team.meta.json`, so draft-team retry truth and launched-team restore truth already come from different persistence surfaces, and neither one stores canonical backend lane identity

Important consequence:

- a saved or replayed team launch can silently drift onto a different Codex lane after global runtime settings change
- a failed draft create that is later retried can also silently shift lanes because `team.meta.json` / `members.meta.json` never persisted lane identity
- a restored team can also come back without backend-lane truth because backup/restore currently preserves only lane-agnostic files
- resume guards can falsely treat old and new launches as the “same runtime” because they only compare provider/model, not backend lane
- runtime snapshots, resolved member views, and relaunch UI cannot honestly answer whether a team is:
  - pinned to a lane
  - inheriting the current global lane
  - or drifting because launch persistence never stored the lane in the first place
- phase 1 needs an explicit persisted-team-identity and relaunch-identity contract before `codex-native` can be considered safe for team flows

### 28. Team summaries, list surfaces, and synthetic provisioning cards are still lane-blind

Current team-summary and list-surface plumbing already flows through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/types/team.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamConfigReader.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamDataService.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/slices/teamSlice.ts`

Important current-code facts:

- `TeamSummary` currently exposes:
  - display/name
  - project/session history
  - launch-state counters
  - pending-create / partial-failure state
  but no:
  - `providerId`
  - `selectedBackendId`
  - `resolvedBackendId`
  - canonical backend-lane identity
- `TeamConfigReader.readTeamSummary(...)` and `readDraftTeamSummary(...)` build team list cards from:
  - `config.json`
  - `team.meta.json`
  - `members.meta.json`
  - launch-state files
  but never project backend-lane truth into the resulting summary
- renderer team list state uses `TeamSummary` as the canonical list/card surface through:
  - `teams`
  - `teamByName`
  - `teamBySessionId`
- synthetic `provisioningSnapshotByTeam` cards created during team creation also omit provider/backend lane truth and only show generic display/member/project data
- current summary equality/store reconciliation already keys heavily off `TeamSummary` fields, so list/card updates cannot become lane-aware unless the shared summary contract changes first

Important consequence:

- even if persisted team identity becomes backend-aware later, current team list/cards/tabs still cannot show whether a team is:
  - on old Codex
  - on `codex-native`
  - inheriting the current global lane
  - or pinned to a stored lane
- draft cards and live team list cards can present the same team as if they were equivalent while one path is inherited-global and another is lane-pinned
- phase 1 needs an explicit team-summary/list-surface contract instead of assuming lane truth can stay hidden below detail views

### 29. Member runtime summaries, bootstrap copy, and composer capability suggestions are still provider-wide, not lane-aware

Current member/detail/composer display plumbing already flows through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/utils/memberRuntimeSummary.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/members/MemberList.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/members/MemberDetailDialog.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/members/MemberDetailHeader.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/utils/bootstrapPromptSanitizer.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/messages/MessageComposer.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/utils/providerSlashCommands.ts`

Important current-code facts:

- `resolveMemberRuntimeSummary(...)` currently builds member runtime copy only from:
  - configured `providerId`
  - configured/inferred `model`
  - configured `effort`
  - runtime model inference
  - RSS memory suffix
  and does not carry:
  - `selectedBackendId`
  - `resolvedBackendId`
  - canonical backend-lane identity
- `MemberCard` and `MemberDetailHeader` receive only a final `runtimeSummary: string`, so renderer detail surfaces cannot distinguish old Codex from `codex-native` unless that string becomes lane-aware first
- bootstrap/system-copy sanitization also builds runtime summary only from `providerId/model/effort`, not from backend lane truth
- `MessageComposer` derives `leadProviderId` only from:
  - `lead.providerId`
  - or `inferTeamProviderIdFromModel(lead.model)`
- slash command suggestions then branch only on `providerId === 'codex'` through `getSuggestedSlashCommandsForProvider(...)`, so capability hints remain provider-wide rather than lane-aware

Important consequence:

- even if top-level runtime status becomes lane-aware, member cards, member detail, bootstrap copy, and composer suggestions can still collapse old Codex and `codex-native` into the same visible runtime story
- lane-specific capability affordances like Codex slash commands, plugin/app wording, or runtime summary copy can appear purely because the provider is `codex`, even when the selected lane is still old Codex or degraded
- phase 1 needs an explicit member/composer surface contract instead of assuming provider-level Codex identity is good enough once backend-lane truth matters

### 30. Plugin install success, activation in a new thread, restart semantics, and app-auth completion are still conflated into one coarse “installed” state

Current extension/plugin activation plumbing already flows through:

- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/extensions/ExtensionStoreView.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/extensions/plugins/PluginsPanel.tsx`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/slices/extensionsSlice.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/types/extensions/plugin.ts`
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/utils/extensionNormalizers.ts`
- `https://developers.openai.com/codex/plugins/build`
- `https://developers.openai.com/codex/app-server`
- `/tmp/openai-codex/codex-rs/app-server/README.md`
- `/tmp/openai-codex/codex-rs/tui/src/chatwidget/plugins.rs`
- `/tmp/openai-codex/codex-rs/cli/src/main.rs`
- `/tmp/openai-codex/codex-rs/features/src/lib.rs`

Important current-code and current-doc facts:

- current extension UI only has a coarse warning: `Running sessions won't pick up extension changes until restarted.`
- `PluginsPanel` still describes multimodel plugin support in provider-wide terms and does not express lane-specific activation semantics
- shared plugin types currently stop at:
  - installed scopes
  - version
  - install path
  and carry no explicit activation/session-visibility fields like:
  - active in current session
  - active only in new thread
  - requires restart
  - requires app auth/setup completion
- extension action gating currently only answers “can install/uninstall now?”, not “when does this become usable in the selected lane?”
- official Codex app-server/plugin docs still mark `plugin/list`, `plugin/read`, `plugin/install`, and `plugin/uninstall` as under development for production clients
- official Codex plugin invocation docs already assume plugin usage happens through an explicit new turn/thread flow rather than retroactively mutating an already-running turn
- upstream Codex feature and CLI copy already use:
  - `start a new chat or restart Codex to use it`
  - `Please restart Codex`
- Codex TUI plugin install/auth flow explicitly distinguishes:
  - plugin installed
  - remaining app setup/auth still needed
  - plugin may not be usable until required apps are installed

Important consequence:

- phase 1 cannot treat `install succeeded` as equivalent to:
  - plugin active in current session
  - plugin active in current thread
  - plugin usable without restart/new-thread boundary
  - plugin fully usable without extra app/MCP auth setup
- `codex-native` rollout needs an explicit plugin-activation/session-visibility contract that separates:
  - native placement success
  - lane supports plugin execution
  - plugin usable in next thread only
  - plugin requires full runtime restart
  - plugin still blocked on app/auth setup
- without that contract, extension UI can easily overclaim “installed and ready” when the real truth is only “installed and available after new thread/restart”

### 31. Structured mention targeting is richer in Codex app-server than in the current SDK/exec embedding seam

Current Codex invocation-shape differences already flow through:

- `https://developers.openai.com/codex/app-server`
- `/tmp/openai-codex/sdk/typescript/src/thread.ts`
- `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/UserInput.ts`
- `/tmp/openai-codex/codex-rs/core/src/session/turn.rs`
- `/tmp/openai-codex/codex-rs/core/src/plugins/mentions.rs`
- `/tmp/openai-codex/codex-rs/core/src/plugins/mentions_tests.rs`

Important current-code and current-doc facts:

- Codex app-server already supports structured user-input items like:
  - `text`
  - `image`
  - `localImage`
  - `skill`
  - `mention`
- official app-server examples show deterministic plugin/app invocation through:
  - `mention` items with `plugin://...`
  - `mention` items with `app://...`
- current TypeScript SDK input surface is still only:
  - `text`
  - `local_image`
- real Codex core can still resolve explicit plugin/app mentions from linked text like:
  - `[@sample](plugin://sample@test)`
  - `[$calendar](app://calendar)`
- core tests prove structured mentions and linked-text mentions dedupe and resolve correctly, but that is still a lower-level runtime behavior, not the same thing as an explicit first-class SDK input contract

Important consequence:

- phase 1 cannot assume that the chosen execution seam already gives us a first-class, deterministic plugin/app/skill invocation API in Node/Electron
- if we start with raw `codex exec` or current `@openai/codex-sdk`, exact plugin/app targeting may depend on:
  - linked text mentions
  - prompt shaping
  - runtime-side parsing behavior
  rather than on a structured invocation item we directly control
- `codex-native` rollout therefore needs an explicit mention-targeting contract that says whether phase 1 supports:
  - explicit deterministic plugin/app targeting
  - linked-text mention targeting only
  - or no lane-specific invocation affordance yet
- without that contract, UI/composer surfaces can overclaim exact plugin/app invocation support just because installation and runtime execution exist

### 32. Live turn notifications, sparse turn/thread payloads, and hydrated thread history are not the same truth source

Current Codex thread/history plumbing already differs sharply between:

- active-turn notifications from:
  - `https://developers.openai.com/codex/app-server`
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
- sparse `Turn` / `Thread` payloads from:
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/Turn.ts`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts`
- our persisted/hydrated transcript readers in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/utils/jsonl.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/types/messages.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/stream/BoardTaskLogStreamService.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/exact/BoardTaskExactLogDetailSelector.ts`

Important current-code and current-doc facts:

- official app-server docs explicitly separate:
  - `thread/read`
  - `thread/turns/list`
  - `thread/resume`
  - `thread/fork`
  from live `turn/*` and `item/*` notifications
- official `Turn` schema says `turn.items` is:
  - only populated on `thread/resume` or `thread/fork` response
  - empty on other responses and notifications
- official `Thread` schema says `thread.turns` is:
  - only populated on `thread/resume`, `thread/rollback`, `thread/fork`, and `thread/read` with `includeTurns`
  - empty on other responses and notifications
- official app-server docs also note that `turn/started` and `turn/completed` currently carry empty `items` arrays even when item events streamed, and UIs should rely on `item/*` for active-turn item streaming instead
- app-server notifications are also explicitly subscription/connection-shaped:
  - `thread/start` and `thread/fork` auto-subscribe the current connection to turn/item notifications
  - `thread/unsubscribe` removes that connection from the thread event stream
  - per-connection notification opt-out already exists through `optOutNotificationMethods`
  - some streamed notifications are explicitly documented as connection-scoped
- this means active notifications are the right truth for:
  - in-flight activity
  - incremental rendering
  - approval/runtime progress
  but they are still not the same thing as:
  - hydrated thread history
  - replayable/persisted transcript truth
  - explicit read/resume/fork history snapshots
- our current `claude_team` exact-log and task-log paths are already grounded in hydrated/persisted `ParsedMessage[]` loaded from JSONL streams, not in some generic in-memory live event cache
- `ParsedMessage`-based downstream consumers already expect stable persisted fields like:
  - `uuid`
  - `parentUuid`
  - `requestId`
  - `sourceToolUseID`
  - `toolUseResult`
  - chain/sidechain metadata
  and those expectations cannot safely be replaced by raw partial live-notification state in phase 1

Important consequence:

- phase 1 cannot treat live Codex notifications as if they were already a canonical thread-history source
- active turn streaming and history hydration must stay separate contracts
- `codex-native` rollout needs an explicit rule for which source is authoritative for:
  - live activity
  - replay/resume
  - exact log
  - task log detail
  - post-hoc transcript reads
- without that rule, it is easy to build a nice live spike and still break exact-log/task-log/replay flows because sparse or partial live turn state gets mistaken for persisted history truth

### 33. Approval requests can resolve by lifecycle cleanup, not only by explicit user decision

Current approval lifecycle semantics already differ between official Codex app-server and our current CLI-oriented approval flow:

- official Codex docs in:
  - `https://developers.openai.com/codex/app-server`
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
- current approval store/runtime plumbing in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/slices/teamSlice.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/index.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/types/team.ts`

Important current-code and current-doc facts:

- official app-server approval flow explicitly emits `serverRequest/resolved { threadId, requestId }` not only after a client decision, but also when the pending request is cleared by:
  - turn start
  - turn completion
  - turn interruption
- the same cleanup rule applies both to:
  - approval requests
  - `requestUserInput`
  - other server-initiated request lifecycles tied to turn state
- our current renderer/store flow is stricter and more CLI-specific:
  - `respondToToolApproval(...)` removes a pending approval only after successful IPC response
  - current store also knows about explicit `autoResolved` and `dismissed` events from our existing main-process protocol
  - pending/resolved UI state is keyed by `runId + requestId`
  - activity rows and approval icons already depend on that cleanup being truthful
- this means a Codex-native lane cannot stop at “we can show an approval request and send allow/deny”
- it also needs a truthful cleanup contract for:
  - lifecycle-cleared pending requests
  - interrupted turns
  - replaced turns
  - requests that never receive an explicit user response

Important consequence:

- phase 1 cannot treat “approval response path exists” as enough for approval UX parity
- `codex-native` rollout needs an explicit authoritative rule for when a pending approval becomes:
  - answered by the user
  - auto-resolved
  - lifecycle-cleared
  - dismissed because the run/turn is no longer active
- without that rule, UI can easily get:
  - stuck pending approvals
  - wrong resolved icons
  - stale request rows after turn interruption/restart
  - mismatched approval state between live activity and transcript/detail views

### 34. Generic interactive prompts and MCP elicitations currently have no honest UI path in our app

Current interactive-request support already differs sharply between official Codex runtime capabilities and our current app surfaces:

- official Codex docs in:
  - `https://developers.openai.com/codex/app-server`
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
- current local UI/runtime surfaces in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/ToolApprovalSheet.tsx`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/activity/PendingRepliesBlock.tsx`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/slices/teamSlice.ts`

Important current-code and current-doc facts:

- official Codex app-server supports:
  - `tool/requestUserInput` for 1-3 short user questions
  - `mcpServer/elicitation/request` for structured MCP-server input
- those request types have their own lifecycle and can also resolve/clear through `serverRequest/resolved`
- in our current repo code, there is no local support path for:
  - `requestUserInput`
  - `mcpServer/elicitation`
  - generic structured runtime prompts outside the existing tool-approval flow
- current renderer/runtime interaction is heavily centered on:
  - `ToolApprovalRequest`
  - approval sheet
  - pending approval rows
  rather than on a generalized runtime prompt/response surface
- this means a Codex-native lane cannot honestly assume that all provider-native interactive requests can already be surfaced just because approval UX exists

Important consequence:

- phase 1 cannot claim full Codex-native interactive parity if the chosen seam can emit `requestUserInput` or MCP elicitation but the app only understands tool approvals
- `codex-native` rollout needs an explicit contract for whether phase 1:
  - supports these prompts end-to-end
  - blocks them with a clear limitation
  - or keeps the lane limited until a truthful UI path exists
- without that rule, turns can stall or degrade silently when runtime asks for structured input the app cannot surface

### 35. `codex exec` and the current TypeScript SDK are headless seams with explicit interactive capability limits

Current execution-seam capability differs sharply between official Codex app-server and the current `codex exec` / TypeScript SDK seam:

- official docs and sources in:
  - `https://developers.openai.com/codex/sdk`
  - `https://developers.openai.com/codex/noninteractive`
  - `/tmp/openai-codex/sdk/typescript/src/thread.ts`
  - `/tmp/openai-codex/sdk/typescript/src/events.ts`
  - `/tmp/openai-codex/sdk/typescript/src/exec.ts`
  - `/tmp/openai-codex/codex-rs/exec/src/lib.rs`
- richer app-server control-plane docs in:
  - `https://developers.openai.com/codex/app-server`
  - `/tmp/openai-codex/codex-rs/app-server/README.md`

Important current-code and current-doc facts:

- official docs position the TypeScript SDK as the application embedding seam, but the current SDK still wraps local `codex exec`
- the current TypeScript SDK input surface is narrow:
  - `text`
  - `local_image`
- the current TypeScript SDK streamed event surface is also narrow:
  - `thread.started`
  - `turn.started`
  - `turn.completed`
  - `turn.failed`
  - `item.started`
  - `item.updated`
  - `item.completed`
  - `error`
- raw `codex exec` source explicitly rejects several server-request flows in exec mode rather than surfacing them for the host app to resolve:
  - command execution approval
  - file change approval
  - `request_user_input`
  - dynamic tool calls
  - `apply_patch` approval
  - exec command approval
  - permissions approval
  - ChatGPT auth-token refresh
- this means the current exec/SDK seam is not simply “the same as app-server, but easier”
- it is a more headless seam with an explicitly smaller interactive/control surface

Important consequence:

- phase 1 cannot honestly treat raw `codex exec` or the current TypeScript SDK as approval-parity or full interactive-parity seams
- if phase 1 uses raw exec or the current SDK, the lane needs an explicit capability contract for what is:
  - supported end-to-end
  - automatically rejected by the runtime seam
  - unsupported in the app because the seam never exposes it
- without that rule, the rollout can quietly overclaim:
  - manual approvals
  - generic runtime prompts
  - MCP elicitation
  - dynamic tool behavior
  even though the actual execution seam is headless-limited

### 36. `--ephemeral` avoids durable session ownership but also disables exec's final turn-item backfill

Current session-ownership safety and transcript-completeness tradeoffs differ between raw `codex exec` modes:

- raw `codex exec` sources in:
  - `/tmp/openai-codex/codex-rs/exec/src/lib.rs`
- official app-server and non-interactive docs in:
  - `https://developers.openai.com/codex/app-server`
  - `https://developers.openai.com/codex/noninteractive`

Important current-code and current-doc facts:

- raw `codex exec` can run with `--ephemeral`, which avoids durable Codex-owned session storage
- the current TypeScript SDK does not expose the same `ephemeral` control directly
- app-server docs and schemas already note that `turn/completed` can arrive with empty `turn.items`
- raw exec compensates for that in non-ephemeral mode by doing one last `thread/read` and backfilling completed-turn items before shutdown
- raw exec explicitly skips that backfill path when the thread is ephemeral
- this means `--ephemeral` is not a free safety win:
  - it reduces durable session ownership
  - but it also removes one built-in completed-turn recovery path

Important consequence:

- phase 0 cannot choose `--ephemeral` only because it feels safer around session ownership
- it also has to decide how completed-turn item completeness will be recovered for:
  - transcript projection
  - final assistant message capture
  - post-turn exact-log/task-log reads
  - replay/history hydration
- without that rule, the rollout can easily become “session-safer but history-weaker” in a way that only shows up after live demos succeed

### 37. Current Codex API-key routing in our app does not match the native exec/SDK auth surface automatically

Current Codex credential-routing semantics already differ between our old app/backend path and the real Codex exec/SDK seam:

- current app/runtime code in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/ProviderConnectionService.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/providerAwareCliEnv.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/providerRuntimeEnv.ts`
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/runtimeBackends/codexBackendResolver.ts`
- official Codex docs and SDK sources in:
  - `https://developers.openai.com/codex/noninteractive`
  - `/tmp/openai-codex/sdk/typescript/src/exec.ts`
  - `/tmp/openai-codex/sdk/typescript/README.md`

Important current-code and current-doc facts:

- our current app-side Codex API-key mode is built around:
  - `OPENAI_API_KEY`
  - `CLAUDE_CODE_CODEX_BACKEND=api`
  - existing old-lane `api` / `adapter` backend routing
- current connection-info, issue detection, and source labeling for Codex API keys also inspect `OPENAI_API_KEY`, not `CODEX_API_KEY`
- official non-interactive Codex docs say `CODEX_API_KEY` is supported in `codex exec`
- the current TypeScript SDK explicitly injects `CODEX_API_KEY` when the `apiKey` option is provided
- this means the real Codex exec/SDK seam does not automatically share the same credential surface as our old Responses-API-backed Codex lane
- a `codex-native` rollout therefore needs more than “backend id decoupling”
- it also needs an explicit credential-routing contract for how:
  - stored keys
  - env vars
  - connection-issue messages
  - readiness checks
  - runtime status copy
  map onto the selected lane

Important consequence:

- phase 1 cannot assume that old `OPENAI_API_KEY`-based Codex API-key truth automatically authenticates the native exec/SDK lane
- if the chosen lane is raw exec or the current SDK, the rollout needs an explicit rule for whether the host:
  - passes `CODEX_API_KEY`
  - calls the SDK with `apiKey`
  - or uses some later app-server login surface
- without that rule, UI/status can say “Codex API key ready” while the actual selected lane still starts with the wrong credential shape

### 38. Current Codex model inventory, disabled-model heuristics, and probe flow are still largely static/provider-wide

Current model-selection and model-verification truth already differs between our app and the richer native Codex model surface:

- current app/runtime code in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/CliProviderModelAvailabilityService.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/providerModelProbe.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/utils/teamModelCatalog.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/utils/providerModelVisibility.ts`
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/utils/model/codex.ts`
- richer native Codex model surface in:
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/Model.ts`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ModelListParams.ts`

Important current-code and current-doc facts:

- current Codex model inventory is mostly static:
  - hardcoded model ids in orchestrator/runtime helpers
  - hardcoded team model catalog options
  - hardcoded UI-disabled Codex models and reasons
- current provider model verification is also CLI-shaped and provider-wide:
  - probe prompt is fixed
  - probe args are generic
  - preflight default for Codex is hardcoded to `gpt-5.4-mini`
- official native Codex model surface is richer and more dynamic:
  - `model/list`
  - `includeHidden`
  - `supportedReasoningEfforts`
  - `defaultReasoningEffort`
  - `inputModalities`
  - `additionalSpeedTiers`
  - `availabilityNux`
  - optional upgrade metadata
- this means `codex-native` cannot safely inherit the old assumption that “Codex models are just this fixed provider-wide list plus a few static UI-disabled rules”

Important consequence:

- phase 1 cannot assume that old Codex model inventory, disabled-model reasons, and probe defaults still describe the native lane honestly
- if `codex-native` is added without a lane-aware model contract, we can get:
  - wrong available model lists
  - wrong disabled badges/reasons
  - wrong reasoning-effort choices
  - wrong default/preflight model assumptions
  - stale provider-wide heuristics standing in for native-lane truth
- without that rule, create/launch dialogs, runtime settings, provisioning hints, and model verification can all stay internally consistent while still being wrong about what the native lane really supports

### 39. Native Codex thread start/resume has trust semantics that do not match our current host-owned workspace-trust boundary automatically

Current workspace-trust ownership in our orchestrator/app is explicit and host-controlled:

- current host trust boundary code in:
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/utils/config.ts`
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/interactiveHelpers.tsx`
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/main.tsx`
- current native Codex start flow/docs in:
  - `/tmp/openai-codex/codex-rs/exec/src/lib.rs`
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts`

Important current-code and current-doc facts:

- our current orchestrator trust model is explicit:
  - `checkHasTrustDialogAccepted()` gates trust
  - interactive sessions show a trust dialog
  - hooks, LSP, MCP-prefetch, and full env application are deferred until trust is accepted
- current raw `codex exec` uses its own gate:
  - it exits when not inside a trusted directory unless `--skip-git-repo-check` or bypass mode is used
  - that is not the same contract as our persisted host trust-dialog acceptance
- current Codex app-server docs explicitly say:
  - `thread/start` with `cwd` and resolved sandbox `workspace-write` or full access also marks that project as trusted in user `config.toml`
- this means native Codex start/resume can carry trust side effects or trust assumptions that do not line up with our existing host-owned trust boundary by default

Important consequence:

- phase 1 cannot assume native Codex trust semantics are equivalent to our host trust dialog
- if `codex-native` launches a thread in a writable/full-access mode, we must explicitly decide:
  - whether host trust remains the only authority
  - whether native trust writes are allowed at all
  - whether native trust writes are allowed only after host trust is already accepted
- without that rule, the rollout can silently:
  - mutate persistent trust state behind the host's back
  - bypass trust-gated env/hook/LSP behavior
  - or conflate Codex repo-check semantics with our actual workspace-trust semantics

### 40. Codex collaboration-mode and instruction channels can override or duplicate our current system/bootstrap instruction ownership

Current instruction ownership in our codebase is already layered and load-bearing:

- current host/system prompt assembly in:
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/utils/systemPrompt.ts`
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/screens/REPL.tsx`
- current team-bootstrap/runtime copy expectations in:
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/teamBootstrap/teamBootstrapMemberBriefingGuard.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/utils/bootstrapPromptSanitizer.ts`
- native Codex instruction surfaces in:
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/CollaborationMode.ts`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/Settings.ts`
  - `/tmp/openai-codex/codex-rs/app-server/README.md`

Important current-code and current-doc facts:

- our orchestrator already has a strict system-prompt layering model:
  - override prompt
  - coordinator/agent prompt
  - custom/default prompt
  - append prompt
- team bootstrap and UI sanitization rely on specific instruction text staying present and not being silently replaced
- native Codex exposes multiple instruction channels:
  - `baseInstructions`
  - `developerInstructions`
  - `collaborationMode`
- native Codex docs/schema explicitly state:
  - `collaborationMode` takes precedence over model, reasoning effort, and developer instructions
  - `collaborationMode.settings.developer_instructions: null` means “use built-in instructions for the selected mode”
  - `collaborationMode/list` omits built-in developer instructions from the response

Important consequence:

- phase 1 cannot treat collaboration mode as an innocuous cosmetic preset
- we must explicitly decide who owns instruction truth for `codex-native`:
  - host system/bootstrap prompt assembly
  - native `baseInstructions` / `developerInstructions`
  - collaboration-mode built-ins
- without that rule, the rollout can silently:
  - duplicate instructions
  - lose bootstrap-critical guidance
  - override host-selected model/effort/instruction semantics
  - or make UI/runtime behavior drift because built-in Codex instructions are active even though app surfaces cannot inspect them directly

### 41. Rich replayable native-thread history depends on an explicit `persistExtendedHistory` policy and that choice is not retroactive

Current replay/exact-log correctness in our app already depends on persisted and hydrated history, not just live turn streams:

- current replay/exact-log consumers in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/parsing/SessionParser.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/discovery/TeamTranscriptSourceLocator.ts`
- native Codex history controls in:
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts`

Important current-doc facts:

- native Codex `thread/start`, `thread/resume`, and `thread/fork` accept `persistExtendedHistory: true`
- Codex docs describe this as the way to persist a richer subset of history needed for less-lossy later `thread/read`, `thread/resume`, and `thread/fork`
- Codex docs also explicitly say this does not backfill events that were not persisted previously
- that means history completeness is partly decided when the thread is created/resumed/forked, not only later when UI asks to hydrate it

Important consequence:

- phase 1 cannot treat persisted-history richness as a later optimization toggle
- we must explicitly decide:
  - whether native threads start with `persistExtendedHistory: true`
  - whether some lanes/operations stay lossy by design
  - how replay/exact-log/UI truth marks threads whose history can never be fully hydrated later
- without that rule, the rollout can silently create mixed native-thread populations where:
  - some threads hydrate richly
  - some threads stay permanently lossy
  - and replay/exact-log code cannot tell the difference honestly

### 42. Native Codex app-server exposes process-wide config, feature, and marketplace mutation surfaces that do not match our current host-owned settings model automatically

Current app-side runtime/config ownership is host-managed:

- current host-owned app config in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/infrastructure/ConfigManager.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/ProviderRuntimeSettingsDialog.tsx`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/ipc/configValidation.ts`
- native Codex app-server config/state mutation surfaces in:
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/Config.ts`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ProfileV2.ts`

Important current-doc facts:

- `experimentalFeature/enablement/set` patches in-memory process-wide feature enablement
- `marketplace/add` persists remote marketplace config into user marketplace state
- `config/value/write` and `config/batchWrite` write to user `config.toml`
- `config/mcpServer/reload` can hot-reload loaded threads after disk config edits
- native config surface also includes:
  - `profile`
  - `profiles`
  - `developer_instructions`
  - `approvals_reviewer`
  - other user-config-layer fields

Important consequence:

- phase 1 cannot treat native config/feature/marketplace mutation as harmless helper APIs
- if later selective app-server enrichment is used, we must explicitly decide whether these surfaces are:
  - forbidden in phase 1
  - mirrored into host-owned config/state
  - or allowed only through one explicit host-controlled bridge
- without that rule, the rollout can silently:
  - mutate user/global native config outside app settings
  - enable plugins/apps process-wide for unrelated threads
  - persist marketplaces or feature flags the host never represented
  - or split truth between host-managed config and native process-wide config

### 43. Detached native review threads create secondary thread identities that do not map automatically onto our current launch/chain/review surfaces

Current app and transcript surfaces already carry their own session/thread identity expectations:

- current team/runtime identity surfaces in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/utils/providerSlashCommands.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/discovery/TeamTranscriptSourceLocator.ts`
- native Codex detached review flow in:
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ReviewStartParams.ts`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ReviewStartResponse.ts`

Important current-code and current-doc facts:

- our UI already suggests Codex `/review` affordance in `providerSlashCommands.ts`
- native `review/start` can run:
  - `inline` on the current thread
  - or `detached` on a new review thread
- for detached review:
  - `reviewThreadId` differs from the original `threadId`
  - the server emits a new `thread/started` notification for the review thread
  - review-mode items stream on that new thread identity

Important consequence:

- phase 1 cannot treat native review as “just another turn on the same conversation” unless we explicitly force inline-only behavior
- we must explicitly decide whether phase 1:
  - disables native review affordances
  - supports inline review only
  - or supports detached review with explicit child-thread/sidechain mapping
- without that rule, the rollout can silently:
  - create second native threads the app never modeled
  - lose review-thread identity in replay/logs
  - or make `/review` appear supported while detached review semantics are still unmapped

### 44. `codex-native` backend identity alone is not enough to represent native binary-version, protocol-surface, or experimental-surface truth

Current app-side runtime/backend truth is still mostly keyed on backend ids and coarse diagnostics:

- shared runtime/backend status shapes in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/types/cliInstaller.ts`
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/runtimeBackends/types.ts`
- current backend selector/runtime summary surfaces in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/ProviderRuntimeBackendSelector.tsx`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/runtime/ProviderRuntimeSettingsDialog.tsx`
- current model-verification cache signature in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/CliProviderModelAvailabilityService.ts`
- native Codex binary/protocol reality in:
  - `/tmp/openai-codex/sdk/typescript/src/exec.ts`
  - `/tmp/openai-codex/codex-rs/app-server/README.md`

Important current-code and current-doc facts:

- current shared provider/runtime status does **not** carry:
  - native executable source
  - native Codex binary version
  - native protocol/capability revision
  - stable-vs-experimental protocol surface truth
- current SDK exec path can resolve Codex from:
  - platform-specific bundled npm packages
  - an explicit executable path
  - not necessarily the user's detected external `codex` binary
- app-server schema generation is explicitly version-specific
- app-server stable and experimental schemas differ, and experimental surface requires explicit opt-in
- current UI selectors/settings mostly treat `selectedBackendId` / `resolvedBackendId` as enough backend identity for user-facing truth
- current model-verification signature is backend-aware, but it is not native-binary-version-aware or native-protocol-surface-aware

Important consequence:

- phase 1 cannot treat `codex-native` backend id alone as the full source of capability truth
- we must explicitly decide whether native lane status/probes/cache identity surface:
  - executable source
  - native binary version
  - protocol/capability revision
  - stable-vs-experimental surface truth where relevant
- without that rule, the rollout can silently:
  - claim one universal `codex-native` capability story across different machines
  - reuse stale readiness/model/probe truth across version-skewed native binaries
  - or let packaged dependency upgrades change native capabilities without the app noticing

### 45. App-server capability surface and live notification truth are negotiated per connection, not globally

Current app-server protocol behavior is explicitly connection-scoped:

- upstream protocol/connection docs in:
  - `https://developers.openai.com/codex/app-server`
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
- current host app already has multiple truth-ingestion paths in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/index.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/ClaudeMultimodelBridgeService.ts`

Important current-doc facts:

- `experimentalApi` is negotiated once during `initialize` and fixed for that connection lifetime
- `optOutNotificationMethods` is also per connection and exact-match only
- `thread/unsubscribe` is connection-scoped
- event subscriptions and live notifications are therefore connection-scoped, not global process truth
- some typed notifications and fields can be absent purely because that connection did not opt in or opted out, not because the runtime feature itself is absent

Important consequence:

- if later selective app-server enrichment uses more than one connection profile, phase 1 cannot assume they all see the same capability surface or the same live event stream
- we must explicitly decide whether any future app-server use has:
  - one canonical connection profile
  - one canonical `experimentalApi` policy
  - one canonical notification-subscription policy
- without that rule, the rollout can silently:
  - see different fields/methods on different connections
  - lose live notifications on one path while another still thinks the lane is healthy
  - or misdiagnose missing notifications as runtime failure instead of connection-policy drift

### 46. Native Codex history mutation semantics do not match our mostly append-only transcript and log-processing assumptions automatically

Current host transcript/log plumbing already leans on append-only and compaction-boundary semantics:

- append-only and compaction-aware transcript/log plumbing in:
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/hooks/useLogMessages.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/infrastructure/FileWatcher.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/discovery/TeamTranscriptSourceLocator.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/parsing/SessionParser.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamProvisioningService.ts`
- current orchestrator compaction semantics in:
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/remote/sdkMessageAdapter.ts`
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/utils/sessionStorage.ts`
- native Codex mutation surfaces in:
  - `/tmp/openai-codex/codex-rs/app-server/README.md`

Important current-code and current-doc facts:

- our current watcher/parser stack has explicit append-only optimizations:
  - last processed line counts
  - last processed file size
  - incremental tail parsing
- our current orchestrator already models compaction through explicit `compact_boundary` semantics instead of pretending the full file is immutable context forever
- native Codex app-server exposes history mutation operations that are stronger than “append more events”:
  - `thread/compact/start`
  - `thread/rollback`
- `thread/rollback` explicitly prunes the last turns from future resumes and persists a rollback marker
- `thread/compact/start` changes model-visible history and streams progress while the canonical stored thread can later differ from what a pure append-only local event cache assumed

Important consequence:

- phase 1 cannot assume native canonical history is merely append-only-plus-hydration
- we must explicitly decide whether replay/exact-log/task-log truth is sourced from:
  - append-only projected transcript
  - canonical native thread history after rollback/compaction
  - or one reconciliation rule between the two
- without that rule, the rollout can silently:
  - keep stale pre-rollback activity visible in append-only local logs
  - read cached append-only tails as if they still matched canonical native history
  - or let compaction/rollback mutate replay truth without exact-log/task-log knowing which source is authoritative

### 47. Native turn metadata truth for usage, model, reasoning effort, reroute, and plan does not map cleanly to our current assistant-message-centric assumptions

Current host context/status/transcript plumbing still leans heavily on assistant-message-local usage/model truth:

- current host usage/model/context surfaces in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/TeamDetailView.tsx`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamProvisioningService.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/utils/jsonl.ts`
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/utils/analyzeContext.ts`
  - `/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- native Codex notification and metadata surfaces in:
  - `https://developers.openai.com/codex/app-server`
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/src/protocol/v2.rs`
  - `/tmp/openai-codex/codex-rs/app-server/src/codex_message_processor/token_usage_replay.rs`
  - `/tmp/openai-codex/sdk/typescript/src/events.ts`
  - `/tmp/openai-codex/sdk/typescript/src/thread.ts`

Important current-code and current-doc facts:

- `TeamDetailView` currently derives context metrics from:
  - `lastAssistantUsage`
  - `lastAssistantModelName`
- `TeamProvisioningService` currently updates lead context usage from:
  - `messageObj.usage`
  - `messageObj.model`
  - and a narrow fallback through `result.modelUsage.contextWindow`
- `jsonl.ts` currently persists assistant `usage` and `model` on transcript rows and deduplicates streaming rows by `requestId`
- `analyzeContext.ts` explicitly uses current message-level API usage as the same source of truth as the status line
- app-server docs explicitly say token usage streams separately via `thread/tokenUsage/updated`
- app-server docs explicitly say `thread/resume` and `thread/fork` emit restored token usage immediately after the response so clients can render usage before the next turn starts
- app-server docs explicitly say resume uses persisted `model` and `reasoningEffort` unless explicit overrides disable that fallback
- app-server docs explicitly expose turn-level metadata outside assistant transcript rows:
  - `turn/plan/updated`
  - `turn/diff/updated`
  - `model/rerouted`
- app-server docs explicitly say current `turn/*` notifications still carry empty `items` arrays and clients should rely on `item/*` for canonical item lists
- current TypeScript SDK/raw-exec seam is narrower:
  - `turn.completed` exposes usage
  - completed `agent_message` items expose final response text
  - but there is no app-server-grade typed surface for `thread/tokenUsage/updated`, `turn/plan/updated`, or `model/rerouted`

Important consequence:

- phase 1 cannot assume native turn truth lives on the last assistant transcript row the way current Anthropic-shaped flows often do
- we must explicitly decide the authoritative source for:
  - live token usage
  - restored token usage after resume/fork/reload
  - context-window truth
  - final model and reasoning-effort truth after reroute or persisted-resume fallback
  - plan/diff/reroute metadata
- without that rule, the rollout can silently:
  - under-report or lose native usage after resume/fork/reload
  - compute context-window warnings from stale or guessed assistant-row usage
  - keep showing the configured model when the native lane rerouted or resumed with persisted model/effort truth
  - lose turn-plan/diff/reroute truth while transcript and status surfaces still look “complete”

### 48. Native thread-local defaults can drift from host launch intent, while our team/runtime surfaces still mostly assume provider/model/effort are launch-owned and stable

Current host launch, persistence, and runtime-summary surfaces still mostly treat provider/model/effort as launch-owned runtime identity:

- current host launch/persistence/runtime surfaces in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/shared/types/team.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/slices/teamSlice.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamProvisioningService.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/utils/memberRuntimeSummary.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/utils/bootstrapPromptSanitizer.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamBackupService.ts`
- native Codex thread-default and persisted-runtime surfaces in:
  - `https://developers.openai.com/codex/app-server`
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/src/protocol/v2.rs`
  - `/tmp/openai-codex/codex-rs/state/src/extract.rs`
  - `/tmp/openai-codex/sdk/typescript/src/thread.ts`

Important current-code and current-doc facts:

- `TeamLaunchRequest`, `TeamCreateRequest`, and renderer-side `TeamLaunchParams` currently persist:
  - `providerId`
  - `model`
  - `effort`
  but no richer native thread-default identity
- `TeamProvisioningService.shouldSkipResumeForProviderRuntimeChange(...)` currently compares provider and model, but not effort or richer native thread-default drift
- `TeamProvisioningService.applyEffectiveLaunchStateToConfig(...)` writes effective lead/member provider, model, and effort back into config-owned truth
- `memberRuntimeSummary.ts` and `bootstrapPromptSanitizer.ts` still derive most runtime copy from configured provider/model/effort plus best-effort runtime-model hints, not from native thread-default authority
- `TeamBackupService`, `members.meta.json`, relaunch prefill, and draft replay paths still preserve provider/model/effort intent, not the richer native thread-default state a resumed thread may actually inherit
- official app-server docs explicitly say config overrides on `turn/start` become the default for subsequent turns on the same thread
- official app-server docs explicitly say `thread/resume` uses the latest persisted `model` and `reasoningEffort` by default unless explicit overrides disable that fallback
- official app-server docs explicitly say resuming with a different model emits a warning and applies a one-time model-switch instruction on the next turn
- official app-server docs explicitly say `dynamicTools` persisted on `thread/start` are restored on `thread/resume` when you do not provide new dynamic tools
- upstream state extraction tests explicitly show:
  - `TurnContext` sets persisted `model` and `reasoning_effort`
  - `SessionMeta` does not

Important consequence:

- phase 1 cannot treat host launch params, `team.meta.json`, local-storage launch params, or config-owned provider/model/effort as automatically equal to the live native thread-defaults after resumed or overridden native turns
- we must explicitly decide the authoritative source for:
  - launch intent
  - current native thread-defaults
  - resume behavior when launch intent and persisted native defaults diverge
  - warning/copy truth when resume preserves old defaults or applies a one-time model switch
- without that rule, the rollout can silently:
  - resume a native thread on persisted model/effort while UI still shows the newer launch intent as if it were live runtime truth
  - overwrite config/meta/summary truth with launch-owned values that never matched the resumed native thread defaults
  - skip or allow resume based on provider/model only while effort or other thread-default drift still changes behavior materially
  - make relaunch/retry/restore look like “the same team runtime” even though native thread-local defaults have already diverged from saved host intent

### 49. Native thread-status and warning truth does not map cleanly to our current process and provisioning status assumptions

Current host runtime and team-status surfaces still mostly describe liveness and readiness through process, provisioning, and probe truth:

- current host status and warning surfaces in:
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/team/TeamProvisioningService.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/store/slices/teamSlice.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/team/TeamDetailView.tsx`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/main/services/runtime/ClaudeMultimodelBridgeService.ts`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/dashboard/CliStatusBanner.tsx`
  - `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/src/renderer/components/settings/CliStatusSection.tsx`
- native Codex thread-status and warning surfaces in:
  - `https://developers.openai.com/codex/app-server`
  - `/tmp/openai-codex/codex-rs/app-server/README.md`
  - `/tmp/openai-codex/codex-rs/app-server-protocol/src/protocol/v2.rs`
  - `/tmp/openai-codex/codex-rs/app-server/src/thread_status.rs`
  - `/tmp/openai-codex/codex-rs/app-server/src/codex_message_processor.rs`
  - `/tmp/openai-codex/codex-rs/exec/src/event_processor_with_jsonl_output.rs`

Important current-code and current-doc facts:

- `TeamProvisioningService` and `teamSlice` currently center around:
  - provisioning run state
  - `runtimeAlive`
  - lead activity
  - probe warnings
  - runtime snapshot presence
  more than native thread lifecycle truth
- current dashboard/settings runtime status surfaces are mostly provider-global, while native Codex `thread.status` is thread-scoped
- official app-server docs explicitly say:
  - `thread/started` already carries the current `thread.status`
  - `thread/status/changed` is emitted whenever a loaded thread's status changes
  - status can be `notLoaded`, `idle`, `systemError`, or `active` with `activeFlags`
  - `thread/unsubscribe` can later emit `thread/closed` and a `thread/status/changed` transition back to `notLoaded`
  - generic runtime warnings use `warning { threadId?, message }`
  - startup/config diagnostics use `configWarning { summary, details?, path?, range? }`
- upstream app-server code has dedicated thread-status resolution and watch machinery instead of deriving thread truth only from process liveness
- raw exec also has warning events, but they are not equivalent to app-server's typed `thread.status` lifecycle

Important consequence:

- phase 1 cannot treat host process liveness, provisioning progress, runtime snapshot presence, or probe warnings as automatically equivalent to native thread health or loaded-state truth
- phase 1 also cannot let provider-global Codex status banners stand in for thread-specific health truth once multiple native threads can be loaded, resumed, degraded, or closed independently
- we must explicitly decide the authoritative source for:
  - thread loaded/notLoaded truth
  - active/idle/systemError truth
  - thread-scoped runtime warnings
  - config/startup warnings that are not tied to one active turn
- without that rule, the rollout can silently:
  - show a team or runtime as healthy because the process is alive while the native thread is already in `systemError`
  - keep showing a thread as active/available after it has become `notLoaded` due to unsubscribe or inactivity
  - drop thread-scoped warnings because they are not attached to assistant transcript rows or provisioning probes
  - conflate config warnings, runtime warnings, and process warnings into one coarse status banner that cannot explain what is actually wrong

## What We Learned

After deep code and docs analysis, the most important conclusions are:

1. `@openai/codex-sdk` and `codex exec --json` are the real official execution seam for embedded Codex runtime usage.
2. `codex exec` supports API-key mode, so API-key mode itself is not the blocker.
3. `Codex` native plugins, apps, skills, and MCP are part of the real Codex runtime flow.
4. Our current `agent_teams_orchestrator` query loop is deeply coupled to Anthropic-style events and tool semantics.
5. A full drop-in swap from the current Codex adapter to `@openai/codex-sdk / codex exec` would not be a safe transport-only change. It would change runtime semantics.
6. `plugin-kit-ai` is a good fit for plugin management and native plugin placement.
7. `codex app-server` is promising for richer control-plane features, but should not be the foundation of the first production rollout for plugin management.
8. Backend ids already cross repo boundaries, so `codex-native` must be introduced as an additive shared contract, not a hidden orchestrator-only detail.
9. Transcript compatibility depends on enriched linkage fields like `requestId`, `sourceToolUseID`, and `toolUseResult`, not just on entry labels.
10. `@openai/codex-sdk` currently does not expose the same persistence control as raw `codex exec --ephemeral`, so the SDK-vs-CLI seam is a real phase-0 decision, not an implementation footnote.
11. Live approval and activity UX already depends on stable request-correlation semantics, so request identity cannot be treated as incidental metadata.
12. Transcript chain and sidechain identity are already load-bearing semantics for team logs, grouping, and subagent linking, so phase 1 cannot treat them as optional metadata.
13. Codex runtime settings, provisioning summaries, installer status, and model verification already depend on backend-specific runtime status fields, so `codex-native` needs an explicit settings/probe contract from day one.
14. Approval UX is currently grounded in specific `control_request` / `permission_request` semantics, so Codex-native must either adapt truthfully into that contract or stay limited in phase 1.
15. Codex auth-mode configuration currently rewrites backend env directly, so `codex-native` needs an explicit rule for decoupling authentication choice from execution-lane choice.
16. App config validation and team launch contracts currently lag behind backend-lane truth, so `codex-native` needs an explicit config-schema and launch-granularity decision instead of being smuggled in as a hidden runtime-only option.
17. Current team launch plumbing suggests Codex backend routing is process-scoped rather than member-scoped, so phase 1 must not imply mixed Codex backend lanes inside one launched runtime unless launch contracts are explicitly expanded.
18. Provisioning probe caching is currently provider-scoped and long-lived, so backend/auth changes can leave stale readiness truth unless cache identity and invalidation become backend-aware.
19. External Codex CLI detection is already surfaced through runtime status and installer snapshots, and an SDK-based lane may resolve its binary from bundled `@openai/codex` packages instead of the user's external CLI, so the rollout must keep “binary detected” separate from “Codex-native lane ready”.
20. Runtime backend status already distinguishes `selectable` from `available`, but current UI mostly treats backend options as one-dimensional availability, so `codex-native` needs explicit option-state semantics.
21. Main-process status bridging still has a legacy fallback that drops backend-rich truth, so `codex-native` needs an explicit degraded-status contract instead of silently collapsing to provider-only status on transient runtime-status failures.
22. Current Codex UI summary/copy still derives “runtime” mostly from auth method and connection mode, so `codex-native` needs explicit lane-aware wording instead of inheriting the old subscription/API-key phrasing.
23. Runtime status already has two renderer write paths, and the progressive snapshot path bypasses request epoch/loading reconciliation, so `codex-native` needs an explicit in-flight/degraded snapshot contract instead of trusting last-writer-wins store mutation.
24. Extension preflight and action gating still depend on coarse runtime/provider truth, so `codex-native` needs backend-lane-aware mutation gating instead of inheriting today's one-dimensional plugin-support checks.
25. Team model selectors and provisioning diagnostics still narrow runtime truth down to a provider-wide shape, so `codex-native` needs an explicit lane-aware team-model contract instead of relying on old Codex heuristics.
26. Provisioning prepare-cache reuse still keys off backend summary display text, so `codex-native` needs canonical backend-aware cache identity instead of copy-coupled cache semantics.
27. Persisted team identity, relaunch prefill, draft replay, backup/restore, runtime snapshots, and resume guards are still lane-agnostic, so `codex-native` needs an explicit persisted-vs-inherited backend identity contract instead of silently following whatever global Codex backend is current at replay time.
28. Team summaries, list surfaces, and synthetic provisioning cards are still lane-blind, so `codex-native` needs an explicit summary-surface contract instead of assuming lane truth can stay hidden below detail views.
29. Member runtime summaries, bootstrap copy, and composer capability suggestions are still provider-wide, so `codex-native` needs an explicit member/composer contract instead of assuming lane-sensitive copy or slash-command affordances can safely keep keying off `providerId === 'codex'`.
30. Plugin install success, current-session activation, new-thread visibility, restart requirements, and app-auth completion are still too conflated in current extension UX, so `codex-native` needs an explicit installed-vs-active-vs-usable contract before plugin support can be advertised safely.
31. Structured plugin/app targeting is richer in Codex app-server than in the current SDK/exec embedding seam, so `codex-native` needs an explicit phase-1 mention-targeting contract instead of silently relying on linked-text mention heuristics and then overclaiming deterministic invocation support.
32. Codex live notifications are good active-turn truth but not the same thing as hydrated thread history, and our current exact-log/task-log consumers already depend on persisted/hydrated `ParsedMessage[]`, so phase 1 needs an explicit live-stream-vs-history-hydration contract instead of treating one source as both.
33. Codex approval requests can be cleared by lifecycle events, not just by user response, so `codex-native` needs an explicit approval-resolution and cleanup contract instead of assuming our current CLI-style allow/deny flow already covers pending-state truth.
34. Codex can also request generic user input and MCP elicitation, while our current app only has a truthful path for tool approvals, so `codex-native` needs an explicit interactive-request support contract instead of quietly assuming approval UX covers all provider-native prompts.
35. Raw `codex exec` and the current TypeScript SDK are headless seams with explicit interactive capability limits, so phase 1 cannot quietly market them as approval-parity or app-server-parity execution paths.
36. `--ephemeral` reduces durable Codex session ownership, but it also disables exec's final completed-turn `thread/read` backfill, so session-safety and history-completeness must be chosen together rather than optimized independently.
37. Current app-side Codex API-key routing is still built around `OPENAI_API_KEY` and old backend env semantics, while the real exec/SDK seam uses `CODEX_API_KEY`, so `codex-native` needs an explicit credential-routing contract instead of reusing old Codex API-key assumptions.
38. Current Codex model inventory, UI-disabled model heuristics, reasoning-effort assumptions, and probe defaults are still largely static/provider-wide, while native Codex exposes a richer model surface, so `codex-native` needs an explicit lane-aware model contract instead of inheriting old Codex model truth.
39. Native Codex start/resume has its own trust semantics, and app-server can persist project trust on thread start, so phase 1 must keep host workspace-trust ownership explicit instead of assuming native trust behavior matches our current trust dialog.
40. Codex collaboration mode and developer-instruction channels can take precedence over model/effort/instructions, so phase 1 needs one explicit instruction owner instead of letting built-in Codex instructions and our system/bootstrap prompt layers stack or race implicitly.
41. Rich replayable native-thread history depends on opting into `persistExtendedHistory` at thread birth/resume/fork and that choice is not retroactive, so phase 1 needs an explicit persisted-history policy instead of treating history completeness as a later tune-up.
42. Native app-server config, feature, and marketplace mutation surfaces are process-wide or persistent by default, so selective app-server enrichment needs an explicit host-owned config bridge instead of letting native state mutate behind app settings.
43. Native detached review can create a second thread id and emit its own `thread/started`, so phase 1 needs an explicit review-thread identity policy instead of assuming `/review` always stays on the current conversation.
44. `codex-native` backend id alone is not enough to represent native binary-version, protocol-surface, or experimental-surface truth, so phase 1 needs an explicit native runtime identity contract instead of assuming one lane id means one stable capability set everywhere.
45. App-server capability surface and live notification truth are negotiated per connection, not globally, so later selective app-server enrichment needs one canonical connection policy instead of assuming every connection sees the same fields, methods, and live events.
46. Native Codex history mutation semantics include rollback and compaction flows that do not match our mostly append-only transcript/log assumptions automatically, so phase 1 needs an explicit canonical-history-versus-projected-transcript contract instead of assuming append-only local logs always stay truthful.
47. Native Codex usage, model, reasoning-effort, reroute, and plan truth are not guaranteed to live on assistant transcript rows, so phase 1 needs an explicit turn-metadata authority contract instead of guessing from last-assistant usage/model and provider-wide config.
48. Native Codex thread-defaults are mutable per turn and `thread/resume` prefers persisted defaults, so host launch `provider/model/effort` is only launch intent unless the rollout explicitly forces fresh threads or explicit override semantics.
49. Native Codex thread lifecycle and warning surfaces have their own thread-scoped loaded, active, idle, system-error, and warning truth, so phase 1 needs an explicit thread-status and warning-authority contract instead of treating provider-global status, process liveness, provisioning, and probe warnings as the same thing.

## Chosen Direction

We will **not** force Codex into the current Anthropic-shaped runtime contract.

We will instead:

- add a new **internal normalized event/log layer**
- keep execution semantics provider-native where needed
- add a separate **Codex-native runtime lane**
- use `plugin-kit-ai` for plugin management and native plugin placement

In practical terms:

- current Codex path stays available as the fallback/default path at first
- real Codex runtime execution becomes a separate lane instead of a drop-in replacement
- unified logs come from normalization, not from pretending every provider has Anthropic-native runtime semantics

## Decision Summary

### We are doing this

- keep the current Codex adapter path as the fallback/default path initially
- introduce a new `Codex-native` backend lane using `@openai/codex-sdk / codex exec`
- treat the first `Codex-native` lane as capability-scoped by the chosen seam rather than assuming app-server-grade interactivity
- keep auth/model truth for the first `Codex-native` lane scoped by that same seam instead of inheriting old Codex API-key or static-model assumptions
- keep host workspace-trust ownership explicit instead of letting native thread start mutate or imply trust implicitly
- freeze one instruction owner for phase 1 instead of mixing collaboration-mode built-ins with our host system/bootstrap prompt layers
- freeze persisted-history policy at thread birth/resume so replay, exact-log, and hydrate-after-reload truth stay explicit
- introduce a normalized internal event/log format for all providers
- map Anthropic, Gemini, and future Codex-native events into that normalized format
- keep unified logging, transcript projection, analytics, and UI-facing event handling on top of the normalized layer
- use `plugin-kit-ai` for:
  - install
  - update
  - remove
  - repair
  - discover
  - catalog
  - native Codex plugin placement through native marketplace/filesystem layout

### We are not doing this

- not replacing the whole multimodel runtime in one shot
- not forcing real Codex runtime execution into fake Anthropic transport semantics
- not pretending a full `@openai/codex-sdk / codex exec` swap is a drop-in backend replacement
- not making `app-server plugin/*` the first production seam

## Phase-0 Decision Checkpoints

These must be answered explicitly before implementation starts spreading across repos.

### 1. Backend identity checkpoint

Current runtime backend ids for Codex are only:

- `auto`
- `adapter`
- `api`

That means the plan must introduce a new explicit backend lane rather than overloading existing ids.

Default:

- add a distinct `codex-native` backend id
- do not hide it behind `api` or `adapter`

### 2. Transcript ownership checkpoint

We must decide what remains the UI source of truth during migration.

Default:

- `claude_team` transcript/read-model path remains the UI source of truth
- Codex thread id is stored as provider-native continuation metadata

### 3. Capability truth checkpoint

We must decide how plugin support is reported during migration.

Default:

- support is backend-lane-specific
- old Codex path may stay `plugins: unsupported`
- `codex-native` may become `plugins: supported` only after proven real-session execution

### 4. UI migration checkpoint

We must decide whether `claude_team` consumes raw normalized events in phase 1.

Default:

- no
- phase 1 keeps current transcript/read-model UI path stable

### 5. Session resume checkpoint

We must decide whether Codex-native resume is enabled in the first rollout.

Default:

- treat resume as feature-flagged until transcript/session ownership is proven safe

### 6. Request-correlation checkpoint

We must decide what request identity guarantees the normalized layer and transcript projector must preserve.

Default:

- keep `requestId` as a first-class cross-layer correlation key for streamed assistant dedupe and approval UX
- preserve tool-linking identifiers where there is a truthful originating action
- do not downgrade these fields to best-effort metadata in phase 1

### 7. Backend-id compatibility checkpoint

We must decide how `codex-native` is introduced across shared config and UI contracts.

Default:

- add `codex-native` as a new explicit backend id in orchestrator config/runtime types
- propagate it additively through main/preload/renderer payloads
- keep existing `auto`, `adapter`, and `api` meanings stable
- do not silently repurpose `api` to mean `codex-sdk`

### 8. SDK-vs-raw-exec checkpoint

We must decide whether the first `Codex-native` lane is built on top of `@openai/codex-sdk`, raw `codex exec`, or a narrow wrapper that can choose between them.

Default:

- do not commit to SDK-only before phase 0 explicitly evaluates the `ephemeral` gap and session ownership impact
- prefer whichever seam lets us make session persistence behavior explicit instead of accidental

### 9. Runtime settings and connection-management checkpoint

We must decide whether `codex-native` remains hidden behind Codex connection mode or becomes a first-class runtime lane in settings/status/provisioning.

Default:

- do not keep the current implicit rule that all Codex runtime choice is connection-managed
- add `codex-native` as an explicit backend/status lane if it exists
- update runtime settings UI, provisioning summaries, installer snapshots, and runtime status payloads together
- do not let model verification silently reuse the old Codex probe assumptions without an explicit `codex-native` probe policy

### 10. Approval/control adaptation checkpoint

We must decide how provider-native approval/control events become current approval UX truth.

Default:

- manual approval parity is not assumed automatically for `codex-native`
- phase 0 must prove whether Codex-native can emit a truthful `ToolApprovalRequest`-compatible contract with stable `requestId`
- if that is not yet true, phase 1 keeps the lane limited instead of shipping fake approval support

### 11. Model verification checkpoint

We must decide how Codex-native participates in model verification and provisioning readiness checks.

Default:

- `codex-native` gets an explicit backend-aware probe policy and signature
- do not reuse cached availability from old Codex backend ids across the new lane
- do not treat current generic Codex provider probes as automatically valid for the new execution seam

### 12. Connection-vs-runtime env checkpoint

We must decide how Codex authentication mode and Codex execution lane interact in env construction.

Default:

- stop assuming that Codex API-key mode automatically means `CLAUDE_CODE_CODEX_BACKEND=api`
- define auth mode and runtime backend as separate inputs with an explicit resolution rule
- make `codex-native` capable of using API-key auth without being silently forced back onto the old Responses API lane

### 13. Config-schema and launch-granularity checkpoint

We must decide whether `codex-native` is selected globally per provider, per launch, or both.

Default:

- do not smuggle `codex-native` in through runtime env alone
- update app-side runtime config validation and shared runtime config types before the lane is exposed
- keep the first rollout global-per-provider unless there is a deliberate per-launch backend contract expansion
- if per-launch backend override does not exist yet, provisioning and launch UI must stay honest that backend choice is provider-global, not task-specific

### 14. Process-scope routing checkpoint

We must decide whether one launched orchestrator runtime can host more than one Codex backend lane at the same time.

Default:

- assume no mixed Codex backend lanes within one launched orchestrator process in phase 1
- treat Codex backend routing as process-scoped or runtime-global until spawn and launch contracts prove otherwise
- do not imply teammate-level or member-level Codex backend choice until launch payloads and spawn plumbing explicitly carry it

### 15. Probe-cache and preflight-truth checkpoint

We must decide how provisioning-readiness cache identity and invalidation behave when Codex backend, auth mode, or probe policy changes.

Default:

- do not keep readiness cache keyed only by `cwd + provider`
- include backend-sensitive identity or deterministically invalidate affected entries when Codex auth mode, runtime backend, Claude base path, or probe policy changes
- do not allow provider-level cached readiness to outlive a backend/auth switch while model verification already sees a new lane
- if the contract is not ready yet, bypass cached provisioning readiness for `codex-native`-related checks instead of pretending the old cache is safe

### 16. External-runtime-diagnostic checkpoint

We must decide what it means when Codex CLI is merely detected on disk versus when the `codex-native` lane is actually available and verified.

Default:

- keep external binary detection separate from backend availability and from plugin-support truth
- do not mark `codex-native` selectable or ready just because `detectExternalBinary('codex')` succeeds
- require runtime status, installer snapshots, and provisioning UI to distinguish:
  - CLI detected
  - lane selectable
  - lane resolved
  - lane authenticated
  - lane verified for execution

### 17. Backend-option-state checkpoint

We must decide how `selectable`, `available`, `resolved`, and `verified` differ for `codex-native`, and how the renderer should behave in each state.

Default:

- do not treat backend options as one boolean
- keep `selectable` and `available` as separate semantics
- allow the plan to express “user may choose this lane” separately from “this lane is authenticated and ready right now”
- update the renderer/backend-selector contract so `codex-native` does not depend on old `available === selectable` assumptions

### 18. Runtime-status fallback checkpoint

We must decide what UI/main truth should look like when backend-rich runtime status is temporarily unavailable.

Default:

- do not silently fall back from backend-rich Codex status to provider-only status without marking degradation
- preserve the last known backend-rich truth or surface an explicit degraded state instead of erasing backend ids/options entirely
- do not let transient status transport failures force Codex back into the old connection-managed-only UX model

### 19. Runtime-copy and summary checkpoint

We must decide how Codex status copy, banners, and settings summaries talk about auth choice versus execution lane once `codex-native` exists.

Default:

- do not let `Current runtime` for Codex be derived only from `authMethod` / `configuredAuthMode`
- use lane-aware summary rules whenever backend ids are available
- reserve auth-mode wording for connection method, not for execution-lane truth
- update dashboard/settings summary helpers together with backend-lane rollout

### 20. Progressive-status and snapshot-reconciliation checkpoint

We must decide how progressive status snapshots, cached `getStatus()` responses, and provider-specific refreshes reconcile in renderer/store once backend-rich Codex truth matters.

Default:

- do not keep a silent last-writer-wins contract for `cliStatus`
- define explicit semantics for:
  - in-flight partial snapshot
  - settled status truth
  - degraded transport truth
- require progressive status pushes to preserve enough sequencing/settledness information that older partial snapshots cannot silently overwrite fresher provider/backend truth
- keep renderer loading/error/request-sequencing state aligned with whichever status transport path is allowed to mutate `cliStatus`

### 21. Extension-preflight and action-gating checkpoint

We must decide how backend-lane truth becomes extension-action truth once Codex plugin support depends on `codex-native`, not on provider id alone.

Default:

- do not gate plugin management only on coarse `cliStatusLoading`, provider auth, or provider-wide mutable capability truth
- define backend-aware preflight semantics for:
  - old Codex lane
  - `codex-native` selectable-but-unverified
  - degraded runtime-status truth
  - backend-specific plugin capability support
- require extension store banners, install buttons, and mutation preflight to use the same lane-aware truth model

### 22. Team-model and provisioning-runtime checkpoint

We must decide what runtime shape team model selectors and provisioning diagnostics are allowed to rely on once Codex has more than one meaningful backend lane.

Default:

- do not keep team model/runtime helpers narrowed to provider-wide auth/backend summary truth
- extend the shared runtime shape used by team model selectors so lane-specific model visibility, selection errors, and provisioning notes can depend on canonical backend identity
- require create/launch dialogs, team model selectors, and provisioning diagnostics to speak the same lane-aware runtime vocabulary

### 23. Provisioning-prepare cache-identity checkpoint

We must decide what canonical identity keys reusable provider prepare/model results once backend-lane truth matters.

Default:

- do not key provisioning prepare/model cache by backend summary display text
- key it by canonical backend/auth/probe identity instead
- keep cache correctness independent from UI copy and summary-label changes

### 24. Persisted-team-identity and replay-identity checkpoint

We must decide whether team launch/relaunch/resume, draft-team persistence, and backup/restore persist Codex backend lane identity or explicitly inherit the current global Codex backend at replay time.

Default:

- do not keep launch persistence provider/model-only when backend lane materially changes runtime semantics
- do not keep `team.meta.json`, `members.meta.json`, or shared team runtime snapshots provider/model-only when backend lane materially changes runtime semantics
- do not let backup/restore silently re-materialize a team without backend-lane truth if the restored runtime semantics would differ by lane
- if phase 1 keeps backend choice global-per-provider, store and UI must say launches inherit the current global backend instead of pretending lane persistence exists
- if phase 1 needs stable relaunch identity, persist canonical backend identity alongside saved launch params and runtime snapshots
- make resume guards compare canonical backend identity, not just provider/model

### 25. Team-summary and list-surface checkpoint

We must decide what backend-lane truth, if any, team cards, draft cards, and team-list summaries are allowed to expose once Codex lanes diverge materially.

Default:

- do not keep `TeamSummary` permanently lane-blind if team lifecycle semantics can differ by lane
- either enrich team summaries with canonical lane identity or explicitly keep list surfaces lane-agnostic and avoid lane-sensitive copy/actions there
- keep synthetic provisioning snapshots and persisted team summaries on the same lane-vocabulary contract so cards do not disagree about the same team

### 26. Member-runtime-summary and composer-capability checkpoint

We must decide what backend-lane truth member cards, member detail, bootstrap copy, and composer capability suggestions are allowed to expose once old Codex and `codex-native` diverge materially.

Default:

- do not keep member runtime summaries permanently provider-wide if backend lane materially changes runtime semantics or capability affordances
- either enrich member/composer surfaces with canonical backend-lane truth or explicitly keep them lane-agnostic and avoid lane-sensitive copy/actions there
- keep member runtime copy, bootstrap/system summary copy, and composer slash-command/plugin affordances on the same backend-vocabulary contract so detail and composer surfaces do not tell a different Codex story than runtime status/settings

### 27. Plugin-activation and session-visibility checkpoint

We must decide what “installed”, “active”, “usable”, “requires restart/new thread”, and “requires app auth/setup” mean for each runtime lane once Codex plugin support depends on `codex-native`.

Default:

- do not treat install/uninstall success as immediate activation truth
- keep native placement truth separate from current-session execution truth
- require an explicit lane-aware contract for at least:
  - installed in filesystem/marketplace
  - executable on the selected lane
  - usable only in a new thread or restarted session
  - still blocked on app/auth setup
- if exact current-session activation cannot be proven safely, UI must stay conservative and say new-thread/restart required instead of implying “ready now”

### 28. Mention-targeting and invocation-shape checkpoint

We must decide what kind of explicit plugin/app/skill targeting phase 1 can honestly support on the chosen Codex execution seam.

Default:

- do not assume SDK/exec gives us the same structured invocation surface as app-server
- make phase 1 explicit about whether it supports:
  - deterministic structured mention targeting
  - linked-text mention targeting only
  - or no explicit plugin/app targeting affordance yet
- if the chosen seam still depends on linked text mentions, UI/composer surfaces must stay conservative and avoid claiming first-class deterministic invocation semantics
- keep mention-targeting truth separate from install/catalog truth so “plugin installed” does not silently become “app can invoke it exactly”

### 29. Live-stream versus history-hydration checkpoint

We must decide what source is authoritative for active-turn rendering versus replayable thread history.

Default:

- keep live `turn/*` and `item/*` notifications as active activity truth, not as automatic persisted-history truth
- keep explicit hydration sources separate, such as:
  - `thread/read`
  - `thread/turns/list`
  - `thread/resume`
  - `thread/fork`
  - projected persisted transcript reads
- do not let sparse `Turn` / `Thread` payloads or partial live item caches stand in for exact-log, replay, or post-hoc transcript history
- if phase 1 cannot prove a safe direct history-hydration contract from the chosen Codex seam, keep exact-log/task-log/replay surfaces grounded in the persisted transcript projector instead of improvising from live event cache

### 30. Approval-resolution and lifecycle-cleanup checkpoint

We must decide what event is authoritative for clearing pending approval or request-user-input state when the user did not explicitly answer.

Default:

- do not assume pending approval state ends only through successful allow/deny IPC
- treat lifecycle cleanup as first-class truth when the runtime says the request is no longer pending
- require an explicit mapping for at least:
  - user answered
  - auto-resolved
  - lifecycle-cleared on turn start/complete/interrupt
  - run/turn dismissed or no longer active
- if the chosen Codex seam cannot yet express truthful cleanup semantics, phase 1 must keep approval UX limited instead of leaving stale pending state in renderer/store

### 31. Interactive-request and elicitation checkpoint

We must decide what phase 1 does when Codex-native asks for generic user input or MCP-server elicitation rather than a plain approval.

Default:

- do not assume tool approval UI can stand in for generic interactive prompts
- explicitly decide whether phase 1:
  - supports `requestUserInput`
  - supports MCP elicitation
  - blocks them with a clear limitation
  - or keeps the lane limited until a truthful response UI exists
- if these request types are unsupported in phase 1, the lane must not overclaim parity for flows that depend on them

### 32. Headless-exec capability-boundary checkpoint

We must decide whether the first Codex-native execution seam is explicitly headless-limited and, if so, what phase 1 is allowed to claim about approvals and other interactive/runtime-control features.

Default:

- do not assume raw `codex exec` or the current TypeScript SDK inherits app-server interactive semantics
- if phase 1 uses raw exec or the current SDK, explicitly document which of these are:
  - supported
  - rejected by the runtime seam itself
  - unsupported because the seam never surfaces them to the app
- keep lane capability truth conservative for at least:
  - manual approvals
  - generic `requestUserInput`
  - MCP elicitation
  - dynamic tool behavior
  - other server-request-style controls
- if richer interaction is required later, add it as a separate seam decision instead of quietly expanding the headless lane by implication

### 33. Ephemeral-versus-backfill checkpoint

We must decide whether phase 1 optimizes first for minimal durable Codex session ownership, for stronger completed-turn item completeness, or for an explicit replacement hydration strategy.

Default:

- do not treat `--ephemeral` as a free safety win
- make the tradeoff explicit between:
  - ephemeral/no durable Codex-owned session persistence
  - non-ephemeral exec with final `thread/read` completed-turn item backfill
  - explicit post-turn hydration/projector recovery if ephemeral remains preferred
- if phase 1 chooses `--ephemeral`, transcript and history completeness must be recovered through an explicit tested path before exact-log/task-log/replay claims are considered safe
- if phase 1 chooses non-ephemeral execution, durable session ownership and resume semantics must stay explicit in UI/runtime truth instead of being treated like an invisible implementation detail

### 34. Codex credential-routing and API-key surface checkpoint

We must decide how the first `codex-native` lane receives credentials and how that truth is reflected in status, issues, and UI copy.

Default:

- do not assume the old Codex `OPENAI_API_KEY` path automatically authenticates the native exec/SDK lane
- if phase 1 uses raw exec or the current SDK, explicitly decide whether the host:
  - passes `CODEX_API_KEY`
  - passes SDK `apiKey`
  - or uses another explicit auth surface
- keep connection-issue detection, readiness checks, and status copy lane-aware so old Codex API-key readiness and native exec/SDK readiness cannot drift apart
- do not let provider-level “Codex API key configured” truth stand in for native-lane authentication truth unless the credential-routing contract explicitly proves they are the same path

### 35. Native-lane model inventory and reasoning-effort checkpoint

We must decide what source is authoritative for `codex-native` model lists, disabled states, reasoning-effort options, and default/preflight model choices.

Default:

- do not assume the old static Codex model catalog remains truthful for the native lane
- explicitly decide whether phase 1 model truth comes from:
  - a native model-list surface
  - a curated lane-aware allowlist
  - or a temporary conservative subset with explicit limitations
- keep these at minimum lane-aware:
  - visible model ids
  - disabled-model reasons
  - default/preflight model
  - supported reasoning-effort choices
  - any upgrade/availability guidance shown in UI
- do not let provider-wide old-Codex heuristics stand in for native-lane model truth once backend lane materially changes model behavior

### 36. Workspace-trust and native-thread-start checkpoint

We must decide who owns workspace-trust truth when a native Codex lane starts or resumes threads with writable/full-access semantics.

Default:

- do not assume native Codex trust behavior is equivalent to our host trust dialog
- keep host trust as the authoritative phase-1 boundary for:
  - full env application
  - hooks/LSP/MCP startup
  - any UI that says the workspace is trusted
- if the chosen native seam can mark projects trusted in Codex config/state, explicitly decide whether that is:
  - forbidden in phase 1
  - allowed only after host trust is already accepted
  - or surfaced as a second explicit trust authority
- do not equate raw exec repo-check semantics with our persisted trust-dialog semantics

### 37. Instruction-ownership and collaboration-mode checkpoint

We must decide which instruction channel owns phase-1 `codex-native` behavior and which native Codex instruction surfaces are intentionally out of scope.

Default:

- do not let collaboration-mode built-ins, native `baseInstructions`, native `developerInstructions`, and host system/bootstrap prompts all stack by accident
- explicitly decide whether phase 1 uses:
  - host-owned system/bootstrap prompts only
  - native instruction channels only
  - or one carefully-defined hybrid
- if `collaborationMode` is not intentionally adopted in phase 1, keep it disabled instead of leaving it as an implicit future default
- if any native instruction channel is used, define how it interacts with:
  - host model/effort selection
  - bootstrap-critical guidance
  - CLAUDE.md/rules/host prompt ownership

### 38. Persisted-history policy checkpoint

We must decide what persisted-history richness phase 1 guarantees for native threads and when that choice is made.

Default:

- do not treat `persistExtendedHistory` as an invisible implementation toggle
- explicitly decide whether native `thread/start` / `thread/resume` / `thread/fork` use:
  - richer persisted history by default
  - a conservative lossy default
  - or an explicit lane-specific/history-specific rule
- keep replay/exact-log/reload truth aware of whether a thread was born with rich or lossy persisted history
- do not assume later enabling richer persistence retroactively repairs older native threads

### 39. Native-config, feature-state, and marketplace-ownership checkpoint

We must decide whether any native app-server config/feature/marketplace mutation surface is allowed to write process-wide or persistent state during phase 1.

Default:

- do not let native `config/*`, `experimentalFeature/enablement/set`, or `marketplace/add` become a second hidden settings authority
- if selective app-server enrichment is used later, explicitly decide whether those mutations are:
  - blocked in phase 1
  - mirrored through host-owned config/services
  - or surfaced as explicit global native-state operations with matching UI truth
- keep host-owned settings/config as the default authority for runtime, connection, and marketplace truth unless one bridge is explicitly frozen

### 40. Native-review thread-identity checkpoint

We must decide what phase 1 does with native review flows that can fork detached review threads with their own thread id and lifecycle.

Default:

- do not assume native review always stays on the current thread
- explicitly decide whether phase 1:
  - disables native review affordances
  - supports inline review only
  - or supports detached review with explicit child-thread/sidechain mapping
- if detached review is unsupported, UI/composer affordances must not imply otherwise

### 41. Native binary-version and protocol-surface checkpoint

We must decide what native runtime identity fields phase 1 treats as capability-defining for `codex-native`.

Default:

- do not treat backend id alone as enough native runtime identity
- explicitly decide whether phase 1 status/probe/capability truth carries:
  - native executable source
  - native binary version
  - protocol/capability revision
  - stable-vs-experimental surface truth where app-server enrichment is involved
- if bundled SDK binary and external CLI can both satisfy the lane, keep their capability truth separate unless proven equivalent
- do not let packaged dependency bumps or user-installed Codex version skew silently change what `codex-native` means without status, cache, and UI noticing

### 42. App-server connection-policy checkpoint

We must decide what one canonical connection policy means if selective app-server enrichment is added later.

Default:

- do not assume app-server capability surface is process-global
- explicitly decide whether future app-server usage has:
  - one canonical `experimentalApi` policy
  - one canonical `optOutNotificationMethods` policy
  - one canonical live-subscription policy
- if different connection profiles are allowed later, their differing surface and notification truth must be explicit in capability and debugging signals
- do not diagnose missing fields or notifications as runtime breakage before ruling out connection-policy drift

### 43. Canonical-history versus append-only-projection checkpoint

We must decide which source is authoritative when native Codex history is logically mutated by rollback or compaction while our local transcript/log stack still prefers append-only processing.

Default:

- do not assume append-only projected transcript remains canonical after native rollback or compaction
- explicitly decide whether phase 1 replay/exact-log/task-log truth is sourced from:
  - canonical native thread history
  - append-only projected transcript
  - or one explicit reconciliation strategy
- if append-only local transcript remains part of phase 1, define how stale pre-rollback or pre-compaction activity is:
  - hidden
  - marked superseded
  - or reconciled on reload/hydration
- do not let incremental watchers and append-only cache assumptions masquerade as canonical history after native history mutation

### 44. Turn-metadata and usage-authority checkpoint

We must decide which native source is authoritative for usage, model, reasoning-effort, reroute, and plan truth, and which of those truths phase 1 is allowed to surface at all on the chosen seam.

Default:

- do not infer native-lane token usage, context-window truth, or final model truth only from assistant transcript rows
- treat authoritative sources as seam-scoped:
  - raw exec / current SDK:
    - `turn.completed` usage is authoritative for completed-turn usage truth available on that seam
  - app-server, if added later:
    - `thread/tokenUsage/updated` is authoritative for replayed and restored usage truth
    - persisted thread metadata plus explicit reroute notifications govern final model/reasoning-effort truth
- if the chosen seam does not expose truthful plan/diff/reroute metadata, keep those fields normalized-only or explicitly unavailable in phase 1 instead of guessing
- do not let context panels, provisioning usage, token warnings, or status copy imply richer native usage/model truth than the chosen seam can actually prove

### 45. Native thread-defaults and launch-intent checkpoint

We must decide how host launch intent, persisted native thread-defaults, and resume or fresh-thread policy interact once native turns can mutate default runtime behavior on the thread itself.

Default:

- do not assume `TeamLaunchRequest`, `TeamCreateRequest`, `TeamLaunchParams`, `team.meta.json`, or config-owned provider/model/effort remain canonical runtime truth after a resumed native thread restores persisted defaults
- explicitly decide whether phase 1 resume behavior:
  - inherits persisted native thread-defaults
  - always overrides them with host launch intent
  - or blocks/skips resume when they differ
- compare at least provider, model, and effort when deciding whether a resumed native thread still matches host launch intent
- if the host cannot model some native thread-default truth honestly, keep that surface explicit as inherited or unknown rather than silently rewriting it into launch-owned config or summary copy

### 46. Native thread-status and warning-authority checkpoint

We must decide how native thread lifecycle and warning truth interact with host process, provisioning, and probe status surfaces.

Default:

- do not assume process alive, provisioning active, or runtime snapshot present means the native thread is healthy or loaded
- explicitly decide whether phase 1 thread-health truth is sourced from:
  - native thread status notifications and reads when available
  - host process/provisioning status only
  - or one explicit reconciliation strategy between them
- keep `thread.status` states like `notLoaded`, `idle`, `active`, and `systemError` distinct from generic host process liveness
- keep thread-scoped runtime warnings and config warnings distinct from provisioning probe warnings or transcript-attached warnings

## Lowest-Confidence Execution Seam Options

This is the one place where the plan should stay explicit about alternatives instead of pretending there is no tradeoff.

### Option 1 - SDK-first phase-0 spike

Use `@openai/codex-sdk` first and accept its current thread/session semantics for the spike.

- Assessment: `🎯 7   🛡️ 7   🧠 5`
- Rough spike surface: `300-900` lines

Pros:

- matches the official Node/Electron embedding seam
- gives a higher-level thread API quickly
- likely minimizes phase-0 implementation code

Cons:

- hides some raw CLI behavior behind the SDK wrapper
- does not currently expose `ephemeral`
- still inherits the current exec seam's headless interactive limits
- can accidentally normalize around durable Codex-owned thread persistence before we intend to

### Option 2 - raw `codex exec` wrapper first

Use a narrow local wrapper around `codex exec --json` for the first spike, then decide later whether the production lane stays raw or moves up to the SDK.

- Assessment: `🎯 8   🛡️ 8   🧠 6`
- Rough spike surface: `400-1100` lines

Pros:

- keeps runtime flags and persistence behavior fully explicit
- lets us test `--ephemeral` directly
- exposes headless interactive limits early instead of hiding them behind the SDK wrapper
- makes normalized-event mapping closer to the actual process boundary we must understand anyway

Cons:

- slightly more glue code in phase 0
- less ergonomic than the SDK for long-lived thread objects
- easier to accidentally overfit phase 0 to headless exec semantics if we forget this is evidence-gathering, not the final product seam
- may need an extra abstraction layer later if we switch upward to the SDK

### Option 3 - dual wrapper from day one

Build a small local abstraction that can drive either `@openai/codex-sdk` or raw `codex exec`, and start phase 0 by comparing both.

- Assessment: `🎯 6   🛡️ 8   🧠 8`
- Rough spike surface: `700-1500` lines

Pros:

- maximizes optionality
- makes the seam explicit early
- can keep the production decision open a bit longer

Cons:

- higher upfront complexity
- bigger chance of overengineering phase 0
- easy to spend too much time abstracting before we even know the correct session ownership model

### Recommended default for phase 0

Start with **Option 2 - raw `codex exec` wrapper first**.

Reason:

- it gives the cleanest evidence for the two scariest unknowns:
  - event-shape truth
  - session persistence truth
- it also exposes the real headless capability boundary before UI/runtime copy starts assuming richer interaction support
- it keeps `ephemeral` visible instead of hidden
- if phase 0 later proves that durable SDK-owned threads are acceptable, we can still move upward to `@openai/codex-sdk` with much better confidence

## Why We Chose This

### Main benefit

This path gives us both:

- unified internal logs/events
- a real path to native Codex runtime capabilities

without requiring a full rewrite of the current multimodel runtime.

### Main reason against a direct full swap

The current orchestrator is deeply coupled to Anthropic-shaped runtime behavior:

- `tool_use`
- `tool_result`
- `content_block_start`
- `input_json_delta`
- `message_delta`
- current permission and sandbox flow
- current synthetic tool/result handling
- current transcript persistence and resume logic

`codex exec` emits a different event model:

- `thread.started`
- `turn.started`
- `turn.completed`
- `turn.failed`
- `item.started`
- `item.updated`
- `item.completed`

and item types such as:

- `agent_message`
- `reasoning`
- `command_execution`
- `file_change`
- `mcp_tool_call`

That is not just a different wire format. It is a different runtime shape.

## Architecture Layers

### Execution plane

This is the runtime that actually talks to the provider or executes the provider-native agent runtime.

Planned state:

- `Anthropic` - current path
- `Gemini` - current path
- `Codex fallback` - current adapter/API path
- `Codex-native` - real Codex runtime through `@openai/codex-sdk / codex exec`, with phase-1 capability truth scoped by the chosen seam rather than assumed to equal app-server

### Normalized event/log plane

This is the new provider-neutral projection layer we want inside `agent_teams_orchestrator`.

It is the source of truth for:

- logs
- transcript projection
- activity timeline rendering
- analytics-friendly event summaries
- desktop-facing runtime activity DTOs

It is **not** required to be a lossless mirror of any one provider wire format.

### Transcript compatibility plane

This is separate from normalized runtime events.

Its job is:

- persist runtime history in a shape that current `claude_team` transcript readers can still consume
- preserve current read-model stability for:
  - `ParsedMessage`
  - exact-log parsing
  - task activity
  - grouped tool/result rendering

This means:

- normalized events are **not** written directly to disk for UI consumption in phase 1
- they must first pass through a transcript compatibility projector

### Chain and sidechain identity plane

This sits underneath transcript compatibility.

Its job is:

- preserve a truthful parent/child transcript chain for persisted rows
- preserve truthful main-thread versus sidechain identity
- preserve enough session/member identity for team-log readers and subagent linking

Phase-1 rule:

- projected transcript rows must not invent or flatten chain/sidechain identity just to fit a convenient shape
- progress-like or transport-only events that are not real transcript messages must not become new chain participants by accident

### Request-correlation plane

This is separate from both normalized events and persisted transcript shape.

Its job is:

- preserve stable request identity for streamed assistant dedupe
- preserve approval request identity for live approval UX
- preserve truthful tool-action correlation where current UI and analysis code already rely on it

Phase-1 rule:

- request-correlation semantics must stay explicit across runtime events, normalized events, and projected transcript rows
- if a Codex-native event cannot be assigned a truthful request correlation, it should not be forced into a shape that pretends it has one

### Approval/control adaptation plane

This sits on top of request-correlation and underneath the current approval UX.

Its job is:

- translate provider-native approval/control events into the existing `ToolApprovalRequest` contract when that translation is truthful
- preserve stable request identity for pending/resolved approval state
- preserve a clear allow/deny response path back to the runtime

Phase-1 rule:

- `codex-native` must not claim approval parity unless this plane is explicitly specified and tested
- if provider-native events cannot truthfully map into the current approval contract, the lane must stay limited instead of fabricating fake `permission_request` rows

### Approval-resolution and lifecycle-cleanup plane

This sits between provider-native request cleanup semantics and the renderer's pending/resolved approval state.

Its job is:

- separate explicit user decisions from lifecycle-driven request cleanup
- keep pending approval state, resolved icons, and stale-request dismissal truthful when a turn is interrupted, replaced, or completed before the user answers
- preserve a stable authority order between:
  - explicit user response
  - runtime auto-resolution
  - runtime lifecycle cleanup
  - run-level dismissal

Phase-1 rule:

- do not let `codex-native` approval UX depend only on successful allow/deny IPC
- if runtime cleanup semantics exist, they must map into an explicit renderer/store event instead of being inferred indirectly
- pending approval state must clear truthfully even when no explicit user decision happened
- if phase 1 cannot prove truthful cleanup semantics, keep the lane limited instead of leaving approval state half-mapped

### Interactive-request and elicitation plane

This sits between provider-native structured prompts and any UI surface that can collect user input back into the runtime.

Its job is:

- separate tool approvals from generic user-input prompts and MCP elicitation requests
- keep runtime turns from silently stalling when the provider expects structured user input rather than a simple allow/deny
- make unsupported interactive request types explicit instead of letting them fail as invisible no-op state

Phase-1 rule:

- do not let `codex-native` imply full interactive parity if only approval prompts are supported
- if `requestUserInput` or MCP elicitation are unsupported in phase 1, surface that as a deliberate lane limitation
- if supported, they need their own authoritative request lifecycle and response contract rather than being squeezed into the tool-approval model

### Headless-exec capability-boundary plane

This sits between the chosen Codex execution seam and all app/runtime claims about interactivity or runtime-side control.

Its job is:

- keep headless exec/SDK capability truth separate from richer app-server capability truth
- prevent phase 1 from overclaiming support for server-request-style interactions the seam explicitly rejects
- force the rollout to say which interactive/runtime-control features are truly available on the chosen lane

Phase-1 rule:

- if the chosen seam is raw `codex exec` or the current TypeScript SDK, treat it as a headless-limited lane unless proven otherwise
- do not let UI, settings, or capability payloads imply support for:
  - manual approval loops
  - `requestUserInput`
  - MCP elicitation
  - dynamic tool calls
  - other server-request-style controls
  unless the chosen seam actually exposes and supports them end-to-end

### Ephemeral-session and completion-backfill plane

This sits between session-ownership safety decisions and transcript/history completeness decisions.

Its job is:

- separate “avoid durable Codex-owned session persistence” from “preserve final completed-turn item completeness”
- keep the `--ephemeral` tradeoff explicit instead of hiding it behind a vague safety preference
- force phase 1 to name its authoritative recovery path for final-turn items and post-turn history truth

Phase-1 rule:

- if the chosen seam uses non-ephemeral exec, treat final `thread/read` backfill as an explicit part of the lane contract and test it
- if the chosen seam uses `--ephemeral`, do not assume completed-turn item completeness still holds unless an explicit replacement hydration/projector strategy is specified and tested
- do not let transcript, exact-log, replay, or post-turn detail UX depend on implicit backfill behavior that the chosen seam no longer provides

### Session ownership plane

This is where we must stay conservative.

Current reality:

- `codex-sdk` threads are persisted in `~/.codex/sessions`
- `claude_team` and current orchestrator flows already have their own transcript/session assumptions

Phase-1 rule:

- our transcript remains the UI/read-model source of truth
- the Codex thread id should be treated as a provider-native continuation token, not as the only session history source for UI

### Runtime status/settings plane

This sits alongside session ownership and management.

Its job is:

- keep `selectedBackendId`, `resolvedBackendId`, `availableBackends`, and backend summaries truthful
- keep provisioning readiness and installer/runtime diagnostics aligned with the real lane contract
- keep model verification signatures and probe policy aligned with the active execution seam

Phase-1 rule:

- `codex-native` must not piggyback on the old “Codex runtime follows connection method” assumption unless that rule is consciously preserved and tested
- if the lane is first-class in orchestrator, it must be first-class in settings/status/provisioning truth too

### Connection/auth-routing plane

This sits between provider connection settings and the execution plane.

Its job is:

- apply authentication credentials without silently rewriting execution-lane truth
- keep provider connection mode, backend selection env, and runtime status consistent
- make it explicit when API-key auth is compatible with more than one backend lane
- keep old-lane credential surfaces and native exec/SDK credential surfaces from masquerading as one shared “Codex API key ready” state

Phase-1 rule:

- `codex-native` must not inherit the old rule “Codex API key mode means Responses API lane” unless that mapping is intentionally preserved and documented
- env construction must resolve auth choice and runtime backend choice separately, then combine them explicitly
- if the chosen seam is raw exec or the current SDK, credential routing must explicitly bridge host-stored key truth into the seam's real auth surface instead of assuming old `OPENAI_API_KEY` routing is already native-lane-compatible

### Config and launch-granularity plane

This sits between saved app settings, provisioning, and execution selection.

Its job is:

- keep shared config schema, config validation, and runtime backend vocabulary aligned
- define whether backend choice is global-per-provider or launch-specific
- keep provisioning warnings, launch summaries, and runtime validation truthful about that granularity

Phase-1 rule:

- if backend choice is still global-per-provider, phase 1 must say so explicitly in both config semantics and provisioning UX
- do not imply task-specific or team-specific `codex-native` selection until `TeamLaunchRequest` and related launch contracts actually support it

### Model-inventory and reasoning-effort plane

This sits between backend/lane truth and model selectors, verification probes, and provisioning hints.

Its job is:

- keep native-lane model inventory distinct from old provider-wide static catalogs when they diverge
- keep disabled-model heuristics, reasoning-effort choices, and default/preflight model choices aligned with the selected lane
- prevent static Codex model assumptions from silently standing in for richer native model truth

Phase-1 rule:

- do not let `codex-native` inherit the old static Codex model catalog unless that subset is intentionally frozen and documented
- if phase 1 uses a curated subset instead of native dynamic model listing, that subset and its disabled reasons must still be lane-aware and explicit
- model verification, create/launch selectors, and runtime settings must not disagree about what models or reasoning-effort options the selected lane actually supports

### Workspace-trust and native-thread-start plane

This sits between host trust ownership and native Codex thread lifecycle.

Its job is:

- keep host workspace-trust truth separate from native Codex trust side effects
- prevent native thread start/resume from silently mutating project trust behind the host's back
- keep trust-gated env/hook/LSP/MCP behavior aligned with one explicit authority

Phase-1 rule:

- do not let `codex-native` mark a project trusted or behave as if it already is trusted before host trust is satisfied
- if native trust writes are allowed at all, they must be explicitly sequenced after host trust and surfaced truthfully instead of being treated as an invisible side effect
- do not let raw exec repo-check semantics stand in for our persisted trust-dialog semantics

### Instruction-ownership and collaboration-mode plane

This sits between native Codex instruction channels and our current host-owned system/bootstrap prompt assembly.

Its job is:

- keep one explicit owner for phase-1 instruction truth
- prevent collaboration-mode built-ins from silently overriding host-selected model/effort/instruction semantics
- prevent bootstrap-critical instructions from being duplicated, replaced, or hidden by a second instruction layer the app cannot inspect well

Phase-1 rule:

- do not mix host system/bootstrap prompts with native collaboration-mode built-ins unless one explicit precedence contract is frozen and tested
- if phase 1 does not intentionally adopt `collaborationMode`, keep that channel off instead of leaving it as latent magic
- if native `baseInstructions` or `developerInstructions` are used, they must have an explicit relationship to host prompt assembly rather than being appended opportunistically

### Process-scope backend-routing plane

This sits between launch/provisioning and actual teammate spawn behavior.

Its job is:

- keep backend-routing truth aligned with the actual lifetime and scope of env/application
- prevent UI and provisioning copy from implying member-level backend choice when backend routing is still inherited from process state
- make mixed-lane support an explicit future capability instead of an accidental assumption

Phase-1 rule:

- do not claim that one launched orchestrator runtime can run both old Codex and `codex-native` lanes side by side unless spawn plumbing explicitly supports that
- if Codex backend selection is still process-scoped, team launch UX must describe it as such

### Probe-cache and preflight-truth plane

This sits between runtime settings/provisioning and actual readiness truth.

Its job is:

- keep provisioning-readiness cache identity aligned with backend/auth/probe-policy truth
- prevent long-lived provider-only cache entries from masking a real backend or auth switch
- keep provisioning readiness and backend-aware model verification from diverging into split-brain status

Phase-1 rule:

- a Codex backend/auth change that alters execution-lane truth must either invalidate affected probe cache entries immediately or bypass them deterministically
- do not reuse provider-only cached readiness for `codex-native` if the active model-verification signature or backend summary says the lane changed

### External-runtime-diagnostic plane

This sits between external binary discovery and user-facing backend status.

Its job is:

- keep local binary detection separate from execution-lane readiness
- prevent UI, installer snapshots, or provisioning summaries from treating “CLI exists” as “lane is ready”
- make the relationship between detected binary, selectable backend option, and verified runtime truth explicit
- keep external CLI discovery separate from bundled SDK-binary readiness if the chosen seam resolves Codex from packaged npm dependencies rather than the user's PATH

Phase-1 rule:

- `externalRuntimeDiagnostics` may support explanations and install hints, but they must not silently upgrade capability or readiness truth for `codex-native`
- if the lane is not yet selectable or authenticated, CLI detection alone must not make it appear ready
- if the chosen seam uses a bundled SDK binary, external CLI detection must stay advisory instead of implying that the exact binary this lane will execute is already available

### Backend-option-state plane

This sits between runtime status payloads and renderer backend-selection UX.

Its job is:

- keep option-state semantics explicit across `selectable`, `available`, `resolved`, and `verified`
- prevent renderer/backend-selector behavior from collapsing those states into one boolean
- allow `codex-native` to be introduced as a visible lane without forcing fake readiness or fake unselectability

Phase-1 rule:

- the renderer must not treat `available` as the only state that matters once `codex-native` exists
- runtime status and renderer logic must agree on whether an unavailable-but-selectable lane is still user-choosable for configuration or migration purposes

### Runtime-status fallback plane

This sits between orchestrator status transport and UI/backend-selection state.

Its job is:

- define what happens when backend-rich status payloads are unavailable transiently
- keep degraded transport separate from true provider/backend capability loss
- prevent legacy provider-only fallback from erasing meaningful backend-lane truth

Phase-1 rule:

- if unified runtime status is unavailable, UI must still distinguish:
  - last known backend truth
  - current degraded transport state
  - actual backend unavailability
- a transport fallback must not silently remap `codex-native` into old provider-only Codex semantics

### Runtime-copy and summary plane

This sits between backend-rich status truth and user-facing labels/banners.

Its job is:

- keep connection-method wording separate from execution-lane wording
- prevent auth-mode labels from masquerading as backend-lane truth
- keep settings, dashboard, and detail summaries aligned on what “current runtime” actually refers to

Phase-1 rule:

- once `codex-native` exists, Codex runtime summary helpers must become lane-aware
- UI may still show `Codex subscription` or `OpenAI API key` as connection method, but not as a substitute for `selectedBackendId` / `resolvedBackendId`

### Progressive-status and snapshot-reconciliation plane

This sits between main-process status publishing and renderer/store state.

Its job is:

- reconcile progressive status snapshots, cached IPC status responses, and provider-specific refresh results
- preserve whether a snapshot is partial, settled, or degraded
- prevent stale or partial snapshot pushes from silently clobbering newer backend-lane truth

Phase-1 rule:

- renderer/store must not treat every incoming `cliStatus` snapshot as equally authoritative
- if progressive snapshots are kept, they must carry enough sequencing or settledness semantics to coexist safely with request/response refresh paths

### Extension-preflight and action-gating plane

This sits between runtime/backend truth and extension-management UX.

Its job is:

- project backend-lane truth into plugin/MCP/skill action availability honestly
- keep coarse runtime-install status separate from backend-lane execution readiness
- prevent provider-wide capability truth from overstating what the selected lane can actually manage

Phase-1 rule:

- plugin actions for Codex must not become enabled just because Codex as a provider is authenticated or mutable on some other lane
- extension banners, install buttons, and mutation preflight must share the same backend-aware readiness model

### Team-model and provisioning-runtime plane

This sits between runtime/backend truth and create/launch dialog model selection.

Its job is:

- project lane-aware runtime truth into team model visibility, model validation, and provisioning notes
- prevent provider-wide Codex heuristics from standing in for backend-lane identity
- keep create/launch dialogs aligned with the same lane vocabulary used by runtime settings and provisioning status

Phase-1 rule:

- team model selectors and provisioning diagnostics must not rely only on provider id plus auth/backend summary once `codex-native` exists
- lane-specific model truth must be explainable in create/launch UI without falling back to old Codex-wide assumptions

### Provisioning-prepare cache-identity plane

This sits between provisioning warmup/model diagnostics and cached reuse.

Its job is:

- keep prepare/model cache identity canonical and backend-aware
- decouple cache validity from backend summary wording
- prevent false cache reuse across different Codex lanes or auth/probe combinations

Phase-1 rule:

- prepare/model cache identity must not be derived from display summary text
- provisioning cache reuse must stay stable under copy changes and must split cleanly across old Codex and `codex-native`

### Persisted-team-identity and replay-identity plane

This sits between saved launch requests, draft team metadata, member metadata, backup/restore artifacts, relaunch defaults, runtime snapshots, and resume decisions.

Its job is:

- keep persisted team launch identity honest about whether backend lane is pinned or inherited from current global runtime config
- keep team draft metadata and member metadata honest about whether they carry lane identity or only provider/model defaults
- keep backup/restore semantics honest about whether restored teams preserve lane identity or merely restore provider/model defaults
- prevent relaunch/restart/resume flows from silently changing Codex lane after settings drift
- keep runtime snapshots and relaunch UI clear about which backend identity the team actually expects

Phase-1 rule:

- do not persist or replay Codex team launches using only provider/model if backend lane materially changes runtime semantics
- do not let `team.meta.json`, `members.meta.json`, `TeamConfig`, or runtime snapshots imply stable lane identity if they only persist provider/model/effort
- if launch identity remains global-per-provider, expose that as an explicit inherited-global rule instead of pretending lane persistence exists
- resume guards and runtime snapshots must compare or expose canonical backend identity whenever lane drift would change runtime behavior

### Team-summary and list-surface plane

This sits between persisted team/runtime truth and renderer-facing team cards, tabs, and list summaries.

Its job is:

- decide whether team summary surfaces are lane-aware or intentionally lane-agnostic
- prevent list cards, draft cards, and runtime detail cards from implying different Codex lane truths for the same team
- keep summary-level UI honest about pinned-vs-inherited backend identity without forcing every detail-only field into the list surface

Phase-1 rule:

- do not let `TeamSummary` remain accidentally lane-blind if users can make backend-lane decisions from team cards, create/launch summaries, or restore/retry flows
- if summary surfaces stay lane-agnostic in phase 1, explicitly keep lane-sensitive actions and wording out of them instead of implying hidden certainty
- synthetic provisioning snapshots and persisted team summaries must not disagree about whether lane identity is known, inherited, or intentionally omitted

### Member-runtime-summary and composer-capability plane

This sits between backend-rich runtime truth and member-level/detail/composer-facing copy or capability affordances.

Its job is:

- keep member runtime summary strings honest about whether lane truth is known or intentionally omitted
- keep bootstrap/system summary copy from collapsing old Codex and `codex-native` into the same visible runtime story
- keep composer slash-command/plugin/app affordances aligned with the actual selected/resolved lane instead of provider-only Codex identity

Phase-1 rule:

- do not let member/detail/composer surfaces imply lane-specific truth they do not actually carry
- lane-sensitive command or plugin affordances must not key only off `providerId === 'codex'` once backend lane matters
- if phase 1 keeps these surfaces lane-agnostic, explicitly keep lane-sensitive copy/actions out of them instead of quietly inheriting provider-wide Codex assumptions

### Plugin-activation and session-visibility plane

This sits between plugin-management success and user-facing “you can use this now” truth.

Its job is:

- separate native placement success from actual execution readiness on the selected lane
- keep current-session visibility, new-thread visibility, restart-required truth, and app-auth/setup completion as separate concepts
- prevent extension cards/buttons/banners from overstating activation state once `codex-native` exists

Phase-1 rule:

- do not let `isInstalled` imply “active in the current session”
- `codex-native` plugin UX must at least distinguish:
  - installed but old lane selected
  - installed on `codex-native` but usable only in a new thread or after restart
  - installed but still blocked on required app/auth setup
- if exact activation state inside an already-running session cannot be proven safely, UI must stay conservative and describe next-thread/restart semantics explicitly

### Mention-targeting and invocation-shape plane

This sits between “plugin/app exists and is installed” truth and “runtime can explicitly invoke this target the way UI suggests” truth.

Its job is:

- separate catalog/install truth from invocation-shape truth
- keep structured mention targeting, linked-text mention targeting, and implicit runtime discovery as separate concepts
- prevent composer or extension UI from overstating exact plugin/app invocation support on the chosen Codex execution seam

Phase-1 rule:

- do not let plugin/app install support imply first-class deterministic invocation support
- if the chosen seam is raw `codex exec` or current `@openai/codex-sdk`, phase 1 must explicitly say whether plugin/app invocation is:
  - structured and exact
  - linked-text mention based
  - or not yet surfaced as an explicit UI affordance
- if invocation still depends on linked-text mentions, keep that behavior behind conservative copy and tests instead of presenting it like an app-server-grade structured contract

### Live-stream and history-hydration plane

This sits between active runtime notifications and replayable/history-bearing transcript truth.

Its job is:

- separate active-turn streaming truth from replayable thread-history truth
- keep sparse `Turn` / `Thread` response payloads from being mistaken for fully hydrated history
- keep exact-log/task-log/reload consumers grounded in explicit hydration or persisted transcript projection instead of optimistic live caches

Phase-1 rule:

- do not let `turn/started`, `turn/completed`, or sparse thread payloads become the canonical history source for UI/transcript consumers
- if live `item/*` events are used for in-flight activity, that must stay a separate path from exact-log/replay/post-hoc reads
- any history used for resume, exact log, task log detail, or persisted transcript views must come from an explicit hydration/projector contract, not from whatever live notifications happened to be seen on one connection

### Persisted-history policy plane

This sits between native thread creation/resume/fork policy and later replay/exact-log/history hydration guarantees.

Its job is:

- keep richer persisted-history choice explicit at thread birth/resume/fork
- prevent mixed populations of native threads from looking equally replayable when some were created with lossy history policy
- keep replay/exact-log/reload truth honest about whether richer historical items can ever be hydrated later

Phase-1 rule:

- do not let persisted-history richness be an implicit side effect of whichever seam happens to start the thread
- if `persistExtendedHistory` is enabled, that choice must be explicit and stable enough for replay/exact-log guarantees
- if it is not enabled, UI/transcript/replay flows must not quietly assume richer historical completeness will appear later

### Native-config, feature-state, and marketplace-ownership plane

This sits between selective app-server enrichment and our current host-owned config/settings model.

Its job is:

- keep process-wide native feature/config mutations from becoming hidden second authorities
- keep marketplace persistence and feature toggles aligned with what the host app can actually display and own
- prevent one thread or one helper API call from mutating global native state for unrelated sessions without explicit UI truth

Phase-1 rule:

- do not let `experimentalFeature/enablement/set`, `marketplace/add`, `config/value/write`, or `config/batchWrite` become implicit side effects of normal lane operation
- if any native config/feature mutation is allowed, it must go through one explicit host-owned bridge or be presented as an explicit global operation
- do not split truth between host config and native process-wide config without a reconciliation contract

### Native-review thread-identity plane

This sits between native review flows and our existing launch/chain/replay/task-log identity surfaces.

Its job is:

- keep inline review and detached review as separate identity behaviors
- prevent detached native review threads from being mistaken for activity on the original thread
- keep `/review` affordances honest about whether review stays inline or can spawn a secondary thread

Phase-1 rule:

- do not let native detached review create hidden second threads the app cannot model or replay honestly
- if detached review is unsupported, keep native review inline-only or keep `/review` affordances conservative
- if detached review is supported later, it must map explicitly into child-thread/sidechain truth rather than being inferred post hoc

### Native binary-version and protocol-surface plane

This sits between backend-lane identity and all capability/model/review/config claims that depend on the actual native runtime being executed.

Its job is:

- distinguish backend lane id from the actual native executable and protocol surface in use
- keep capability, model, review, and interactive claims tied to the real native runtime identity rather than to one coarse lane label
- prevent cache/status/UI truth from assuming one universal `codex-native` behavior across bundled binaries, external CLIs, or different protocol surfaces

Phase-1 rule:

- do not let `selectedBackendId === 'codex-native'` stand in for the full native capability contract
- if the chosen seam can resolve either bundled SDK binary or external CLI, status and probe identity must keep that distinction explicit or stay conservative
- if any app-server enrichment later depends on experimental API opt-in, that experimental surface must be explicit in capability truth instead of being ambient or version-assumed

### App-server connection-policy plane

This sits between later selective app-server enrichment and the app's assumptions about capability visibility, notification truth, and debugging signals.

Its job is:

- keep connection-scoped protocol negotiation from masquerading as global runtime truth
- keep missing fields, methods, or notifications attributable to connection policy instead of to phantom runtime drift
- prevent multiple app-server connection profiles from quietly producing different capability or live-event views of the same native lane

Phase-1 rule:

- do not let future app-server use mix connection policies invisibly
- if app-server is added later, keep one canonical connection profile by default
- if multiple connection profiles exist later, capability and notification differences must be explicit in logs/status/debugging truth

### Canonical-history and append-only-projection plane

This sits between native thread history authority and our current append-only transcript/log readers.

Its job is:

- keep canonical native history and append-only local projection from silently diverging after rollback or compaction
- prevent exact-log, replay, and task-log readers from trusting stale append-only tails after native history mutation
- force one explicit rule for how superseded history is represented after native rollback or native compaction changes replay truth

Phase-1 rule:

- do not let append-only local transcript automatically masquerade as canonical native history after rollback or compaction
- if append-only projection remains in phase 1, define how stale history is reconciled or marked superseded
- if canonical native history becomes authoritative, reload/exact-log/task-log must use that authority explicitly instead of relying on incremental append-only caches

### Turn-metadata, usage, and reroute-authority plane

This sits between native turn/session metadata and the app's current tendency to read usage/model truth from assistant transcript rows.

Its job is:

- keep seam-specific usage truth from being guessed from transcript rows that only happen to exist on current lanes
- keep restored token usage after resume/fork/reload attributable to the native source that actually owns it
- keep final model/reasoning-effort truth honest when persisted-resume fallback or model reroute changes what actually ran
- keep turn-plan/diff/reroute metadata available in the normalized layer without forcing fake transcript fields when the chosen seam cannot project them truthfully

Phase-1 rule:

- do not assume the last assistant transcript row owns native usage/model truth
- if native usage/model/reroute/plan truth arrives outside transcript rows, keep that authority explicit
- if the chosen seam does not expose a truthful field, surface `unavailable` or normalized-only truth instead of silently backfilling from configured model or stale assistant-row metadata

### Native thread-defaults and launch-intent plane

This sits between host launch persistence and native thread-local runtime defaults that can be restored or mutated independently of the original launch request.

Its job is:

- keep host launch intent separate from persisted native thread-defaults that may be restored on resume
- prevent relaunch, retry, restore, and runtime-summary surfaces from silently presenting launch-owned provider/model/effort as if they were still the live native thread defaults
- keep resume warnings and one-time model-switch semantics explicit when resumed native threads inherit or switch away from current launch intent

Phase-1 rule:

- do not assume saved launch params or config-owned provider/model/effort equal live native thread-defaults once a native thread has been resumed or had turn-level overrides applied
- if phase 1 allows resume, either persist enough native thread-default identity to explain the inherited runtime truth or force an explicit override or fresh-thread policy
- do not let resume guards compare only provider/model if effort or other native thread-default drift can still change real runtime behavior

### Native thread-status and warning-authority plane

This sits between native thread lifecycle truth and the host's current process, provisioning, and banner-style status surfaces.

Its job is:

- keep native `thread.status` truth from being flattened into generic process liveness or provisioning progress
- keep thread-scoped warnings and config/startup warnings attributable to the surface that actually owns them
- prevent runtime cards, banners, and team status from silently treating `runtimeAlive` or process existence as equivalent to native thread health

Phase-1 rule:

- do not assume host process liveness equals native thread `active` or `idle` truth
- if phase 1 cannot consume native `thread.status` directly on the chosen seam, keep UI/status copy explicit about the limitation instead of silently inventing equivalent states
- do not collapse config warnings, thread-scoped runtime warnings, and process or provisioning warnings into one undifferentiated warning channel

### Management plane

This is where plugin lifecycle and provider-specific environment management live.

For Codex plugins we want:

- `plugin-kit-ai` as the management engine
- real Codex runtime as the execution engine

That split must stay explicit.

## Proposed Normalized Event Model

The normalized layer should stay concept-level, not provider-wire-level.

Recommended first event families:

- `turn_started`
- `assistant_text`
- `reasoning`
- `usage_updated`
- `turn_plan_updated`
- `turn_diff_updated`
- `model_rerouted`
- `thread_defaults_restored`
- `tool_intent`
- `tool_progress`
- `tool_result`
- `mcp_call`
- `command_execution`
- `file_change`
- `approval_requested`
- `approval_resolved`
- `turn_completed`
- `turn_failed`
- `system_notice`

### Mapping rule

We should map provider-native activity into the **closest truthful normalized event**, not the closest Anthropic wire primitive.

Examples:

- Anthropic `tool_use` -> `tool_intent`
- Anthropic `tool_result` -> `tool_result`
- Codex `mcp_tool_call` -> `mcp_call`
- Codex `command_execution` -> `command_execution`
- Codex text output item -> `assistant_text`
- Codex reasoning item -> `reasoning`
- Codex resume restoring persisted thread-local model/effort/defaults -> `thread_defaults_restored`

### Non-goal

The normalized layer should **not** try to preserve full provider-native reconstruction ability in phase 1.

It should be optimized for:

- correctness
- UI usefulness
- analytics usefulness
- transcript projection

not for exact reverse-compilation back into provider-native streams.

## Transcript Compatibility Strategy

This is the most important addition to make the plan actually safe for `claude_team`.

### Rule

We should separate:

- runtime execution contract
- normalized event contract
- persisted transcript contract

Those are three different layers.

### Phase-1 persisted transcript rule

The first Codex-native rollout should keep a transcript shape that remains compatible with current `claude_team` parsers.

That means:

- no breaking replacement of current JSONL entry types
- no breaking replacement of current content block types
- no requirement that `claude_team` learn raw Codex item/event shapes first

### What must remain safe initially

The current parser contract recognizes entry types such as:

- `user`
- `assistant`
- `system`
- `summary`
- `file-history-snapshot`
- `queue-operation`

and content block types such as:

- `text`
- `thinking`
- `tool_use`
- `tool_result`
- `image`

So phase 1 should assume:

- the persisted transcript contract remains backward-compatible with those expectations
- any new metadata is additive

### Phase-1 transcript invariants

Backward-compatible entry labels are necessary, but not sufficient.

The first Codex-native rollout should preserve these invariants:

- streamed assistant transcript rows still carry stable `requestId` semantics for dedupe and approval correlation
- projected tool-result-like rows preserve `sourceToolUseID` and `sourceToolAssistantUUID` whenever there is a truthful originating action
- enriched `toolUseResult` remains available when current UI/read-model logic expects structured result data
- additive task metadata fields such as `boardTaskLinks` and `boardTaskToolActions` keep their existing contract shape
- rows that cannot truthfully satisfy those invariants must stay normalized-only instead of being forced into misleading transcript messages

This is the minimum bar for claiming that phase 1 is transcript-compatible.

### Phase-1 chain and sidechain invariants

The first Codex-native rollout should also preserve these structural invariants:

- persisted transcript rows still form a coherent `parentUuid` chain where current readers expect one
- rows that are not true transcript messages do not become accidental chain participants
- `isSidechain` remains truthful for member/subagent logs versus lead/main-thread logs
- `sessionId`, `agentId`, and `agentName` remain truthful enough for current team-log discovery and grouping logic
- projected internal-user/tool-result rows preserve current `isMeta` semantics where UI and analysis code already rely on that distinction

This is the minimum bar for claiming that phase 1 is safe for team-log and subagent-related UI, not just generic transcript parsing.

### Phase-1 live request-correlation invariants

The first Codex-native rollout should also preserve these live-state invariants:

- approval-request-like events still expose a stable request identifier usable by `pendingApprovals` and `resolvedApprovals`
- streamed assistant activity still supports request-scoped dedupe where current UI/read-model code already depends on `requestId`
- projected tool activity does not invent tool-link ids when no truthful originating action exists
- activity rows and exact-log selectors do not silently merge unrelated actions just because they are temporally close
- exact-log detail selection still has enough request/tool anchor evidence to keep the right assistant row when multiple streamed rows share one request lifecycle

This is the minimum bar for claiming that phase 1 is safe for live activity UX, not just persisted history UX.

### Recommended transcript projector behavior

The Codex-native lane should project normalized activity into the existing transcript family conservatively:

- assistant/user/system rows remain parseable by existing JSONL parser
- additive metadata may be added the same way task-log metadata is added today
- provider-native thread identity may be stored additively
- provider-native event richness that does not fit current transcript rows can remain in the normalized layer instead of forcing new raw transcript entry kinds immediately

### Why this matters

Without this rule, the migration quietly becomes a `claude_team` transcript format rewrite.

That is exactly the kind of hidden blast radius we want to avoid.

## UI Integration Rule

`claude_team` should not consume raw normalized runtime events directly as the first migration step.

The safer sequence is:

1. runtime backends emit provider-native events
2. orchestrator maps them to normalized events
3. orchestrator projects transcript-compatible persisted history
4. `claude_team` continues using existing transcript/read-model services
5. later, if useful, `claude_team` can adopt normalized DTOs more directly

This reduces UI regression risk significantly.

It also means:

- approval UI, activity rows, and runtime noise handling continue to depend on stable request-correlation semantics during the first rollout
- a transcript-compatible projector alone is not enough if live request identity becomes ambiguous

## Backend ID Compatibility Rule

`codex-native` must be introduced as an additive shared backend identity, not as an implicit reinterpretation of an existing id.

That means:

- orchestrator runtime types must add `codex-native` explicitly
- persisted runtime preference config must add `codex-native` explicitly
- main-process runtime status mapping must carry `codex-native` through `selectedBackendId` and `resolvedBackendId`
- renderer selectors and settings UI must render the new id without breaking existing `api` and `adapter` flows
- tests that assert current backend option lists or current labels must be updated consciously, not by accident

Practical rule:

- if the new lane exists, the user should be able to see and reason about it as a distinct backend lane
- if the user still selected `api`, we must not silently run `codex-native`

## What Changes Per Repo

### `agent_teams_orchestrator`

This repo takes the biggest change.

We want to:

- introduce a provider-neutral normalized event/log model
- add adapter mappers from current Anthropic/Gemini style streams into that model
- add a separate `Codex-native` backend lane through `@openai/codex-sdk / codex exec`
- keep the current Codex adapter path alive as fallback during migration
- avoid forcing `codex exec` events into fake `tool_use/tool_result` transport semantics
- preserve explicit request-correlation semantics through normalized events and transcript projection
- preserve truthful chain and sidechain identity through transcript projection
- add an explicit runtime status/settings contract for `codex-native`, including backend option truth and model-probe policy
- add an explicit approval/control adaptation contract instead of assuming current `control_request` semantics automatically carry over
- decouple Codex auth-mode env construction from Codex backend-lane selection so API-key auth can coexist with a real Codex-native lane
- align app config schema, IPC validation, and launch granularity with the new backend vocabulary instead of leaving `codex-native` as a runtime-only hidden state
- keep phase-1 Codex backend routing honest about its real scope, which likely remains process-wide rather than teammate-specific
- make provisioning-readiness probe cache backend-aware or explicitly invalidated so backend/auth switches cannot leave stale lane truth in UI
- keep external Codex CLI detection separate from actual `codex-native` lane readiness in runtime status and installer/provisioning summaries
- define explicit option-state semantics so backend selectors and provisioning summaries do not collapse `selectable`, `available`, and `verified` into one ambiguous readiness label
- define degraded-status behavior so transient runtime-status failures cannot silently erase backend-lane truth

We do **not** want to:

- replace the current Codex backend in one shot
- rewrite all providers around Codex-native semantics
- make transcript/log normalization depend on Anthropic wire events
- hide a new `codex-native` lane behind the old `api` backend identity

### `claude_team`

This repo should stay relatively stable compared with the orchestrator.

We want to:

- keep one multimodel runtime concept
- stay capability-aware per provider/backend lane
- consume normalized runtime/log DTOs where helpful, but keep transcript/read-model compatibility stable during the first rollout
- integrate plugin management through `plugin-kit-ai`
- keep Codex plugin support gated behind the real Codex-native lane
- keep approval UX and request-correlated activity rendering stable
- keep sidechain/main-thread log discovery and grouping stable
- evolve runtime settings/provisioning UI so `codex-native` does not conflict with the current “Codex runtime follows connection mode” assumption
- keep model verification, provisioning readiness, and installer/runtime summaries truthful per backend lane
- stop UI copy and env plumbing from implying that `Codex API key` always means the old Responses API execution lane
- keep launch/provisioning UX honest about whether backend choice is provider-global or launch-specific
- do not imply member-level mixed Codex backend lanes until launch/spawn plumbing can actually support them
- do not let provisioning-readiness UI reuse stale provider-scoped probe results after a backend/auth switch
- do not let runtime settings or installer/provisioning UI imply that a detected Codex CLI means the `codex-native` lane is already usable
- do not let runtime selector UX hide or overstate `codex-native` because it still assumes backend options are governed only by `available`
- do not let status-transport fallback silently collapse `codex-native` back into provider-only Codex truth
- separate connection-method copy from runtime-lane copy so banners and settings cannot describe the wrong lane with the right credentials

We do **not** want to:

- invent a fake Codex plugin support state while execution still goes through the old adapter lane
- force UI logic to infer runtime truth from provider labels alone
- accept a migration that breaks `selectedBackendId` / `resolvedBackendId` UI semantics or transcript invariants
- accept a migration that makes approval or request-correlation semantics ambiguous

### `plugin-kit-ai`

This repo remains the management engine, not the execution engine.

We want to:

- use it for catalog
- use it for discover
- use it for install/update/remove/repair
- use it for native Codex plugin placement through native marketplace/filesystem layout

We do **not** want to:

- make it responsible for running Codex plugins inside sessions
- blur installation and execution into one concern

## Codex-Native Lane Contract

The `Codex-native` lane should be treated as a distinct backend lane with its own capability truth.

### Phase-1 lane guarantees

Before we claim the lane is usable, it must prove:

- API-key mode works
- working directory is respected
- streaming events can be consumed and normalized
- thread/session resume behavior is understood
- the chosen seam's headless-vs-interactive capability boundary is explicit and truthful
- basic approval/sandbox behavior is understood without overclaiming unsupported server-request-style interactivity
- completed-turn history/trancript completeness is understood under the chosen `ephemeral` or non-ephemeral seam policy
- transcript compatibility projection does not break current `claude_team` parsers/read models

### Capability rule

Codex plugin support must be gated by the lane, not just by the provider.

That means:

- current adapter/API lane can keep `plugins: unsupported`
- `Codex-native` can become `plugins: supported` only after native plugin execution is actually proven in real sessions
- `Codex-native` must not implicitly become `manual approvals: supported` or `interactive prompts: supported` just because it is the native lane

## Codex Plugins Strategy

For Codex plugins we want:

- native Codex runtime execution
- native Codex marketplace/filesystem placement
- provider-aware plugin management in `claude_team`

Therefore:

- `plugin-kit-ai` is the management engine
- real Codex runtime is the execution engine

This is important because plugin installation and plugin execution are different concerns.

Installing a native Codex plugin is not enough by itself if the session still runs through our current Responses API adapter path.

## App Server Position

`codex app-server` remains relevant, but not as the first critical path for this migration.

It is better positioned as a later control-plane enhancement for things like:

- auth state
- MCP status and OAuth flows
- skills/config inspection
- external config import

For the first production rollout, it should not be the hard dependency for plugin lifecycle management.

## Updated Post-Phase-0 Recommendation

Phase 0 is now implementation-complete and evidence-backed.

That changes the recommended next steps.

We do **not** need Phase 1 to "fix" the native lane.

We need Phase 1 to:

- make rollout truth safer
- unlock the lane deliberately instead of implicitly
- expand the lane from a locked experimental path into an internal-usable path without regressing the old Codex fallback

Recommended sequence from here:

### Phase 0.5 - minimal smoke E2E

Assessment:

- `🎯 10   🛡️ 9   🧠 4`
- Rough surface: `250-700` lines

Goal:

- add a tiny end-to-end smoke/regression layer on top of the Phase 0 sign-off proof

Work:

- orchestrator smoke proof for:
  - raw native exec sign-off harness
  - projected warning/thread-status/execution-summary truth
  - `ephemeral` versus `persistent` history truth
- `claude_team` smoke test for:
  - unified runtime-status -> provider status -> renderer summary truth
  - transcript parser + exact-log parser over projected native rows
- keep these tests narrow and deterministic

Exit gate:

- one orchestrator native smoke command/evidence path is green
- one `claude_team` runtime-status smoke path is green
- one `claude_team` transcript/exact-log smoke path is green

### Phase 1 - internal unlock preparation

Assessment:

- `🎯 9   🛡️ 9   🧠 5`
- Rough surface: `900-1800` lines

Status as of 2026-04-19:

- implementation-complete
- sign-off evidence captured in [codex-native-runtime-phase-1-signoff-evidence.md](/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/docs/research/codex-native-runtime-phase-1-signoff-evidence.md)

Goal:

- prepare `codex-native` for safe internal unlock without changing default provider behavior

Work:

- define exact internal unlock policy:
  - who can enable the lane
  - where the feature flag lives
  - what "selectable but degraded" means
- keep capability truth conservative:
  - plugins unsupported
  - approvals unsupported
  - generic interactive prompts unsupported
  - no false MCP/app-server-grade claims
- make locked/degraded/ready native states explicit across:
  - runtime status
  - settings
  - dashboard/runtime copy
  - provisioning summaries
- keep old Codex lane the safe default and fallback
- add internal rollout evidence for:
  - missing native credentials
  - missing binary
  - degraded native status
  - fallback to old lane

Exit gate:

- `codex-native` can be enabled intentionally by internal users
- old Codex lane still remains default and healthy
- lane-specific degraded states are visible and honest

### Phase 2 - limited internal unlock

Assessment:

- `🎯 8   🛡️ 8   🧠 6`
- Rough surface: `700-1500` lines

Goal:

- allow controlled real usage of the native lane while keeping rollout blast radius small

Work:

- make the lane selectable under explicit internal policy
- keep `auto` away from `codex-native`
- collect real-world evidence on:
  - history completeness
  - warning attribution
  - thread-status truth
  - launch/replay truth
- only after that revisit broader capability expansion

Exit gate:

- internal users can use the lane intentionally
- no major regressions in old Codex lane
- no false capability claims in UI/status/provisioning surfaces

## Implementation Phases

### Phase 0 - proof spike

Goal:

- reduce the biggest architectural unknowns before broader implementation

Companion spec:

- [codex-native-runtime-phase-0-implementation-spec.md](/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan/docs/research/codex-native-runtime-phase-0-implementation-spec.md)

Spike checks:

- run a minimal `Codex-native` session through the chosen phase-0 execution seam
- capture streamed runtime events
- map them into a draft normalized event stream
- project a minimal transcript-compatible history sample
- verify `cwd`, API-key auth, and session completion behavior
- document where current permission/sandbox semantics match or diverge
- document how Codex thread id is stored without making it the sole UI history source
- explicitly compare SDK thread persistence behavior against raw `codex exec --ephemeral`
- explicitly identify whether the first lane can use SDK safely or needs a thinner raw CLI wrapper
- explicitly identify which provider-native interactive/control requests the chosen seam can surface at all versus which ones it rejects in headless mode
- explicitly lock whether phase 1 is a headless-limited lane on the chosen seam instead of implying app-server-grade interactivity
- explicitly compare non-ephemeral completed-turn backfill against `--ephemeral` runs so transcript completeness tradeoffs are visible, not assumed
- explicitly identify whether the chosen seam executes:
  - a bundled SDK-resolved Codex binary
  - an external user-installed Codex binary
  - or both under different conditions
- explicitly document how request identity is obtained from the Codex-native lane and how it maps into approval/live-activity UX
- explicitly switch backend/auth inputs during the spike and verify whether provisioning-readiness cache invalidates or returns stale truth
- explicitly compare provisioning-readiness truth against backend-aware model verification after a lane switch
- explicitly compare “Codex CLI detected” truth against actual lane availability so status/install UI cannot overclaim readiness
- explicitly test whether backend selector UX can represent a lane that is selectable but not yet authenticated/verified
- explicitly break unified runtime-status transport during the spike and verify that UI sees degraded transport, not silent loss of backend-lane truth
- explicitly verify that settings/dashboard summaries still describe the chosen lane correctly when auth mode and backend lane no longer map 1:1
- explicitly switch global Codex backend after saving launch params, draft team metadata, or restoring a backed-up team and verify replay/resume/runtime snapshots do not silently drift lanes without an explicit inherited-global contract
- explicitly compare team list summaries, draft cards, and synthetic provisioning cards against detailed runtime truth so summary surfaces do not imply lane certainty they do not actually carry

Exit gate:

- we understand whether the lane is good enough for a feature-flagged rollout
- we understand whether the chosen seam is headless-limited and what transcript/history recovery path phase 1 will depend on

### Phase 1 - normalized layer first

Goal:

- introduce the normalized internal event/log layer without changing provider execution paths yet

Work:

- define the normalized event schema
- add projection from current Anthropic/Gemini/current Codex streams
- add transcript compatibility projection rules
- keep current `claude_team` transcript/read-model consumers working unchanged

Exit gate:

- current providers still work
- logs/transcript projection can run from normalized events
- current `ParsedMessage`/exact-log/task-log paths remain compatible

### Phase 2 - feature-flagged Codex-native lane

Goal:

- add a real Codex runtime lane without making it the default immediately

Work:

- add `codex-native` backend lane
- keep current Codex adapter path as fallback
- gate the lane behind an explicit feature flag/runtime preference
- wire capability reporting per lane
- keep headless-seam limits explicit if phase 1 uses raw exec or the current SDK
- keep the chosen `ephemeral` or non-ephemeral backfill policy explicit in transcript/history handling

Exit gate:

- current Codex path still works
- Codex-native lane works in controlled tests
- headless or richer interaction limits are described truthfully for the chosen seam
- no false plugin-support claim yet unless actually proven

### Phase 3 - plugin management integration

Goal:

- integrate `plugin-kit-ai` as the plugin management engine

Work:

- catalog
- discover
- install/update/remove/repair
- native Codex plugin placement

Exit gate:

- management truth is provider-aware
- native plugin placement works
- Codex plugin support in UI remains honest and lane-aware

### Phase 4 - optional app-server enrichment

Goal:

- add selective control-plane value where it clearly reduces complexity

Possible areas:

- auth state
- MCP OAuth flows
- skills/config inspection
- external config import

This phase is optional for the first production rollout.

## Recommended First PR Sequence

This is the safest order to avoid hidden blast radius.

### PR 0 - decision freeze and backend lane naming

Repos:

- `claude_team`
- `agent_teams_orchestrator`

Goal:

- freeze the backend-lane vocabulary and rollout rules in code comments/docs/tests before runtime changes spread

Must lock:

- new Codex backend id naming
- capability gating rule
- transcript ownership rule
- transcript invariants that phase 1 is not allowed to break
- chain/sidechain invariants that phase 1 is not allowed to break
- whether the phase-0 spike is SDK-first, raw-exec-first, or undecided pending evidence
- whether `codex-native` is connection-managed or independently selectable in runtime settings/provisioning truth
- what the minimum truthful approval/control contract is for claiming manual approval support
- how Codex API-key auth interacts with backend selection env without silently forcing the old `api` lane
- whether the first rollout keeps backend choice global-per-provider or expands launch contracts to support per-launch lane selection
- whether backend routing remains process-scoped for phase 1 and how that limitation is reflected in team launch/provisioning UX
- what identities belong in the provisioning probe-cache key and which config/backend/auth changes must invalidate cached readiness immediately
- what exact contract separates external Codex CLI detection from `codex-native` lane selection, authentication, and verified readiness
- what exact semantics belong to `selectable`, `available`, `resolved`, and `verified` for backend options once `codex-native` is introduced
- what degraded-status contract preserves backend-lane truth when unified runtime-status transport fails transiently
- what wording contract separates Codex connection method labels from Codex runtime-lane labels across settings, dashboard, and provider detail views
- what sequencing/settledness contract governs progressive `cliStatus` snapshots versus explicit status/provider refresh requests
- what backend-aware truth model controls extension mutation preflight once Codex plugin support becomes lane-specific
- what runtime shape team model selectors and provisioning diagnostics are allowed to depend on once backend-lane truth matters
- what canonical backend/auth/probe identity keys reusable provider prepare/model results
- what launch params, `team.meta.json`, `members.meta.json`, backup artifacts, relaunch defaults, runtime snapshots, and resume guards persist about backend lane versus inheriting current global backend truth
- what backend-lane truth team summaries, draft cards, and provisioning snapshot cards expose versus intentionally omit
- what backend-lane truth member runtime summaries, bootstrap/system copy, and composer slash-command/plugin affordances expose versus intentionally omit
- what plugin-management result fields and UI states distinguish installed, active, usable in next thread, requires restart, and requires app/auth setup completion
- what invocation-shape truth phase 1 exposes for plugins/apps/skills on the chosen Codex seam: structured mention targeting, linked-text mention targeting, or no explicit targeting affordance yet
- what source is authoritative for active-turn streaming versus replayable/hydrated thread history, and how that rule protects exact-log/task-log/replay consumers from sparse live Codex payloads
- what event or contract clears pending approval/request-user-input state when the turn lifecycle resolves a request before the user answers
- what phase 1 does with provider-native `requestUserInput` and MCP elicitation requests that do not fit the current tool-approval UI
- whether the chosen phase-1 execution seam is explicitly headless-limited and which interactive/control features are therefore out of scope by seam, not just by UI
- whether phase 1 chooses `--ephemeral`, non-ephemeral exec with final backfill, or an explicit replacement hydration path for completed-turn item completeness
- what credential-routing contract authenticates raw exec or the current SDK for `codex-native`, and how that differs from the old `OPENAI_API_KEY` Codex lane
- what source is authoritative for `codex-native` model inventory, reasoning-effort options, disabled-model reasons, and preflight/default model choice
- what trust authority owns phase-1 `codex-native` launches, and whether native thread start is allowed to persist project trust at all
- what instruction channel owns phase-1 `codex-native` behavior among host system/bootstrap prompts, native base/developer instructions, and collaboration-mode built-ins
- what persisted-history policy phase 1 freezes for native thread start/resume/fork, and how lossy-vs-rich history truth is surfaced later
- whether any native app-server config/feature/marketplace mutation surface is allowed in phase 1 and, if so, through what host-owned bridge
- whether native review stays inline-only in phase 1 or whether detached review gets an explicit child-thread identity contract
- what native runtime identity fields are authoritative for capability truth beyond backend id: executable source, native binary version, protocol/capability revision, and stable-vs-experimental surface truth where relevant
- what one canonical app-server connection policy means later for `experimentalApi`, notification opt-out, and live subscription truth if selective app-server enrichment is introduced
- what source remains authoritative after native rollback or compaction mutates thread history: canonical native thread history, append-only local transcript, or one explicit reconciliation rule
- what source remains authoritative for native token usage, context-window truth, final model/reasoning-effort truth, and turn plan/diff/reroute metadata when those truths arrive outside assistant transcript rows
- what source remains authoritative when host launch intent differs from persisted native thread-defaults after resume or prior turn overrides, and how that drift is surfaced in config, summaries, resume guards, and relaunch truth
- what source remains authoritative for native thread loaded, active, idle, and system-error truth, and how that truth reconciles with host process liveness, provisioning state, and coarse runtime banners
- what warning channels remain distinct between native thread warnings, startup/config warnings, and process or provisioning warnings so the app never needs to guess which surface is actually unhealthy

### PR 1 - normalized event schema only

Repo:

- `agent_teams_orchestrator`

Goal:

- add normalized event types and mappers for current lanes only

Must not do:

- no Codex-native execution yet
- no transcript contract change yet

### PR 2 - transcript compatibility projector rules

Repo:

- `agent_teams_orchestrator`

Goal:

- define how normalized events project into persisted transcript-compatible history

Must prove:

- current `claude_team` parsers still work
- additive metadata pattern still holds
- `requestId`, tool-linking, and task-log enrichment invariants still hold
- approval/live request-correlation invariants still hold
- chain/sidechain identity invariants still hold
- runtime status/settings projection still stays truthful for backend summaries and provisioning status
- active live-stream events and replayable history remain separate enough that transcript readers, exact-log readers, and post-hoc task-log readers never depend on sparse live Codex payloads as canonical history
- pending approval/request state clears truthfully on explicit response, auto-resolution, interruption, or lifecycle cleanup without leaving stale renderer/store state
- unsupported interactive request types are either blocked explicitly or handled through a truthful UI path instead of silently stalling turns
- transcript/history completeness remains truthful under the chosen non-ephemeral-backfill or explicit-hydration strategy instead of depending on an implicit exec behavior that phase 1 has not frozen
- native-lane API-key readiness must come from the chosen exec/SDK credential-routing contract instead of inheriting old `OPENAI_API_KEY` readiness heuristics by accident
- lane-aware model inventory, disabled-model reasons, and reasoning-effort truth must stay aligned across verification probes, create/launch selectors, and runtime settings
- host trust boundary and native thread-start behavior must not drift into two different project-trust stories
- chosen instruction-owner policy must keep system/bootstrap behavior stable instead of duplicating or replacing it accidentally
- replay/exact-log/history projection must stay truthful under the chosen `persistExtendedHistory` policy instead of assuming retroactive history repair
- native config/feature/marketplace state must not mutate behind host-owned settings without one explicit source of truth
- native review affordances must not imply detached review support unless second-thread identity is modeled explicitly
- native status/probe/cache truth must not collapse bundled SDK binary, external CLI, and protocol-surface differences into one fake universal `codex-native` identity
- any later app-server enrichment must not let connection-policy drift masquerade as runtime capability or live-event drift
- canonical replay/history truth must not drift from append-only projected transcript after native rollback or compaction mutates thread-visible history
- native usage/model/reasoning-effort truth must not be inferred only from assistant transcript rows when the chosen seam exposes separate authoritative notifications or persisted thread metadata
- projected transcript, status, and warning surfaces must not collapse host launch intent and restored native thread-defaults into one fake runtime identity when those truths diverge
- projected transcript, status, and warning surfaces must not collapse native thread loaded or system-error truth into generic process-alive or provisioning-active status
- native thread warnings and startup/config warnings must stay attributable to distinct channels instead of degrading into one coarse “Codex warning” bucket

### PR 3 - Codex-native spike lane under feature flag

Repo:

- `agent_teams_orchestrator`

Goal:

- add the real Codex-native runtime lane without making it default

Must prove:

- API-key path
- cwd behavior
- stream normalization
- safe failure behavior
- chosen SDK/raw-exec seam does not create unexplained session persistence drift
- request identity is stable enough for approval UX and streamed dedupe
- exact-log anchor selection still has enough evidence after projection to avoid wrong assistant-row retention
- sidechain/main-thread identity and transcript parent-chain behavior remain explainable after projection
- runtime settings/provisioning/model verification surfaces can represent the lane honestly
- approval/control events either adapt truthfully into current approval UX or stay explicitly unsupported/limited
- API-key auth can target the intended Codex lane without stale env coupling forcing `adapter` or `api` unexpectedly
- config validation, saved settings, and launch/provisioning summaries all describe the same backend vocabulary and the same selection granularity
- team launch and teammate spawn behavior do not imply mixed Codex backend lanes that the current process/env model cannot actually deliver
- provisioning-readiness and model verification stay aligned after backend/auth switches instead of splitting on stale cached probe truth
- runtime status and installer/provisioning summaries do not treat detected Codex CLI presence as equivalent to verified `codex-native` availability
- backend selector and runtime summaries can represent `codex-native` as selectable-but-not-ready without hiding it or falsely advertising it as ready
- settings/dashboard/provider summaries do not describe `codex-native` using old auth-only labels once backend-rich truth exists
- transient runtime-status fallback cannot erase `codex-native` backend identity, option-state semantics, or lane-specific status copy without marking degradation explicitly
- progressive status transport and explicit provider refresh must not race into mixed or downgraded backend-lane truth in store/UI
- extension preflight and install buttons must not enable Codex plugin management from provider-wide truth when the selected lane is still old Codex, degraded, or unverified
- create/launch dialogs must not validate or explain Codex model choice using provider-wide truth that hides the selected lane
- provisioning warmup/model cache must not reuse results across lanes based only on backend summary display text
- saved launch params, draft team metadata, backup/restore artifacts, relaunch prefill, runtime snapshots, and resume guards must not silently drift teams onto a different Codex lane after global backend settings change
- team summaries, draft cards, and provisioning snapshot cards must not imply backend-lane truth they cannot actually represent
- member runtime summaries, bootstrap/system copy, and composer slash-command/plugin suggestions must not imply backend-lane truth they cannot actually represent
- plugin install/update results must not overclaim “ready now” when Codex-native truth is only “installed, use in a new thread/restarted session” or “install finished but app/auth setup still incomplete”
- chosen Codex execution seam must not overclaim deterministic plugin/app invocation support if the real phase-1 truth is only linked-text mention parsing or implicit runtime discovery
- active turn notifications, sparse `Turn` / `Thread` payloads, and replayable history hydration must not be conflated into one cache or one truth path
- pending approvals and request-user-input state must not outlive the active turn/run because lifecycle cleanup was never mapped back into renderer/store truth
- generic user-input or MCP elicitation requests must not silently dead-end because the app only knows approval sheets
- chosen raw-exec or SDK seam must not overclaim manual approval, generic interactive prompt, dynamic-tool, or other server-request parity if the actual headless seam rejects those flows
- if `--ephemeral` is chosen, final-turn item completeness must still be recovered through an explicit tested path instead of depending on exec's non-ephemeral backfill behavior
- old Codex API-key readiness and `codex-native` API-key readiness must not drift because UI/runtime still checks only `OPENAI_API_KEY` while the chosen seam expects `CODEX_API_KEY` or explicit SDK `apiKey`
- static provider-wide Codex model catalogs and disabled-model heuristics must not silently stand in for native-lane model truth when the chosen seam exposes different model metadata or effort options
- native thread start/resume must not silently persist project trust or bypass host trust-gated env/hook/LSP behavior
- chosen instruction channel must not silently override or duplicate host system/bootstrap prompts through collaboration-mode or native developer-instruction precedence
- native thread replay/history behavior must not quietly mix lossy and rich persisted-history policies without explicit thread-level truth
- native config/feature/marketplace helpers must not mutate process-wide or persistent native state outside host-owned settings truth
- native review flows must not silently spawn detached review threads the app cannot model, reload, or explain
- native binary source/version/protocol surface must not silently change lane capability truth while status, probes, and UI still treat `codex-native` as one universal runtime
- any later app-server enrichment must not silently mix connection-scoped stable/experimental surface or notification-subscription policies while UI/debugging still expects one global truth
- rollback or compaction must not silently leave append-only local transcript, exact-log, and replay readers on stale pre-mutation history
- native usage replay on resume/fork/reload must not depend on assistant transcript rows that never carried the authoritative usage payload in the first place
- model reroute or persisted-resume model/reasoning-effort fallback must not leave status, provisioning, or transcript projection claiming the stale configured model
- resumed native threads must not silently inherit persisted model, effort, or other thread-defaults while launch config, summaries, and resume guards still claim host launch intent is the live runtime identity
- host process liveness, provisioning activity, or runtime snapshot presence must not masquerade as native thread active or healthy truth when the native thread is `notLoaded` or `systemError`
- status and warning projection must keep native thread warnings, config warnings, and provisioning or process warnings distinguishable enough that later UI or debugging can explain what actually failed

### PR 4 - `claude_team` capability/UI adaptation

Repo:

- `claude_team`

Goal:

- make UI lane-aware without requiring a transcript format rewrite

Must prove:

- old Codex lane still renders honestly
- Codex-native lane does not overclaim plugin support
- dashboard/settings/status panels stay coherent while progressive status snapshots, provider refreshes, and model verification updates interleave
- dashboard, settings, provisioning, and team status surfaces distinguish host process or provisioning truth from native thread loaded, active, idle, and system-error truth instead of flattening them into one generic “runtime healthy” story
- banners, detail views, and runtime cards distinguish native thread warnings, config/startup warnings, and process/provisioning warnings instead of collapsing them into one coarse warning channel
- extension store mutation gating is backend-lane-aware for Codex instead of relying on provider-wide auth/capability shortcuts
- team model selectors and provisioning diagnostics are lane-aware enough to distinguish old Codex from `codex-native`
- provider prepare/model cache keys use canonical backend identity rather than UI summary text
- create/launch dialogs, draft-team retry flows, restore flows, and runtime details must say whether a team is pinned to a Codex lane or inheriting the current global lane instead of hiding that distinction
- team list/cards and provisioning snapshot cards either expose lane truth consistently or stay intentionally lane-agnostic without leaking lane-sensitive copy/actions
- member detail/cards, bootstrap/system summaries, and composer slash-command/plugin affordances either expose lane truth consistently or stay intentionally lane-agnostic without leaking lane-sensitive Codex capability hints
- launch dialogs, team/member runtime summaries, bootstrap/system copy, relaunch defaults, and restore flows must not present saved launch provider/model/effort as live runtime truth after a resumed native thread restored different defaults
- extension/plugin surfaces distinguish installed, usable in next thread, restart-required, and auth/setup-incomplete states instead of collapsing them into one generic “installed” story
- composer and extension/detail surfaces distinguish exact structured invocation support from linked-text or implicit invocation support instead of collapsing them into one generic “works with plugins/apps” story
- exact-log, task-log, replay, and reload flows stay grounded in explicit hydration or persisted transcript truth instead of opportunistically reusing partial live Codex event caches
- approval sheets, pending-approval blocks, and resolved approval icons reconcile explicit response and lifecycle cleanup truth without leaving stale pending rows
- any generic interactive prompt surfaced by Codex-native either has a truthful UI flow or an explicit unsupported-state treatment
- lane copy and capability UI do not imply app-server-grade interaction support when the selected execution seam is intentionally headless-limited
- settings/status/copy do not imply native-lane API-key readiness from old-lane credential checks alone
- settings/selectors/provisioning do not imply old provider-wide Codex model truth for a lane whose model inventory or reasoning-effort options differ
- trust/status/copy do not imply the workspace is trusted just because native Codex can start or because a native thread already exists
- bootstrap/system summaries and member/composer surfaces do not accidentally inherit hidden collaboration-mode built-ins or second instruction owners the UI cannot explain
- replay, reload, and exact-log surfaces can distinguish native threads with richer persisted history from native threads whose historical completeness is intentionally lossy
- runtime/settings/extensions surfaces do not drift from hidden native process-wide feature/config/marketplace state
- composer/runtime affordances do not imply detached `/review` behavior unless the resulting review-thread identity is surfaced honestly
- runtime/settings/provisioning/copy do not imply all `codex-native` lanes are capability-equivalent when executable source/version/protocol surface differs
- later app-server-backed UI/debugging surfaces do not imply every connection sees the same fields, methods, or notifications when connection policy differs
- replay/exact-log/task-log surfaces do not imply append-only local transcript is canonical after native rollback or compaction changed thread history
- context panels, token warnings, provisioning usage, and runtime copy do not imply assistant-row usage/model truth when native usage/model/reroute authority actually lives on separate seam-specific notifications or persisted metadata

### PR 5 - `plugin-kit-ai` management integration

Repos:

- `plugin-kit-ai`
- `claude_team`

Goal:

- add provider-aware plugin management with truthful Codex-native execution gating

Must prove:

- native placement works
- install does not imply runtime execution unless the lane is actually Codex-native
- management responses and UI states distinguish installed, usable after new thread/restart, and still-needs-auth/setup truth instead of collapsing them into one success state
- management/runtime integration does not imply first-class explicit plugin/app targeting unless the chosen Codex seam really exposes that invocation shape
- management/runtime integration does not imply approval or generic interactive parity when the selected Codex-native execution seam is still headless-limited
- management/runtime integration does not imply a plugin is usable in a workspace whose trust boundary or native-thread history policy is still unresolved
- management/runtime integration does not mutate native global config, feature state, or marketplaces behind the host's back
- management/runtime integration does not imply plugin/runtime parity solely from backend id when native binary source or protocol surface differs
- management/runtime integration does not silently depend on a richer app-server connection profile than the rest of the app actually uses
- management/runtime integration does not rely on append-only local transcript truth when native rollback or compaction can supersede that history
- management/runtime integration does not infer native turn usage/model/reroute truth from transcript rows when the chosen execution seam exposes those truths elsewhere or not at all
- management/runtime integration does not treat host process liveness or coarse provisioning health as proof that the current native thread is loaded, active, or warning-free

## Required Fixture Matrix

Broad enablement should stay blocked until the rollout has explicit fixtures for the highest-risk drift classes.

### `agent_teams_orchestrator` fixtures

- `old-codex-selected`
  - selected/resolved lane remains old Codex
  - plugin capability stays unsupported
  - normalized events and transcript projection stay stable
- `codex-native-selectable-not-verified`
  - `codex-native` appears in backend options
  - option-state truth distinguishes `selectable` from `available` and `verified`
  - status payloads do not collapse back into old Codex copy
- `codex-native-degraded-status-fallback`
  - transient runtime-status failure preserves last known lane truth or emits explicit degraded truth
  - backend ids/options do not disappear silently
- `progressive-status-race`
  - interleave progressive status snapshots, explicit refresh, and provider-model verification updates
  - fresher backend truth wins deterministically
- `plugin-installed-next-thread-only`
  - native placement succeeds
  - current-session activation is still false/unknown
  - result truth says next-thread or restart required
- `plugin-installed-auth-incomplete`
  - install succeeds
  - plugin remains blocked on app/auth setup
  - result truth stays distinct from generic success
- `linked-mention-only-seam`
  - chosen SDK/raw-exec seam can invoke plugin/app only through linked-text mentions
  - normalized/runtime truth does not overclaim structured targeting support
- `live-turn-stream-vs-hydrated-history`
  - active `item/*` notifications stream normally
  - `turn/*` and `thread/*` payloads stay sparse as documented
  - reconnect/unsubscribe/reload still requires explicit hydration for canonical history
  - explicit hydration or persisted transcript projection remains the canonical replay/history source
- `approval-lifecycle-cleanup-without-user-response`
  - approval or user-input request becomes non-pending because the turn completed/interrupted/restarted
  - renderer/store truth clears pending state without faking a user decision
- `interactive-request-unsupported-or-handled`
  - runtime emits `requestUserInput` or MCP elicitation
  - phase-1 behavior is explicit: handled truthfully or blocked with a clear limitation
- `exec-headless-rejects-interactive-server-requests`
  - chosen raw-exec or SDK seam rejects approval/user-input/dynamic-tool-style server requests exactly as expected
  - lane capability truth stays conservative instead of pretending these flows are app-supported
- `bundled-sdk-binary-vs-external-cli-detection`
  - chosen seam's real executable source is explicit
  - external CLI detection stays advisory when the lane actually runs through a bundled SDK-resolved binary
- `codex-native-api-key-routing`
  - old Codex API-key mode and native exec/SDK lane do not silently share one fake readiness source
  - chosen seam gets the credential in the shape it actually expects
  - status/issues/copy reflect native-lane auth truth rather than provider-wide `OPENAI_API_KEY` truth
- `native-lane-model-inventory`
  - chosen lane's model list, disabled-model reasons, and reasoning-effort options do not silently reuse old provider-wide Codex catalog truth
  - verification probes and selectors agree on what the lane actually supports
- `resume-persisted-thread-defaults-vs-launch-intent`
  - resumed native thread restoring persisted model, effort, or other thread-defaults does not silently masquerade as the current launch intent
  - normalized, status, and transcript truth either shows inherited defaults honestly or applies an explicit override or fresh-thread policy
- `resume-model-switch-warning-vs-runtime-copy`
  - resuming with a different requested model or default set does not leave runtime copy, provisioning copy, or relaunch truth claiming the switch already happened before the next turn proves it
- `thread-system-error-vs-process-alive`
  - native thread can enter `systemError` while the host process remains alive
  - normalized, status, and warning truth does not report the lane healthy from process liveness alone
- `thread-not-loaded-vs-runtime-still-running`
  - unsubscribe, inactivity, or explicit thread close can return native thread truth to `notLoaded` while host runtime/process still exists
  - status and projection distinguish loaded-thread truth from generic runtime availability
- `thread-warning-vs-config-warning-truth`
  - thread-scoped runtime warnings and startup/config warnings remain attributable to distinct channels
  - status, transcript, and later UI projection do not collapse them into one coarse warning state
- `native-trust-does-not-bypass-host-trust-boundary`
  - native thread start/resume in writable/full-access mode does not silently mark the workspace trusted before host trust is accepted
  - host trust-gated env/hook/LSP behavior remains under one explicit authority
- `collaboration-mode-does-not-double-inject-system-instructions`
  - chosen instruction-owner policy prevents hidden collaboration-mode or native developer-instruction layers from duplicating or replacing bootstrap/system prompt truth
  - host-selected model/effort/prompt semantics remain stable under the chosen lane
- `persist-extended-history-policy-frozen-at-thread-birth`
  - native thread start/resume/fork history richness is explicit
  - replay/exact-log truth can distinguish rich persisted history from intentionally lossy history
  - later config changes do not pretend to retroactively repair older threads
- `native-config-does-not-bypass-host-settings-ownership`
  - native config/feature/marketplace mutation surfaces do not silently create a second settings authority
  - any allowed mutation path is explicit and reconciled with host-owned config truth
- `native-review-inline-vs-detached-policy`
  - review affordances and runtime behavior agree on whether native review is inline-only or can spawn a detached review thread
  - detached review does not create hidden second-thread activity
- `native-binary-version-and-protocol-skew`
  - bundled SDK binary and external CLI with different versions or protocol surfaces do not collapse into one fake capability/readiness/model truth
  - cache/probe identity stays tied to the actual native runtime identity in use
- `app-server-connection-policy-skew`
  - future selective app-server enrichment does not get different fields, methods, or live notifications merely because one connection opted into a different policy
  - missing notifications stay diagnosable as connection-policy drift rather than phantom runtime breakage
- `native-history-mutation-vs-append-only-projection`
  - native rollback or compaction does not leave append-only projected transcript, exact-log, or replay on stale pre-mutation history
  - canonical-history reconciliation is explicit and testable
- `native-token-usage-replay-vs-assistant-row`
  - native usage after resume/fork/reload comes from the chosen seam's authoritative source
  - context-window and usage truth do not depend on assistant transcript rows carrying the same payload shape
- `native-model-reroute-vs-configured-model`
  - rerouted or persisted-resume model/reasoning-effort truth does not leave status, provisioning, or transcript projection claiming the stale configured model
- `native-plan-diff-metadata-authority`
  - turn plan/diff metadata is either projected truthfully from a supported seam or stays normalized-only / unavailable by explicit contract
- `ephemeral-turn-completed-without-backfill`
  - chosen ephemeral seam does not get exec's final non-ephemeral `thread/read` item backfill
  - transcript/history projector still produces truthful post-turn history through an explicit tested recovery path
- `non-ephemeral-completed-turn-backfill`
  - chosen non-ephemeral exec seam recovers completed-turn items through final backfill
  - transcript/history projector does not accidentally depend on a behavior that disappears if seam policy changes
- `team-replay-after-global-lane-switch`
  - save launch params or draft metadata on one lane
  - switch global Codex backend
  - replay/relaunch/restore outcome is explicitly inherited-global or explicitly pinned
- `request-chain-invariants`
  - projected Codex-native activity preserves:
    - `requestId`
    - tool-link fields
    - `parentUuid`
    - `logicalParentUuid`
    - `isSidechain`
    - `isMeta`

### `claude_team` fixtures

- `runtime-selector-visible-but-not-ready`
  - backend selector can show `codex-native` without falsely presenting it as ready
  - summary/copy remains lane-aware
- `plugin-installed-not-active-ui`
  - extension store/detail shows install success without claiming current-session activation
  - next-thread/restart guidance is explicit
- `plugin-auth-followup-ui`
  - extension surfaces keep “auth/setup still required” separate from “installed and usable”
- `mention-targeting-copy`
  - composer/detail UI distinguishes exact structured targeting from linked-text-only targeting
- `exact-log-hydrated-after-live-stream`
  - live Codex activity can render progressively
  - exact-log/task-log reload still comes from hydrated or persisted transcript truth rather than stale live event cache
- `approval-cleared-on-lifecycle`
  - approval sheet and pending-approval UI clear correctly when runtime cleanup happens without explicit allow/deny
  - resolved state does not incorrectly imply a user decision
- `generic-runtime-prompt-ui-truth`
  - user-input or MCP-elicitation flows do not masquerade as tool approvals
  - unsupported flows are visibly blocked instead of silently hanging
- `headless-lane-capability-copy`
  - runtime/settings/detail/composer copy does not imply manual approval or generic interactive support on a headless-limited exec seam
- `native-lane-auth-copy`
  - settings/status/detail copy does not imply `codex-native` API-key readiness from old Responses-API credential checks alone
- `native-lane-model-copy`
  - create/launch selectors, runtime settings, and provisioning hints do not imply the old Codex model catalog when the selected lane carries different model or effort truth
- `native-trust-copy`
  - status/settings/detail copy does not imply native thread start or writable sandbox means the workspace passed the host trust boundary
- `instruction-owner-copy`
  - bootstrap/member/composer/detail surfaces do not leak hidden collaboration-mode or native developer-instruction behavior the UI cannot explain
- `persisted-history-truth-copy`
  - replay/reload/exact-log surfaces can tell when native-thread history is rich versus intentionally lossy
- `native-config-ownership-copy`
  - runtime/settings/extensions surfaces do not imply host config is authoritative while hidden native process-wide state says otherwise
- `native-review-copy`
  - composer/runtime/detail surfaces do not imply detached review support unless review-thread identity is surfaced honestly
- `native-runtime-identity-copy`
  - runtime/settings/provisioning copy does not imply all `codex-native` lanes are capability-equivalent when executable source/version/protocol surface differs
- `app-server-connection-policy-copy`
  - later app-server-backed debug/status copy does not imply every connection sees the same surface when connection negotiation differs
- `canonical-history-copy`
  - replay/exact-log/task-log copy does not imply append-only local transcript remains canonical after native rollback or compaction changes thread history
- `context-panel-native-usage-truth`
  - context panel, token usage widgets, and provisioning usage copy do not guess native usage or context-window truth from stale assistant rows
  - restored usage or unavailable usage is shown honestly
- `native-reroute-copy`
  - runtime/settings/provisioning/detail copy does not imply the configured model still ran when native reroute or persisted-resume model/effort truth says otherwise
- `launch-intent-vs-native-defaults-copy`
  - launch dialogs, runtime details, and relaunch summaries do not present saved launch provider/model/effort as live runtime truth after a resumed native thread restored different defaults
- `resume-default-drift-warning-copy`
  - resumed native thread default drift is either shown honestly or blocked by explicit fresh-thread or override policy instead of being hidden behind unchanged launch badges
- `native-thread-status-vs-process-copy`
  - dashboard, settings, provisioning, and team detail copy do not equate process alive or provisioning active with native thread active or healthy truth
  - `notLoaded`, `idle`, and `systemError` states remain explainable even when the host runtime still exists
- `warning-channel-copy`
  - config warnings, native thread warnings, and process/provisioning warnings stay distinguishable in banners, detail views, and runtime cards
- `team-list-vs-detail-lane-truth`
  - team cards, provisioning snapshots, and runtime details do not disagree about pinned-vs-inherited lane identity
- `member-summary-vs-runtime-truth`
  - member runtime summary, bootstrap/system copy, and composer affordances do not overstate Codex-native capability or lane truth
- `provisioning-cache-switch`
  - switching backend/auth invalidates or bypasses stale prepare/probe truth
  - dialogs do not show old-lane readiness after the switch

### `plugin-kit-ai` fixtures

- `native-placement-without-runtime-execution`
  - placement succeeds on disk
  - contract truth does not imply active runtime execution
- `post-install-followup-truth`
  - contract can represent:
    - usable after new thread/restart
    - auth/setup still required
    - old lane selected so runtime execution still unsupported

Practical rule:

- if a risky seam has no explicit fixture, phase 1 should assume the seam is still unsafe

## Acceptance Gates By Repo

### `agent_teams_orchestrator`

The work is not ready if:

- Codex-native still depends on fake Anthropic tool loop assumptions
- normalized events cannot explain runtime activity needed by transcripts/UI
- transcript compatibility projection is still unspecified
- `codex-native` backend identity is not represented consistently in config/status payloads
- phase-0 spike still leaves SDK-vs-raw-exec persistence behavior ambiguous
- request-correlation semantics are still too vague for approval/live activity consumers
- chain/sidechain projection still leaves `parentUuid`, `isSidechain`, or `isMeta` semantics ambiguous
- runtime status, backend option lists, or model-probe policy still treat `codex-native` as an invisible variant of old Codex
- approval/control adaptation is still vague enough that allow/deny semantics or deadlock behavior are guesswork
- connection-mode env plumbing still silently rewrites Codex backend truth in a way that can bypass the new lane
- app config validation or launch contracts still reject or hide the backend vocabulary needed by the new lane
- launch/provisioning or teammate override UX implies per-member Codex backend choice while backend routing is still process-scoped
- provisioning probe cache still reuses provider-scoped readiness across backend/auth changes or lacks deterministic invalidation rules for the new lane
- runtime status or installer snapshots still let “Codex CLI detected” overrule actual lane availability/authentication truth
- renderer/backend-selector logic still assumes `available` is the only meaningful backend-option state once `codex-native` exists
- runtime-status fallback still collapses backend-rich Codex truth into generic provider-only fallback without an explicit degraded-state contract
- Codex status banners or settings summaries still derive “current runtime” from auth mode instead of backend lane when `codex-native` is available
- progressive status snapshots can still overwrite fresher provider/backend truth without explicit sequencing or settledness semantics
- team model/runtime helpers still collapse Codex into provider-wide auth/backend summary truth, making lane-specific model rules impossible to express
- team launch requests, draft metadata, backup artifacts, relaunch defaults, runtime snapshots, or resume guards still hide whether Codex backend lane is persisted or inherited, allowing silent lane drift after global settings changes
- team summaries, draft cards, or provisioning snapshot cards still cannot represent lane truth honestly enough for the UI surfaces that rely on them
- member runtime summaries, bootstrap/system copy, or composer slash-command/plugin affordances still key off provider-wide Codex truth where lane-specific semantics already differ
- plugin install/update results, activation states, or setup/auth follow-up truth still collapse installed, active-now, next-thread-visible, and app-auth-incomplete semantics into one generic success state
- chosen Codex execution seam still blurs structured invocation, linked-text mention invocation, and implicit plugin/app discovery enough that UI cannot describe plugin/app targeting honestly
- active live-stream truth and replayable history truth are still conflated enough that exact-log/replay consumers could read sparse live Codex payloads as canonical history
- approval/request cleanup semantics are still vague enough that interrupted or replaced turns can leave stale pending state
- provider-native generic interactive prompts still have no explicit phase-1 handling rule
- chosen raw-exec or SDK seam still overclaims approval, generic interactive, dynamic-tool, or other server-request parity that the headless seam explicitly does not provide
- chosen `--ephemeral` or non-ephemeral policy still leaves completed-turn item completeness ambiguous enough that transcript/history projection depends on unstated backfill behavior
- native-lane auth readiness still reuses old `OPENAI_API_KEY` heuristics even though the chosen exec/SDK seam authenticates differently
- native-lane model availability, disabled-model reasons, or reasoning-effort options still reuse old provider-wide Codex catalog truth
- native thread start/resume can still mutate project trust or bypass host trust-gated env/hook/LSP behavior without one explicit trust owner
- instruction ownership across host system/bootstrap prompts, native base/developer instructions, and collaboration-mode built-ins is still ambiguous enough that runtime behavior can drift silently
- native-thread replay/history truth still depends on implicit `persistExtendedHistory` policy instead of an explicit thread-level contract
- native-lane capability, model, or review truth still depends only on backend id while actual native binary source/version/protocol surface can differ
- later selective app-server enrichment can still vary capability or live notification truth by connection policy without one canonical connection profile
- native rollback or compaction can still mutate canonical history while append-only local transcript/log readers continue serving stale pre-mutation truth
- native usage/context/model/reroute truth can still be lost or guessed because the host only trusts assistant transcript rows while the chosen native seam delivers those truths separately or not at all
- host launch intent and persisted native thread-defaults can still drift silently enough that resume, relaunch, restore, or runtime copy tell a different runtime story than the actual native thread
- native thread status or warning truth can still collapse into process liveness, provisioning progress, or coarse provider banners, leaving `systemError` or `notLoaded` states invisible
- required high-risk fixtures for lane truth, status races, replay identity, plugin activation, invocation shape, history hydration, approval cleanup, and interactive prompts do not exist yet

### `claude_team`

The work is not ready if:

- it needs a breaking transcript parser rewrite for the first rollout
- it infers Codex plugin support from provider id instead of backend lane truth
- task-log and exact-log paths regress
- `selectedBackendId` / `resolvedBackendId` UX becomes misleading or ambiguous
- transcript invariants like `requestId` and tool-link fields are lost for projected Codex-native activity
- pending approval UX or request-scoped activity indicators become ambiguous or lossy
- sidechain/main-thread task logs or subagent-linked views regress because projected identity fields drift
- runtime settings still special-case Codex as connection-managed-only when a real `codex-native` lane exists
- provisioning readiness or model verification UI silently reports old Codex backend truth for the new lane
- connection/auth UI copy or saved settings still imply that Codex API-key auth always means the old Responses API backend
- launch/provisioning UX implies per-team or per-task backend control when backend selection is still only global-per-provider
- team spawn/runtime logs can still only inherit one process-level Codex backend while UI suggests mixed member-level lanes
- provisioning-readiness UI can still show stale old-lane readiness after a Codex backend/auth change because probe cache identity or invalidation is too coarse
- runtime settings or installer/provisioning UI still imply `codex-native` readiness from generic Codex CLI detection instead of lane-specific status truth
- runtime/backend selector UX still cannot represent a lane that is intentionally selectable but not yet verified
- transport failures in runtime status can still make `codex-native` disappear or revert to old connection-managed-only semantics in UI
- lane-aware backend truth still gets translated back into old `Codex subscription` / `OpenAI API key` runtime copy in a way that misdescribes the active lane
- extension store banners, install buttons, or mutation preflight still rely on coarse provider/runtime truth and can misstate Codex plugin availability for the selected lane
- team create/launch dialogs still use runtime helper types that omit backend-lane identity needed for Codex-native model/provisioning truth
- provider prepare/model cache still keys off backend summary copy instead of canonical backend identity
- saved launch params, draft metadata, restore flows, relaunch prefill, runtime cards, or resume behavior still hide lane identity badly enough that a team can replay on a different Codex backend without the UI noticing
- team list/cards or synthetic provisioning cards still imply lane truth they do not actually carry, or stay so lane-blind that they mislead users about pinned-vs-inherited runtime identity
- member cards/detail, bootstrap/system copy, or composer capability hints still imply old Codex and `codex-native` are equivalent because they only key off `providerId` / `model`
- extension/plugin UX still implies Codex-native install success means immediate current-session activation when the real truth is only next-thread/restart visibility or pending app/auth setup
- composer, slash-command, or extension-detail UX still implies exact plugin/app targeting support when the chosen Codex seam only gives us linked-text mention parsing or implicit runtime behavior
- exact-log/task-log/reload flows can still confuse live Codex event caches with hydrated transcript history
- approval UI can still leave stale pending rows or wrong resolved icons when runtime cleanup happens without explicit allow/deny
- generic runtime prompts or MCP elicitations can still hang because no truthful UI path exists
- runtime/settings/member/composer copy still implies app-server-grade interactivity for a headless-limited exec seam
- runtime/settings/status copy still implies `codex-native` API-key readiness from the old Codex lane's credential surface
- selectors/settings/provisioning still imply the old provider-wide Codex model catalog for a native lane with different model metadata or effort options
- trust/status/copy still implies native thread existence or writable sandbox means the workspace passed our host trust boundary
- bootstrap/member/composer surfaces can still be influenced by hidden collaboration-mode or native developer-instruction layers the UI cannot inspect or explain
- replay/exact-log/reload still cannot tell whether a native thread was created with rich or intentionally lossy persisted-history policy
- UI/settings/provisioning still imply one universal `codex-native` capability story even when native executable source/version/protocol surface can differ
- later app-server-backed surfaces still imply one global capability/notification truth even when different connections negotiated different app-server surfaces
- replay/exact-log/task-log can still imply append-only projected transcript is canonical even after native rollback or compaction superseded that history
- context panels, provisioning usage, token warnings, or runtime copy still assume assistant transcript rows own native usage/model truth even when the chosen seam routes those truths separately
- launch dialogs, runtime details, relaunch defaults, or bootstrap and member summaries still present saved launch provider/model/effort as live runtime truth after a resumed native thread restored different defaults
- status banners, runtime cards, provisioning summaries, or team detail views still equate host process/provisioning truth with native thread loaded or healthy truth
- warning copy still collapses native thread warnings, config warnings, and provisioning/process warnings into one undifferentiated status message
- required high-risk fixtures for selector truth, extension activation truth, mention-targeting copy, replay/provisioning drift, history hydration, approval cleanup, and interactive prompts do not exist yet

### `plugin-kit-ai`

The work is not ready if:

- install/update/remove/discover truth is not machine-readable enough for app use
- native placement success is confused with runtime execution success
- management integration still cannot surface follow-up truth like “use in a new thread/restarted session” or “app/auth setup still required” when Codex-native plugin placement succeeds
- required management fixtures for placement-without-execution and post-install follow-up truth do not exist yet

## No-Go Conditions

We should not enable `Codex-native` broadly if any of these are still true:

- normalized projection still drops critical runtime activity needed by UI or transcripts
- lane-level capability reporting cannot distinguish old Codex path from real Codex-native path
- session resume semantics are still unclear enough to risk dual-persistence bugs
- plugin support would still be advertised while execution remains on the old adapter lane
- the new lane forces Anthropic/Gemini behavior regressions just to keep one fake protocol
- the first rollout requires `claude_team` to adopt a breaking new transcript format
- backend selection settings or UI still cannot represent `codex-native` honestly
- the chosen SDK/CLI seam still makes session persistence behavior implicit instead of explicit
- live approval or request-correlation behavior is still under-specified enough to risk wrong approvals or wrong dedupe
- chain/sidechain identity is still under-specified enough to risk broken task-log grouping or subagent linkage
- runtime status/provisioning/model verification surfaces still cannot represent `codex-native` truthfully
- approval/control adaptation still cannot describe a safe allow/deny loop without hand-waving
- auth-mode env routing still forces the old Codex backend semantics even when the selected runtime lane is `codex-native`
- config schema and launch granularity are still inconsistent enough that the user can select a lane the app cannot actually persist or launch honestly
- process-scoped backend routing is still hidden enough that the user can configure mixed Codex lanes the runtime cannot actually realize
- provisioning probe cache can still mask backend/auth changes long enough to leave readiness truth out of sync with model verification or backend selection UI
- external Codex CLI detection is still being interpreted as lane readiness or plugin support truth for `codex-native`
- backend option-state semantics are still loose enough that `codex-native` cannot be shown honestly before it is fully ready
- backend-rich Codex truth is still too easy to lose during transient status transport failure, making UI behavior nondeterministic
- runtime summary wording is still too tied to auth mode to safely explain `codex-native` in dashboard/settings/provisioning UX
- progressive `cliStatus` updates can still race explicit status/provider refresh paths and silently downgrade backend-lane truth
- extension action gating still uses provider-wide truth where `codex-native` needs backend-lane-specific readiness
- create/launch model selection and provisioning still collapse Codex into provider-wide truth, making lane-specific model handling too ambiguous to ship safely
- provisioning prepare/model cache still depends on summary-copy identity rather than canonical backend identity
- persisted team identity, replay, or resume still cannot distinguish intentional global-backend inheritance from accidental Codex lane drift
- team summaries and list surfaces still cannot express lane truth or intentional lane-agnosticism clearly enough to avoid misleading team-level UI
- member runtime summaries, bootstrap/system copy, or composer capability hints still cannot express lane truth or intentional lane-agnosticism clearly enough to avoid misleading member-level UI
- extension/plugin UX still cannot express installed-vs-active-vs-usable truth clearly enough to avoid overstating Codex-native plugin readiness
- plugin/app invocation affordances still cannot express structured-vs-linked-text targeting truth clearly enough to avoid overstating Codex-native integration maturity
- active live notifications can still masquerade as canonical history for replay/exact-log/task-log consumers
- approval lifecycle cleanup can still masquerade as user resolution or fail to clear pending state
- generic provider-native interactive prompts can still be unsupported in practice while the lane appears otherwise feature-complete
- the chosen exec/SDK seam still looks interactive-capable in UI or status copy even though the seam itself is headless-limited
- the chosen `--ephemeral` / non-ephemeral seam policy still leaves final-turn transcript completeness dependent on implicit exec backfill behavior
- the chosen `codex-native` auth path still looks ready in UI while credential-routing remains wired only for the old Codex lane
- the chosen `codex-native` lane still looks model-compatible in UI while selectors/probes use only old provider-wide Codex catalog truth
- native Codex start/resume can still create or imply project trust outside the host trust contract
- collaboration-mode or native developer-instruction precedence can still change runtime behavior without one explicit instruction owner
- native-thread history completeness can still depend on implicit `persistExtendedHistory` behavior that replay/exact-log/UI never surface
- backend id can still masquerade as full native capability truth even when bundled SDK binary, external CLI, or protocol surface differ
- later app-server enrichment can still masquerade as globally consistent even when connection-scoped negotiation changes which methods, fields, or notifications are visible
- native history mutation can still leave append-only local transcript, incremental file watchers, and replay readers out of sync on what the conversation canonically contains
- native token usage, context-window truth, or final model/reroute truth can still be guessed from assistant transcript rows even though the chosen seam exposes those truths separately or not at all
- host launch intent and persisted native thread-defaults can still drift without one explicit authority or visible warning, leaving resume, relaunch, restore, or runtime-summary truth inconsistent with the actual native thread
- native thread loaded, active, idle, or system-error truth can still collapse into host process or provisioning truth, making thread health invisible or misleading
- config warnings, native thread warnings, and provisioning/process warnings can still collapse into one coarse status story
- the required high-risk fixture matrix still does not exist, leaving the riskiest Codex-native seams unpinned against regression

## Main Risks And Guardrails

### Risk 1 - treating `codex-sdk/exec` as a transport-only swap

This is the most dangerous mistake.

Guardrail:

- treat `Codex-native` as a separate runtime lane
- normalize logs/events above it
- do not assume the current Anthropic-shaped tool loop can be preserved unchanged

### Risk 2 - claiming Codex plugin support too early

Installing native Codex plugins is not enough if execution still runs through the current adapter path.

Guardrail:

- only advertise Codex plugin support when the session actually runs through the Codex-native lane

### Risk 3 - overcommitting to `app-server` too early

`codex app-server` is useful, but it should not become a hard dependency for the first production plugin rollout.

Guardrail:

- use it later for selective control-plane features
- do not block the first migration on `app-server plugin/*`

### Risk 4 - designing the normalized layer as an Anthropic alias

If the normalized layer is secretly just Anthropic wire semantics with renamed fields, it will create false constraints and future bugs.

Guardrail:

- normalize to concepts
- not to one provider's transport

### Risk 5 - dual session truth

The current orchestrator already has session/transcript logic, while real Codex runtime also has its own session model.

Guardrail:

- keep `Codex-native` feature-flagged until resume and transcript ownership are understood well enough

### Risk 6 - hidden transcript-format rewrite

This is the biggest UI risk.

Guardrail:

- keep transcript compatibility as a first-class phase-0/phase-1 constraint
- treat additive transcript enrichment as the default pattern
- do not require `claude_team` exact-log or task-log services to learn raw Codex-native item shapes in the first rollout

### Risk 7 - backend-id drift between orchestrator and UI

`codex-native` looks small as a concept, but backend ids are already part of shared config and UI payloads.

Guardrail:

- treat backend-id expansion as a first-class contract change
- update orchestrator config types, runtime status payloads, main mapping, renderer selectors, and tests together
- do not ship a lane whose identity only exists in one repo

### Risk 8 - accidental durable Codex session ownership

If we go SDK-first without addressing the current `ephemeral` gap, we may accidentally make durable Codex session storage part of the rollout semantics before we intend to.

Guardrail:

- make SDK-vs-raw-exec an explicit phase-0 checkpoint
- require the spike to document persistence behavior, resume behavior, and whether the lane can run without durable Codex-owned sessions
- do not hand-wave this away as an implementation detail

### Risk 9 - request-correlation drift between runtime, normalized events, and UI

If request identity stops meaning the same thing across layers, approval UX, exact-log selectors, and streamed dedupe will regress in subtle ways.

Guardrail:

- treat request-correlation as its own phase-0/phase-1 contract
- require the normalized layer to document how request identity is sourced and preserved
- require projector tests that cover approval-like events, request-scoped dedupe, and tool-link correlation

### Risk 10 - chain and sidechain identity drift

If projected Codex-native rows stop preserving truthful `parentUuid`, `isSidechain`, `isMeta`, `sessionId`, or `agentId` semantics, team-log discovery and exact-log views can regress even while basic JSONL parsing still “works”.

Guardrail:

- treat chain and sidechain semantics as first-class projector constraints
- require projector tests that cover main-thread rows, sidechain rows, and internal-user/tool-result rows
- do not allow convenience projection rules that flatten sidechain identity or create fake parent-chain participation

### Risk 11 - runtime status/settings and probe drift

If `codex-native` exists in execution but not in runtime settings, provisioning summaries, installer snapshots, or model verification policy, the UI will display stale or contradictory truth.

Guardrail:

- treat runtime status/settings as a first-class contract layer
- update backend selector truth, provisioning summaries, installer snapshots, and backend-aware model probe signatures together
- require tests that cover `selectedBackendId`, `resolvedBackendId`, backend summary rendering, and probe-signature invalidation for the new lane

### Risk 12 - approval/control adaptation drift

If Codex-native approval/control events do not map truthfully into the current `ToolApprovalRequest` and `requestId` contract, pending approvals, approval icons, and allow/deny responses will regress in subtle ways.

Guardrail:

- treat approval/control adaptation as its own contract layer
- require tests that cover emitted approval requests, resolved approval state, timeout behavior, and unsupported-control fallback
- if the mapping is not truthful yet, keep manual approval support explicitly limited for the lane

### Risk 13 - auth-routing and backend-routing drift

If Codex auth mode continues to rewrite `CLAUDE_CODE_CODEX_BACKEND` implicitly, the new lane can be selected in UI but never actually reached at runtime.

Guardrail:

- treat connection/auth env routing as its own contract layer
- require tests that cover Codex OAuth, Codex API-key mode, and backend selection independently
- require UI copy and saved settings to stop equating “OpenAI API key” with “old Responses API lane” once `codex-native` exists

### Risk 14 - config-schema and launch-granularity drift

If the orchestrator gains `codex-native` but app config validation and launch contracts still only understand the old Codex backend world, users can see or save a lane choice that provisioning cannot actually launch truthfully.

Guardrail:

- treat config schema and launch granularity as first-class rollout constraints
- update runtime config types, IPC validation, saved defaults, and provisioning summaries together
- require tests that prove the same backend vocabulary is accepted by config, surfaced in UI, and represented honestly during launch/provisioning

### Risk 15 - process-scope backend-routing drift

If Codex backend routing is still inherited from process env while UI or team launch copy implies member-level backend choice, one launched runtime can silently run a different backend mix than the user thinks.

Guardrail:

- treat backend-routing scope as a first-class rollout constraint
- require tests and logs that prove what scope backend selection actually has during team launch and teammate spawn
- keep phase-1 UX explicit that mixed Codex lanes inside one launched runtime are unsupported until spawn contracts say otherwise

### Risk 16 - provisioning probe-cache and invalidation drift

If provisioning-readiness cache stays keyed only by provider-level identity, a backend/auth switch can leave stale old-lane readiness visible while model verification and runtime settings already describe the new lane.

Guardrail:

- treat probe-cache identity and invalidation as a first-class rollout contract
- require tests that switch Codex backend/auth inputs and prove readiness cache invalidates or bypasses stale entries deterministically
- do not allow provider-only cached readiness to survive lane changes silently for `codex-native`

### Risk 17 - external-runtime diagnostic drift

If runtime status keeps surfacing “Codex CLI detected” without a stricter contract, UI and installer/provisioning summaries can overstate `codex-native` readiness even when the lane is still unavailable, unauthenticated, or unsupported.

Guardrail:

- treat external-runtime diagnostics as advisory, not as execution truth
- require tests that distinguish binary detection from backend selection, backend resolution, and authenticated readiness
- require tests that distinguish external user-installed CLI detection from bundled SDK-binary availability when the chosen seam may not use the user's PATH binary at all
- do not let Codex CLI detection upgrade plugin support or lane availability by implication

### Risk 18 - backend-option state drift

If runtime status keeps emitting `selectable` and `available` but renderer/backend-selection UX only understands one readiness boolean, `codex-native` can be hidden when it should be configurable or shown as ready when it is only selectable.

Guardrail:

- treat backend-option state semantics as a first-class shared contract
- require tests that cover selectable-but-unavailable, resolved-but-degraded, and verified-ready states
- do not let renderer/backend selector infer state transitions from `available` alone

### Risk 19 - runtime-status fallback drift

If backend-rich runtime status can still collapse into legacy provider-only fallback during transient failures, `codex-native` can disappear from UI or revert to old Codex semantics without any real backend change.

Guardrail:

- treat degraded status transport as its own first-class state
- require tests that simulate `runtime status --json` failure and verify backend-lane truth is preserved or explicitly marked degraded
- do not let fallback to `auth status` / `model list` silently erase backend ids, option-state semantics, or lane-specific copy

### Risk 20 - runtime-copy and summary drift

If Codex UI copy continues to derive “Current runtime” from auth mode while backend truth becomes lane-aware, dashboard/settings/provisioning summaries can confidently say the wrong thing even when the backend itself is correct.

Guardrail:

- treat runtime-summary wording as a shared contract, not as decorative UI copy
- require tests that cover mismatched auth-mode and backend-lane combinations
- do not let `Codex subscription` / `OpenAI API key` stand in for actual runtime-lane labels once `codex-native` exists

### Risk 21 - progressive status-snapshot drift

If progressive `cliStatus` snapshots, cached status responses, and provider-specific refreshes keep mutating store truth without a shared sequencing/settledness contract, `codex-native` can appear, disappear, or regress nondeterministically in UI.

Guardrail:

- treat progressive status transport as its own contract layer
- require tests that cover interleaving:
  - `fetchCliStatus()`
  - `fetchCliProviderStatus()`
  - late model-verification updates
  - transient degraded status pushes
- do not let the `cliInstaller:progress` status path bypass freshness/authority rules silently

### Risk 22 - extension preflight truth drift

If extension action gating keeps relying on coarse provider/runtime truth, Codex plugin management can be enabled on the wrong lane or disabled after the right lane is already selected.

Guardrail:

- treat extension preflight as a backend-aware contract, not just as generic runtime readiness
- require tests that cover old Codex lane, `codex-native` selectable-but-unverified, degraded status, and authenticated-ready lane states
- do not let provider-wide plugin capability or auth status stand in for backend-lane execution truth

### Risk 23 - team-model runtime truth drift

If team model selectors and provisioning diagnostics keep consuming only provider-wide Codex truth, `codex-native` can have different model semantics while create/launch UI still validates and explains models as if Codex were one runtime.

Guardrail:

- treat team-model runtime shape as a shared contract, not as an incidental UI helper type
- require tests that cover old Codex versus `codex-native` model visibility, selection errors, and provisioning notes
- do not let provider-wide auth/backend summary heuristics stand in for canonical backend-lane identity

### Risk 24 - provisioning prepare-cache identity drift

If reusable provider prepare/model results keep keying off backend summary text, copy changes or label collisions can silently merge or split cache entries across different Codex lanes.

Guardrail:

- treat provisioning cache identity as canonical backend/auth/probe identity
- require tests that switch lanes, auth modes, and summary wording without causing false cache hits or misses
- do not let display summary strings participate in cache identity once `codex-native` exists

### Risk 25 - launch persistence and resume identity drift

If saved launch params, draft team metadata, member metadata, backup artifacts, runtime snapshots, and resume guards stay provider/model-only, teams can silently move onto a different Codex lane after a global backend change while UI still implies continuity.

Guardrail:

- treat team launch identity as a first-class contract whenever backend lane changes runtime semantics
- require tests that:
  - save launch params on one lane
  - persist draft team metadata on one lane
  - restore a backed-up team created on one lane
  - switch global Codex backend
  - relaunch or resume
- verify whether the result is explicitly inherited-global or explicitly pinned
- do not let resume guards compare only provider/model once Codex lane changes can alter runtime behavior

### Risk 26 - team-summary and list-surface truth drift

If team summaries, draft cards, and synthetic provisioning cards stay lane-blind while detailed runtime truth becomes lane-aware, users can see one Codex story in cards/lists and a different one in launch/runtime detail views.

Guardrail:

- treat team-summary surfaces as an explicit shared contract, not as incidental UI decoration
- require tests that compare:
  - draft card truth
  - persisted team summary truth
  - provisioning snapshot truth
  - detailed runtime truth
  across old Codex, `codex-native`, and inherited-global scenarios
- do not let team cards imply pinned/runtime-specific lane truth unless the shared `TeamSummary` contract actually carries it

### Risk 27 - member-runtime summary and composer-capability truth drift

If member cards/detail, bootstrap/system summaries, and composer capability hints stay provider-wide while backend truth becomes lane-aware, users can see one Codex story in runtime/settings surfaces and another in member/composer surfaces.

Guardrail:

- treat member-runtime/composer surfaces as an explicit shared contract, not as cosmetic helper copy
- require tests that compare:
  - runtime status truth
  - member runtime summary truth
  - bootstrap/system runtime summary truth
  - composer slash-command/plugin affordance truth
  across old Codex, `codex-native`, degraded, and inherited-global scenarios
- do not let `providerId === 'codex'` alone unlock lane-sensitive copy or Codex capability hints once backend lane semantics differ

### Risk 28 - plugin activation and session-visibility truth drift

If extension/plugin UX keeps collapsing “installed”, “active now”, “usable after new thread/restart”, and “still needs app/auth setup” into one generic success state, Codex-native plugin support will be overstated even when runtime execution is otherwise correct.

Guardrail:

- treat plugin activation/session visibility as a first-class shared contract, not as incidental success copy
- require tests that compare:
  - native placement success
  - selected backend lane truth
  - current-session visibility truth
  - next-thread/restart-required truth
  - app/auth-setup-complete truth
  across old Codex, `codex-native`, degraded, and ongoing-session scenarios
- do not let generic install/uninstall success banners stand in for actual execution readiness

### Risk 29 - mention-targeting and invocation-shape truth drift

If phase 1 blurs structured mention targeting, linked-text mention targeting, and implicit runtime plugin discovery into one generic “plugin/app invocation works” story, Codex-native integration can overpromise deterministic behavior the chosen seam does not actually guarantee.

Guardrail:

- treat invocation shape as a first-class contract, not as a side effect of install success
- require tests that compare:
  - app-server-style structured mention truth
  - chosen SDK/raw-exec invocation truth
  - linked-text mention behavior
  - no-explicit-targeting fallback behavior
  across plugins, apps, and skills where relevant
- do not let composer/extension UX imply exact targeting semantics that are not backed by the chosen execution seam

### Risk 30 - live-stream and history-hydration truth drift

If phase 1 blurs active turn notifications, sparse turn/thread payloads, and replayable thread history into one generic “conversation state” cache, Codex-native integration can look correct while exact-log, task-log, replay, or resume flows quietly consume incomplete history truth.

Guardrail:

- treat live activity and replayable history as separate first-class contracts
- require tests that compare:
  - live `item/*` stream truth
  - sparse `turn/*` and `thread/*` payload truth
  - explicit `thread/read` / `thread/turns/list` / `thread/resume` hydration truth
  - persisted transcript projector truth
  across active turns, reconnect/reload, interrupted turns, and post-hoc exact-log reads
- do not let any one in-memory event cache become the implicit source of truth for replay/exact-log/task-log unless it can prove the same completeness guarantees as the explicit hydration path

### Risk 31 - approval lifecycle cleanup truth drift

If phase 1 blurs explicit user approval, runtime auto-resolution, lifecycle cleanup, and run dismissal into one generic “request resolved” story, Codex-native integration can leave stale pending approvals in UI or mark requests resolved as if the user explicitly answered when they did not.

Guardrail:

- treat approval cleanup semantics as a first-class contract, not as a side effect of request correlation
- require tests that compare:
  - explicit allow/deny response
  - runtime auto-resolution
  - lifecycle cleanup on turn start/complete/interrupt
  - run-level dismissal
  across pending approval sheets, resolved approval icons, and activity rows
- do not let renderer/store assume that successful user-response IPC is the only valid path that clears pending approval state

### Risk 32 - generic interactive-request truth drift

If phase 1 quietly assumes that tool-approval UI covers `requestUserInput` or MCP elicitation, Codex-native turns can stall or degrade in ways the app cannot explain, while the lane still appears broadly functional.

Guardrail:

- treat generic interactive prompts as a first-class contract, not as a subtype of approvals
- require tests that compare:
  - approval-only flows
  - generic user-input prompts
  - MCP elicitation requests
  - unsupported-path behavior
  across active turns and blocked/setup-heavy workflows
- do not let the lane claim interactive parity unless the app can truthfully surface and resolve the provider-native prompt types it may emit

### Risk 33 - headless exec capability truth drift

If phase 1 blurs headless exec/SDK behavior with richer app-server behavior, Codex-native can look like a generally interactive runtime even though the actual execution seam rejects whole classes of server-request-style interactions.

Guardrail:

- treat headless exec capability limits as a first-class lane contract, not as an implementation footnote
- require tests that compare:
  - chosen raw-exec or SDK seam behavior
  - approval-like flows
  - generic `requestUserInput`
  - MCP elicitation
  - dynamic-tool or server-request-style controls
  against the capabilities the UI/status payloads claim
- do not let the lane advertise approval or interactive parity that belongs only to richer seams the rollout is not actually using

### Risk 34 - ephemeral completion-backfill truth drift

If phase 1 chooses `--ephemeral` for session-safety reasons without replacing non-ephemeral exec's final completed-turn backfill, Codex-native can look correct in live demos while post-turn history, transcript projection, or exact-log completeness quietly degrades.

Guardrail:

- treat `--ephemeral` versus non-ephemeral backfill as a first-class rollout choice, not as a low-level runtime flag
- require tests that compare:
  - non-ephemeral exec with final `thread/read` backfill
  - ephemeral exec without that backfill
  - explicit projector/hydration recovery behavior
  across final assistant message capture, completed-turn items, exact-log, and replay reads
- do not let transcript/history UX depend on implicit exec recovery behavior that disappears when seam policy changes

### Risk 35 - native-lane credential-routing truth drift

If phase 1 keeps reusing old Codex API-key routing assumptions while the chosen native seam actually authenticates through a different credential surface, `codex-native` can look ready in settings/status while the runtime still starts with the wrong auth shape.

Guardrail:

- treat native-lane credential routing as a first-class contract, not as a side effect of old Codex API-key support
- require tests that compare:
  - old Codex lane API-key readiness
  - native exec/SDK lane API-key readiness
  - stored-key routing
  - env-var routing
  - status/issue/copy truth
  under the same user-facing “Codex API key configured” conditions
- do not let provider-wide `OPENAI_API_KEY` truth stand in for native-lane auth truth unless the chosen seam explicitly uses and proves that same path

### Risk 36 - native-lane model inventory truth drift

If phase 1 keeps reusing old provider-wide Codex model catalogs, disabled-model heuristics, and probe defaults while the selected native lane exposes a different model surface, UI and provisioning can look internally consistent while still lying about what the lane really supports.

Guardrail:

- treat native-lane model inventory and reasoning-effort truth as a first-class contract, not as a cosmetic catalog problem
- require tests that compare:
  - old Codex catalog truth
  - native-lane visible models
  - disabled-model reasons
  - default/preflight model choice
  - supported reasoning-effort options
  across create/launch selectors, runtime settings, provisioning hints, and verification probes
- do not let static provider-wide Codex heuristics stand in for native-lane model truth once the selected lane materially changes available model metadata

### Risk 37 - workspace-trust ownership drift

If native Codex thread start/resume is allowed to imply or persist project trust independently from the host trust dialog, the rollout can silently mutate trust state or unlock trust-gated behavior without the app's existing security story staying true.

Guardrail:

- treat host trust ownership as a first-class contract, not as an implementation detail
- require tests that compare:
  - host trust not yet accepted
  - native lane selected
  - writable/full-access thread start
  - trust-gated env/hook/LSP behavior
  - any Codex-side trust persistence effect
- do not let repo-check success, native thread existence, or writable sandbox state masquerade as host trust acceptance

### Risk 38 - instruction-owner truth drift

If phase 1 leaves host system/bootstrap prompts, native base/developer instructions, and collaboration-mode built-ins without one explicit owner, runtime behavior can change from hidden instruction precedence instead of visible config or code changes.

Guardrail:

- treat instruction ownership as a first-class contract, not as a prompt-construction detail
- require tests that compare:
  - host system/bootstrap prompt only
  - native base/developer instructions
  - collaboration-mode on/off
  - model/effort selection
  - bootstrap-critical guidance visibility
- do not let hidden collaboration-mode built-ins or second instruction channels silently override host prompt truth

### Risk 39 - persisted-history policy drift

If phase 1 leaves `persistExtendedHistory` implicit, native threads can end up with mixed replay/hydration fidelity while exact-log, reload, and resume flows still speak as if all native history is equally complete.

Guardrail:

- treat persisted-history richness as a first-class thread policy, not as a background storage optimization
- require tests that compare:
  - rich persisted-history thread birth/resume/fork
  - intentionally lossy thread birth/resume/fork
  - replay/exact-log/reload truth
  - later config changes that should not retroactively repair older threads
- do not let UI/transcript/replay surfaces imply one uniform native-history completeness story unless thread policy actually guarantees it

### Risk 40 - native config and feature-state ownership drift

If selective app-server enrichment allows process-wide feature toggles, marketplace persistence, or `config.toml` writes without one host-owned authority, the rollout can split truth between app settings and native runtime state while still looking locally consistent.

Guardrail:

- treat native config/feature/marketplace mutation as a first-class ownership contract, not as a convenience API
- require tests that compare:
  - host settings truth
  - native process-wide feature state
  - native marketplace persistence
  - loaded-thread reload behavior after config mutation
- do not let normal lane operation quietly write native global state unless the host explicitly owns and surfaces that operation

### Risk 41 - detached review-thread identity drift

If native review affordances remain available while detached review is still unmapped, the app can create second native threads whose identity never lands in launch/replay/chain/task-log truth even though the review itself appears to work.

Guardrail:

- treat native review delivery mode as a first-class contract, not as a slash-command detail
- require tests that compare:
  - inline review
  - detached review
  - `reviewThreadId`
  - emitted `thread/started`
  - replay/log/task surfaces
- do not let `/review` imply detached support unless review-thread identity is modeled explicitly end-to-end

### Risk 42 - native binary-version and protocol-surface truth drift

If phase 1 treats `codex-native` backend id as the whole capability contract while actual execution can come from different binaries, versions, or protocol surfaces, the app can look internally consistent while still lying about what that lane really supports on a given machine.

Guardrail:

- treat native runtime identity as a first-class contract, not as a hidden implementation detail
- require tests that compare:
  - bundled SDK-resolved binary
  - external CLI-resolved binary
  - different native binary versions
  - stable-only versus experimental protocol surface where relevant
  - status/probe/cache/UI truth
- do not let backend id alone stand in for capability parity unless the rollout explicitly proves those native runtime identities are equivalent enough

### Risk 43 - app-server connection-policy truth drift

If later selective app-server enrichment allows different connections to negotiate different experimental surface or notification-subscription policies, the app can look like the native runtime is flaky while the real problem is that not every connection sees the same methods, fields, or live events.

Guardrail:

- treat app-server connection policy as a first-class contract, not as a transport detail
- require tests that compare:
  - stable-only connection profile
  - experimental connection profile
  - different `optOutNotificationMethods`
  - live notification presence/absence
  - status/debugging truth
- do not let missing app-server fields or notifications be diagnosed as runtime failure before ruling out connection-policy skew

### Risk 44 - canonical-history versus append-only-projection truth drift

If native rollback or compaction mutates canonical thread history while local transcript/log readers still trust append-only projected history, the app can look coherent in live use while replay, exact-log, and task-log silently tell the wrong story about what the conversation now canonically contains.

Guardrail:

- treat canonical-history authority as a first-class contract, not as a parser implementation detail
- require tests that compare:
  - pre-mutation append-only transcript truth
  - native rollback result truth
  - native compaction result truth
  - replay/exact-log/task-log truth after reload
  - incremental watcher/cache behavior
- do not let append-only local transcript remain implicitly canonical after native history mutation unless the rollout explicitly proves equivalence or performs reconciliation

### Risk 45 - turn-metadata and usage-authority truth drift

If native usage, context-window truth, final model/reasoning-effort truth, or turn plan/diff/reroute metadata are inferred from assistant transcript rows instead of from the seam that actually owns them, the rollout can look healthy while context panels, provisioning usage, token warnings, and runtime copy quietly tell the wrong story.

Guardrail:

- treat turn-metadata authority as a first-class contract, not as a rendering detail
- require tests that compare:
  - live completed-turn usage on the chosen seam
  - restored usage after resume/fork/reload
  - assistant transcript rows with partial or no native usage payload
  - configured model versus rerouted or persisted-resume model truth
  - turn plan/diff metadata presence versus explicit unavailability
- do not let assistant transcript rows automatically masquerade as the canonical native source for usage, model, or reroute truth unless the rollout explicitly proves that equivalence for the chosen seam

### Risk 46 - native thread-default and launch-intent truth drift

If phase 1 treats saved launch `provider/model/effort` as canonical even after native turns or `thread/resume` restore different persisted defaults, the rollout can look healthy while relaunch, restore, runtime summaries, and resume guards quietly describe a different runtime than the one the native thread is actually using.

Guardrail:

- treat host launch intent versus native thread-defaults as a first-class contract, not as a UI-summary detail
- require tests that compare:
  - fresh thread using current launch intent
  - resumed thread inheriting persisted model and reasoning-effort
  - explicit override or fresh-thread policy when host launch intent differs
  - config, relaunch, restore, and runtime-summary copy under that drift
- do not let saved launch params, config-owned provider/model/effort, or bootstrap summaries automatically masquerade as live native thread-default truth unless the rollout explicitly proves they stay aligned

### Risk 47 - native thread-status and warning-authority truth drift

If host process liveness, provisioning progress, runtime snapshots, or coarse provider-global banners stand in for native thread lifecycle truth, the rollout can look healthy while the actual native thread is already `notLoaded`, `idle`, or `systemError`, and warning copy can quietly point users at the wrong failing surface.

Guardrail:

- treat native thread-status and warning authority as a first-class contract, not as a UI wording detail
- require tests that compare:
  - process alive versus native thread `systemError`
  - runtime still present versus native thread `notLoaded`
  - native thread warnings versus config/startup warnings versus provisioning/process warnings
  - status, banner, and team-detail copy under those divergences
- do not let host process or provisioning truth automatically masquerade as native thread health unless the rollout explicitly proves those states are equivalent on the chosen seam

## Lowest-Confidence Seams

These are the areas where we should stay conservative:

1. `🎯 6   🛡️ 7   🧠 7` - session resume and transcript ownership  
   Rough implementation surface: `250-700` lines  
   Biggest risk: dual persistence and confusing resume semantics.

2. `🎯 7   🛡️ 9   🧠 6` - transcript compatibility projection  
   Rough implementation surface: `350-900` lines  
   Biggest risk: accidentally turning the migration into a `claude_team` transcript-format rewrite.

3. `🎯 7   🛡️ 8   🧠 6` - permission/sandbox parity for the Codex-native lane  
   Rough implementation surface: `300-800` lines  
   Biggest risk: approval UX mismatch against current orchestrator expectations.

4. `🎯 8   🛡️ 9   🧠 5` - normalized event schema design  
   Rough implementation surface: `400-900` lines  
   Biggest risk: either too Anthropic-shaped or too vague for UI/transcripts.

5. `🎯 7   🛡️ 8   🧠 5` - backend-id compatibility across orchestrator/UI  
   Rough implementation surface: `150-450` lines  
   Biggest risk: lane truth drifts because config, runtime status, and renderer option lists do not evolve together.

6. `🎯 6   🛡️ 7   🧠 6` - SDK-vs-raw-exec session ownership seam  
   Rough implementation surface: `200-600` lines  
   Biggest risk: unintentionally locking the rollout to durable Codex-owned sessions before we have decided that behavior is acceptable.

7. `🎯 7   🛡️ 8   🧠 6` - request-correlation semantics across live activity and transcript projection  
   Rough implementation surface: `250-700` lines  
   Biggest risk: approval UX, exact-log selectors, or streamed dedupe silently regress because `requestId` and tool-link identities stop being stable across layers.

8. `🎯 7   🛡️ 8   🧠 6` - chain and sidechain identity projection  
   Rough implementation surface: `250-700` lines  
   Biggest risk: team-log grouping, exact-log views, or subagent linking silently regress because `parentUuid`, `isSidechain`, `isMeta`, `sessionId`, or `agentId` stop meaning the same thing across layers.

9. `🎯 7   🛡️ 8   🧠 6` - runtime status/settings and backend-probe policy  
   Rough implementation surface: `220-650` lines  
   Biggest risk: `codex-native` exists in execution but settings, provisioning, installer snapshots, or model verification still describe the old Codex backend truth.

10. `🎯 6   🛡️ 7   🧠 7` - approval/control adaptation into current approval UX  
    Rough implementation surface: `250-750` lines  
    Biggest risk: pending approvals, allow/deny responses, or timeout/deadlock handling silently drift because provider-native control events are only partially adapted.

11. `🎯 6   🛡️ 8   🧠 6` - auth-routing versus backend-routing decoupling  
    Rough implementation surface: `180-550` lines  
    Biggest risk: `codex-native` looks selectable in UI, but env construction still forces `CLAUDE_CODE_CODEX_BACKEND=api` or `adapter`, so runtime truth never matches UI truth.

12. `🎯 6   🛡️ 8   🧠 6` - config-schema and launch-granularity alignment  
    Rough implementation surface: `180-520` lines  
    Biggest risk: orchestrator, config validation, and provisioning all talk about different backend vocabularies or different selection granularity, so the lane can be saved or shown without being launchable honestly.

13. `🎯 6   🛡️ 8   🧠 6` - process-scope backend-routing versus member-level UX expectations  
    Rough implementation surface: `180-520` lines  
    Biggest risk: the lane looks selectable per team member or per launch, but teammate spawn still inherits one process-level Codex backend, so real runtime behavior diverges from UI promises.

14. `🎯 6   🛡️ 9   🧠 5` - provisioning probe-cache identity and invalidation  
    Rough implementation surface: `120-380` lines  
    Biggest risk: readiness/provisioning UI keeps showing stale old-lane truth after a Codex backend or auth switch because cache keys and invalidation stay provider-scoped instead of backend-aware.

15. `🎯 7   🛡️ 8   🧠 4` - external-runtime diagnostics versus actual lane readiness  
    Rough implementation surface: `100-260` lines  
    Biggest risk: UI, installer snapshots, or provisioning summaries start treating detected `codex` binary presence as proof that `codex-native` is selectable, authenticated, or plugin-ready when it is not.

16. `🎯 6   🛡️ 8   🧠 5` - backend-option state semantics in runtime status and selector UX  
    Rough implementation surface: `120-320` lines  
    Biggest risk: `codex-native` cannot be represented honestly because UI still collapses `selectable`, `available`, and `verified` into one pseudo-readiness state.

17. `🎯 6   🛡️ 8   🧠 5` - runtime-status fallback preserving backend-lane truth  
    Rough implementation surface: `140-360` lines  
    Biggest risk: transient failure of unified runtime status makes `codex-native` vanish or revert to old provider-only Codex semantics because legacy fallback drops backend-rich truth.

18. `🎯 7   🛡️ 8   🧠 4` - runtime summary/copy semantics for auth mode vs backend lane  
    Rough implementation surface: `100-240` lines  
    Biggest risk: UI keeps saying the wrong “Current runtime” for Codex because it still equates connection method labels with execution-lane truth.

19. `🎯 6   🛡️ 8   🧠 5` - progressive status snapshot reconciliation across main/store/UI  
    Rough implementation surface: `140-420` lines  
    Biggest risk: partial or stale `cliStatus` pushes silently overwrite fresher backend-lane truth because progress events, cached responses, and provider refreshes do not share one freshness contract.

20. `🎯 6   🛡️ 8   🧠 5` - backend-aware extension preflight for Codex plugin management  
    Rough implementation surface: `140-360` lines  
    Biggest risk: plugin install/uninstall UI becomes enabled from provider-wide truth even while the selected Codex lane is still old, degraded, or unverified.

21. `🎯 6   🛡️ 8   🧠 5` - team model/runtime shape for create-launch dialogs  
    Rough implementation surface: `140-360` lines  
    Biggest risk: team model selectors and provisioning notes keep using provider-wide Codex truth, so lane-specific model behavior cannot be represented honestly.

22. `🎯 7   🛡️ 8   🧠 4` - canonical provisioning prepare-cache identity  
    Rough implementation surface: `100-240` lines  
    Biggest risk: cache reuse drifts with backend summary wording and silently mixes old Codex and `codex-native` warmup/model results.

23. `🎯 6   🛡️ 8   🧠 5` - persisted team identity and replay identity across backend-lane changes  
    Rough implementation surface: `140-420` lines  
    Biggest risk: saved team launches, draft team metadata, backup/restore artifacts, and resume logic keep only provider/model truth, so a later global Codex backend switch silently changes execution lane without explicit UI or snapshot truth.

24. `🎯 7   🛡️ 8   🧠 4` - team-summary and list-surface contract for lane truth  
    Rough implementation surface: `100-280` lines  
    Biggest risk: team cards, draft cards, and synthetic provisioning snapshots tell a different Codex story than runtime/detail surfaces because shared summary DTOs cannot represent backend-lane identity honestly.

25. `🎯 7   🛡️ 8   🧠 4` - member-runtime summary and composer-capability contract for lane truth  
    Rough implementation surface: `120-320` lines  
    Biggest risk: member cards/detail, bootstrap/system summaries, and composer slash-command/plugin hints tell a different Codex story than runtime/settings surfaces because they still collapse everything to provider-wide Codex identity.

26. `🎯 7   🛡️ 8   🧠 5` - plugin activation and session-visibility contract  
    Rough implementation surface: `140-360` lines  
    Biggest risk: extension/plugin UI treats Codex-native install success as immediate readiness even when the real truth is only “usable in a new thread/restarted session” or “still blocked on app/auth setup”.

27. `🎯 6   🛡️ 8   🧠 6` - mention-targeting and invocation-shape contract  
    Rough implementation surface: `180-420` lines  
    Biggest risk: UI/composer claims deterministic plugin/app targeting even though the chosen Codex seam only gives us linked-text mention parsing or implicit runtime discovery.

28. `🎯 7   🛡️ 8   🧠 6` - live-stream versus history-hydration contract  
    Rough implementation surface: `180-480` lines  
    Biggest risk: exact-log, task-log, replay, or resume quietly consume sparse live Codex turn state as if it were fully hydrated history.

29. `🎯 7   🛡️ 8   🧠 5` - approval-resolution and lifecycle-cleanup contract  
    Rough implementation surface: `160-420` lines  
    Biggest risk: stale pending approvals or misleading resolved icons because lifecycle-cleared requests get mistaken for explicit user decisions or never clear at all.

30. `🎯 6   🛡️ 8   🧠 5` - generic interactive-request and MCP-elicitation contract  
    Rough implementation surface: `160-420` lines  
    Biggest risk: Codex-native turns hang or silently degrade because the app only supports approval prompts while the runtime asks for structured user input.

31. `🎯 6   🛡️ 8   🧠 5` - headless exec / TypeScript SDK capability-boundary contract  
    Rough implementation surface: `160-420` lines  
    Biggest risk: the rollout quietly markets a headless exec seam as approval-capable or app-server-like even though the runtime seam itself rejects those interactions.

32. `🎯 6   🛡️ 8   🧠 5` - ephemeral-versus-completion-backfill tradeoff  
    Rough implementation surface: `160-420` lines  
    Biggest risk: choosing `--ephemeral` for session-safety reasons weakens final-turn history completeness in ways that only appear in transcript/exact-log/replay paths.

33. `🎯 7   🛡️ 8   🧠 4` - native-lane credential-routing and API-key surface contract  
    Rough implementation surface: `120-320` lines  
    Biggest risk: UI/status says `codex-native` is API-key ready while auth is still wired only for the old `OPENAI_API_KEY` Responses-API lane.

34. `🎯 7   🛡️ 8   🧠 4` - native-lane model inventory and reasoning-effort contract  
    Rough implementation surface: `140-360` lines  
    Biggest risk: selectors/probes/settings keep using old provider-wide Codex model truth while the selected native lane exposes a different model surface.

35. `🎯 6   🛡️ 9   🧠 5` - workspace-trust and native-thread-start contract  
    Rough implementation surface: `120-320` lines  
    Biggest risk: native thread start silently mutates trust state or bypasses host trust-gated env/hook/LSP behavior while UI still tells the old trust story.

36. `🎯 6   🛡️ 8   🧠 6` - instruction-ownership and collaboration-mode contract  
    Rough implementation surface: `180-420` lines  
    Biggest risk: hidden collaboration-mode or native developer-instruction precedence duplicates or overrides host system/bootstrap prompts, causing behavioral drift that UI cannot explain.

37. `🎯 7   🛡️ 8   🧠 5` - persisted-history policy and non-retroactive hydration contract  
    Rough implementation surface: `140-360` lines  
    Biggest risk: native threads are born with mixed history fidelity, but replay/exact-log/reload surfaces still act as if later config changes can make all of them equally complete.

38. `🎯 6   🛡️ 8   🧠 6` - native config/feature/marketplace ownership contract  
    Rough implementation surface: `180-420` lines  
    Biggest risk: selective native control-plane calls create a second hidden settings authority, so app settings and native runtime state drift apart.

39. `🎯 6   🛡️ 8   🧠 5` - detached review-thread identity contract  
    Rough implementation surface: `140-340` lines  
    Biggest risk: `/review` looks supported, but detached review spawns a second native thread that our launch/replay/task-log surfaces never model honestly.

40. `🎯 6   🛡️ 8   🧠 5` - native binary-version and protocol-surface identity contract  
    Rough implementation surface: `160-380` lines  
    Biggest risk: backend id looks stable, but bundled SDK binary, external CLI, or protocol-surface skew quietly changes what `codex-native` actually supports.

41. `🎯 6   🛡️ 8   🧠 5` - app-server connection-policy contract  
    Rough implementation surface: `120-300` lines  
    Biggest risk: later app-server enrichment looks flaky because different connections negotiated different experimental surface or notification visibility, while status/UI still assume one global truth.

42. `🎯 6   🛡️ 8   🧠 6` - canonical-history versus append-only-projection contract  
   Rough implementation surface: `180-420` lines  
   Biggest risk: native rollback or compaction changes canonical history, but append-only local transcript, exact-log, and replay keep serving stale pre-mutation truth.

43. `🎯 6   🛡️ 8   🧠 5` - turn-metadata and usage-authority contract  
   Rough implementation surface: `180-420` lines  
   Biggest risk: native usage, context-window, model/reroute, or plan truth lives outside assistant transcript rows, but context panels, provisioning usage, token warnings, and runtime copy keep guessing from stale transcript-local metadata.

44. `🎯 6   🛡️ 8   🧠 6` - native thread-defaults versus launch-intent contract  
   Rough implementation surface: `180-460` lines  
   Biggest risk: resumed native threads inherit persisted model, effort, or other thread-defaults while saved launch params, config/meta, and team/member runtime summaries still present launch intent as if it were the live runtime truth.

45. `🎯 6   🛡️ 8   🧠 5` - native thread-status and warning-authority contract  
   Rough implementation surface: `160-420` lines  
   Biggest risk: dashboard, settings, provisioning, and team-detail surfaces keep equating process alive or provisioning active with native thread health, while warning copy collapses config warnings, native thread warnings, and process warnings into one misleading status story.

## Practical Rule

If we need **unified logs**, we normalize events.

If we need **native Codex capabilities**, we do not fake Codex into Anthropic runtime semantics.

That is the core architectural rule for this migration.
