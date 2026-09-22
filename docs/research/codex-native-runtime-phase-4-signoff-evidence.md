# Codex Native Runtime - Phase 4 Sign-off Evidence

Captured on 2026-04-19.

This file records the repo-visible evidence package for the final native-only Codex cutover.

Related documents:

- [codex-native-runtime-integration-decision.md](./codex-native-runtime-integration-decision.md)
- [codex-native-runtime-phase-1-signoff-evidence.md](./codex-native-runtime-phase-1-signoff-evidence.md)

## Verdict

Phase 4 legacy removal is now complete.

What this proves:

- `codex-native` is now the only Codex runtime lane
- old `adapter` and `api` Codex lanes are no longer launchable through active runtime code paths
- Codex runtime status now exposes a single native option instead of a mixed legacy/native selector
- stored legacy backend values normalize forward to `codex-native`
- UI-facing Codex status, model availability, launch identity, replay parsing, and provisioning all remain truthful after legacy removal

What this does **not** mean:

- plugin execution parity is now guaranteed for multimodel Codex sessions
- broader app-server or interactive-request parity has been added
- Codex runtime failures silently fall back to another hidden Codex implementation

## Command Package

### `agent_teams_orchestrator`

Executed:

```bash
bun test src/services/runtimeBackends/codexBackendResolver.test.ts \
  src/services/runtimeBackends/registry.codexNativeStates.test.ts \
  src/services/runtimeBackends/registry.agentTeams.test.ts \
  src/utils/swarm/spawnUtils.test.ts
```

Observed result:

- `23 pass`
- `0 fail`

Executed:

```bash
bun run signoff:codex-native-phase4
```

Observed result:

- exit code `0`
- four live CLI native-only scenarios verified:
  - `ready`
  - `authentication-required`
  - `runtime-missing`
  - `openai-api-key-also-works`

### `claude_team`

Executed:

```bash
pnpm exec vitest run \
  test/main/services/runtime/ClaudeMultimodelBridgeService.test.ts \
  test/main/services/runtime/providerAwareCliEnv.test.ts \
  test/main/services/runtime/ProviderConnectionService.test.ts \
  test/main/ipc/configValidation.test.ts \
  test/main/services/team/TeamProvisioningService.test.ts \
  test/main/services/parsing/CodexNativePhase0Smoke.test.ts \
  test/main/services/parsing/SessionParser.test.ts \
  test/main/services/team/BoardTaskExactLogStrictParser.test.ts \
  test/renderer/components/runtime/providerConnectionUi.test.ts \
  test/renderer/components/runtime/ProviderRuntimeBackendSelector.test.ts \
  test/renderer/components/runtime/ProviderRuntimeSettingsDialog.test.ts \
  test/renderer/components/cli/CliStatusVisibility.test.ts \
  test/renderer/components/team/dialogs/ProvisioningProviderStatusList.test.ts \
  test/renderer/components/team/dialogs/launchDialogPrefill.test.ts \
  test/renderer/utils/memberRuntimeSummary.test.ts \
  test/renderer/utils/teamModelAvailability.test.ts
```

Observed result:

- `16` files passed
- `180` tests passed
- `0` failures

## Live Native-only Status Evidence

Runner:

```bash
runtime status --provider codex --json
```

Observed live scenarios:

### Ready

- selected backend: `codex-native`
- resolved backend: `codex-native`
- provider status: `Codex native runtime ready`
- native option:
  - `selectable=true`
  - `available=true`
  - `state=ready`
  - `audience=general`
  - `statusMessage=Ready`

### Authentication required

- selected backend: `codex-native`
- resolved backend: `null`
- provider status: `Codex native runtime unavailable`
- native option:
  - `selectable=false`
  - `available=false`
  - `state=authentication-required`
  - `audience=general`
  - `statusMessage=Authentication required`

### Runtime missing

- selected backend: `codex-native`
- resolved backend: `null`
- provider status: `Codex native runtime unavailable`
- native option:
  - `selectable=false`
  - `available=false`
  - `state=runtime-missing`
  - `audience=general`
  - `statusMessage=Codex CLI not found`

### `OPENAI_API_KEY` also works

- selected backend: `codex-native`
- resolved backend: `codex-native`
- provider status: `Codex native runtime ready`
- explicit proof that the native lane still accepts:
  - `CODEX_API_KEY`
  - or `OPENAI_API_KEY`

This is the explicit proof that the final cutover no longer depends on a legacy adapter/API runtime seam while still preserving the supported credential surface.

## App-facing Native-only Truth Proof

Covered by green targeted tests:

- `test/main/services/runtime/ClaudeMultimodelBridgeService.test.ts`
- `test/main/services/runtime/providerAwareCliEnv.test.ts`
- `test/main/services/runtime/ProviderConnectionService.test.ts`
- `test/main/ipc/configValidation.test.ts`
- `test/main/services/team/TeamProvisioningService.test.ts`
- `test/main/services/parsing/CodexNativePhase0Smoke.test.ts`
- `test/main/services/parsing/SessionParser.test.ts`
- `test/main/services/team/BoardTaskExactLogStrictParser.test.ts`
- `test/renderer/components/runtime/providerConnectionUi.test.ts`
- `test/renderer/components/runtime/ProviderRuntimeBackendSelector.test.ts`
- `test/renderer/components/runtime/ProviderRuntimeSettingsDialog.test.ts`
- `test/renderer/components/cli/CliStatusVisibility.test.ts`
- `test/renderer/components/team/dialogs/ProvisioningProviderStatusList.test.ts`
- `test/renderer/components/team/dialogs/launchDialogPrefill.test.ts`
- `test/renderer/utils/memberRuntimeSummary.test.ts`
- `test/renderer/utils/teamModelAvailability.test.ts`

These tests prove:

- legacy Codex backend values normalize forward to `codex-native`
- settings and dashboard now describe Codex as native-first, not adapter/API-first
- provider backend identity survives team launch, relaunch, and launch-prefill flows
- parser and exact-log readers stay truthful for native transcript authority rows
- provisioning summaries and member runtime summaries no longer flatten native truth into old Codex copy
- team model availability is keyed to the native runtime path instead of old ChatGPT-subscription heuristics

## Legacy Removal Proof

Covered by green targeted tests and runtime sign-off:

- orchestrator runtime backend resolver now exposes only `codex-native`
- runtime registry now exposes a single Codex backend option
- no active runtime branch launches Codex through:
  - `adapter`
  - `api`
- old transport-only smoke/signoff scripts tied to legacy Codex runtime were removed

This is the explicit proof that Phase 4 is a real cutover, not just a UI relabeling.

## Sign-off Conclusion

✅ The Phase 4 exit gate is satisfied.

Codex inside the multimodel runtime is now native-only.

There is no longer a product-supported legacy Codex runtime lane to roll back to inside normal UI flows.
