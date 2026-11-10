# Codex Native Runtime - Phase 0 Sign-off Evidence

Captured on 2026-04-19.

This file is the repo-visible evidence package referenced by:

- [codex-native-runtime-phase-0-implementation-spec.md](./codex-native-runtime-phase-0-implementation-spec.md)

## Verdict

Phase 0 sign-off evidence is now captured.

What this proves:

- the `codex-native` lane executes through the raw `codex exec --json` seam
- persisted transcript projection remains parseable by current `claude_team` readers
- `ephemeral` and `persistent` runs keep different history-completeness truth
- thread status, warning attribution, executable identity, and usage authority survive end-to-end
- old Codex lane fallback truth remains covered by targeted regression tests

What this does **not** mean:

- `codex-native` should be unlocked for general runtime selection
- `auto` should start resolving to `codex-native`
- broader plugin or interactive capability claims are now safe

## Command Package

### `agent_teams_orchestrator`

Executed:

```bash
bun test src/services/codexNative/signOffHarness.test.ts \
  src/services/codexNative/statusAuthority.test.ts \
  src/services/codexNative/transcriptProjector.test.ts \
  src/services/codexNative/turnExecutor.test.ts \
  src/services/codexNative/execRunner.test.ts \
  src/services/codexNative/jsonlMapper.test.ts \
  src/services/runtimeBackends/codexBackendResolver.test.ts \
  src/services/runtimeBackends/registry.agentTeams.test.ts
```

Observed result:

- `27 pass`
- `0 fail`

### `claude_team`

Executed:

```bash
pnpm exec vitest run \
  test/main/utils/jsonl.test.ts \
  test/main/services/parsing/SessionParser.test.ts \
  test/main/services/team/BoardTaskExactLogStrictParser.test.ts \
  test/main/ipc/configValidation.test.ts \
  test/main/services/runtime/ProviderConnectionService.test.ts \
  test/main/services/runtime/providerAwareCliEnv.test.ts \
  test/main/services/runtime/ClaudeMultimodelBridgeService.test.ts \
  test/renderer/components/runtime/providerConnectionUi.test.ts \
  test/renderer/components/runtime/ProviderRuntimeSettingsDialog.test.ts \
  test/renderer/components/cli/CliStatusVisibility.test.ts
```

Observed result:

- `134 pass`
- `0 fail`

### Diff cleanliness

Executed:

```bash
git diff --check
```

Observed result:

- clean in both worktrees

## Live Native Run Evidence

### Common live-run facts

Observed from both runs:

- native binary path: `/usr/local/bin/codex`
- native binary source: `system-path`
- native binary version: `codex-cli 0.117.0`
- credential input source for the sign-off harness: `OPENAI_API_KEY`
- credential source observed by the runner: `explicit-api-key`
- capability profile: `headless-limited`
- final assistant text: `OK`

### Ephemeral run

Executed:

```bash
bun run ./scripts/codex-native-phase0-signoff.ts \
  --cwd /tmp \
  --prompt 'Reply only with OK' \
  --ephemeral
```

Observed result:

- thread id: `019da680-6f43-7e10-824c-4d985bcdca12`
- completion policy: `ephemeral`
- final history completeness: `live-only`
- final usage authority: `live-turn-completed`
- assistant usage:
  - input tokens: `23616`
  - cached input tokens: `0`
  - output tokens: `42`

History authority proof:

- projected warning subtype: `codex_native_warning`
- projected warning source: `history`
- observed warning text contained:
  - `thread/read failed while backfilling turn items for turn completion`
  - `ephemeral threads do not support includeTurns`

This is the explicit proof that `ephemeral` live stream does **not** equal canonical hydrated history.

### Persistent run

Executed:

```bash
bun run ./scripts/codex-native-phase0-signoff.ts \
  --cwd /tmp \
  --prompt 'Reply only with OK' \
  --persistent
```

Observed result:

- thread id: `019da680-6f42-77c0-94f1-4e450a69d1f1`
- completion policy: `persistent`
- final history completeness: `explicit-hydration-required`
- final usage authority: `live-turn-completed`
- assistant usage:
  - input tokens: `23616`
  - cached input tokens: `0`
  - output tokens: `33`

This is the explicit proof that persistent native runs keep a different history-completeness contract from `ephemeral` runs.

## Warning Attribution Proof

The live runs produced both:

- process/runtime warnings
- history-completeness warnings

Observed process-attributed warnings included:

- plugin cache / featured plugins unauthorized warnings
- state DB migration mismatch warnings
- shell snapshot timeout warnings
- MCP process-group termination warnings

Observed history-attributed warning included:

- `thread/read failed while backfilling turn items for turn completion: ... ephemeral threads do not support includeTurns`

This proves the lane now keeps `process` and `history` warning truth distinct in projected transcript rows.

## Thread-status Proof

Observed projected system rows included:

- `codex_native_thread_status`
  - `running`
  - `completed`

This proves the lane now writes native thread-status authority into persisted transcript-compatible rows instead of forcing UI and replay consumers to infer health from provider-global process truth.

## Parser And Exact-log Proof

Covered by green targeted tests:

- `test/main/utils/jsonl.test.ts`
- `test/main/services/parsing/SessionParser.test.ts`
- `test/main/services/team/BoardTaskExactLogStrictParser.test.ts`

These tests prove:

- projected assistant usage remains parseable
- projected warning/source metadata remains parseable
- projected execution-summary/history metadata remains parseable
- exact-log readers do not drop the native authority rows

## Degraded Old-lane Fallback Proof

Covered by green targeted tests:

- `src/services/runtimeBackends/codexBackendResolver.test.ts`
- `src/services/runtimeBackends/registry.agentTeams.test.ts`

Those tests prove:

- `auto` still does not silently resolve to `codex-native`
- native lane remains unavailable without:
  - feature flag
  - binary
  - `CODEX_API_KEY`
- old Codex lane remains the truthful fallback when native is absent or degraded

## Sign-off Conclusion

✅ The Phase 0 code path is implementation-complete and evidence-backed.

⚠️ The lane should still remain:

- feature-flagged
- non-default
- non-auto-resolved
- non-selectable for normal runtime switching

That remaining lock is now a rollout-policy choice, not a missing-code problem.
