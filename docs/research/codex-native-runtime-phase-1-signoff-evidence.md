# Codex Native Runtime - Phase 1 Sign-off Evidence

Captured on 2026-04-19.

This file records the repo-visible evidence package for the Phase 1 exit gate described in:

- [codex-native-runtime-integration-decision.md](./codex-native-runtime-integration-decision.md)

## Verdict

Phase 1 internal unlock preparation is now complete.

What this proves:

- `codex-native` can be enabled intentionally through the internal unlock policy
- old Codex lanes remain the default and `auto` still resolves to the old adapter/API world
- lane-specific rollout states are explicit and honest:
  - `locked`
  - `ready`
  - `authentication-required`
  - `runtime-missing`
- those states now survive all the way through:
  - orchestrator runtime status
  - bridge parsing
  - dashboard/runtime copy
  - settings/runtime copy
  - provisioning summaries

What this does **not** mean:

- `codex-native` should become the default Codex lane
- `auto` should start resolving to `codex-native`
- broader approval, plugin, or interactive parity claims are now safe
- limited internal unlock has already started

That is Phase 2 territory.

## Command Package

### `agent_teams_orchestrator`

Executed:

```bash
bun test src/services/runtimeBackends/codexBackendResolver.test.ts \
  src/services/runtimeBackends/registry.agentTeams.test.ts \
  src/services/runtimeBackends/registry.codexNativeStates.test.ts
```

Observed result:

- `14 pass`
- `0 fail`

Executed:

```bash
bun run signoff:codex-native-phase1
```

Observed result:

- exit code `0`
- five live CLI rollout scenarios verified:
  - `locked`
  - `internal-unlock-ready`
  - `authentication-required`
  - `runtime-missing`
  - `auto-fallback-stays-old-lane`

### `claude_team`

Executed:

```bash
pnpm exec vitest run \
  test/main/services/runtime/ClaudeMultimodelBridgeService.test.ts \
  test/main/services/runtime/providerAwareCliEnv.test.ts \
  test/main/services/runtime/ProviderConnectionService.test.ts \
  test/renderer/components/runtime/providerConnectionUi.test.ts \
  test/renderer/components/runtime/ProviderRuntimeBackendSelector.test.ts \
  test/renderer/components/runtime/ProviderRuntimeSettingsDialog.test.ts \
  test/renderer/components/team/dialogs/ProvisioningProviderStatusList.test.ts \
  test/renderer/components/cli/CliStatusVisibility.test.ts \
  test/main/services/parsing/CodexNativePhase0Smoke.test.ts
```

Observed result:

- `9` files passed
- `83` tests passed
- `0` failures

## Live CLI Rollout Evidence

Runner:

```bash
runtime status --provider codex --json
```

Observed live scenarios:

### Locked

- selected backend: `codex-native`
- resolved backend: `codex-native`
- provider status: `Codex native runtime ready`
- native option:
  - `selectable=false`
  - `available=true`
  - `state=locked`
  - `audience=internal`
  - `statusMessage=Ready but locked`

### Internal unlock ready

- selected backend: `codex-native`
- resolved backend: `codex-native`
- provider status: `Codex native runtime ready`
- native option:
  - `selectable=true`
  - `available=true`
  - `state=ready`
  - `audience=internal`
  - `statusMessage=Ready for internal use`

### Authentication required

- selected backend: `codex-native`
- resolved backend: `null`
- provider status: `Codex native runtime not ready`
- native option:
  - `selectable=false`
  - `available=false`
  - `state=authentication-required`
  - `audience=internal`
  - `statusMessage=Authentication required`

### Runtime missing

- selected backend: `codex-native`
- resolved backend: `null`
- provider status: `Codex native runtime not ready`
- native option:
  - `selectable=false`
  - `available=false`
  - `state=runtime-missing`
  - `audience=internal`
  - `statusMessage=Codex CLI not found`

### Auto fallback stays on the old lane

- selected backend: `auto`
- resolved backend: `api`
- provider status: `Resolved to OpenAI API`
- native option remains visible for internal rollout:
  - `selectable=true`
  - `available=true`
  - `state=ready`
  - `audience=internal`
  - `statusMessage=Ready for internal use`

This is the explicit proof that internal unlock availability does **not** mutate `auto` resolution.

## App-facing Truth Proof

Covered by green targeted tests:

- `test/main/services/runtime/ClaudeMultimodelBridgeService.test.ts`
- `test/main/services/runtime/providerAwareCliEnv.test.ts`
- `test/main/services/runtime/ProviderConnectionService.test.ts`
- `test/renderer/components/runtime/providerConnectionUi.test.ts`
- `test/renderer/components/runtime/ProviderRuntimeBackendSelector.test.ts`
- `test/renderer/components/runtime/ProviderRuntimeSettingsDialog.test.ts`
- `test/renderer/components/team/dialogs/ProvisioningProviderStatusList.test.ts`
- `test/renderer/components/cli/CliStatusVisibility.test.ts`

These tests prove:

- internal unlock state survives bridge parsing
- internal unlock env survives provider-aware child env building
- dashboard and settings do not flatten native rollout states into generic `Connected via API key`
- locked/runtime-missing/auth-required states stay visible in user-facing copy
- provisioning summaries keep native rollout state visible

## Phase 1 Exit Gate Conclusion

✅ The Phase 1 exit gate is satisfied.

The lane can now be enabled intentionally by internal users, while:

- old Codex lanes remain the safe default
- `auto` still avoids `codex-native`
- degraded or blocked native states remain explicit and honest

⚠️ The lane should still remain:

- non-default
- explicitly internal
- rollout-gated
- conservative in capability claims

The next step is **Phase 2 - limited internal unlock**, not broad rollout.
