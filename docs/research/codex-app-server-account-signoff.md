# Codex App-Server Account Feature - Signoff Evidence

Date: 2026-04-20

Worktree:
- `/Users/belief/dev/projects/claude/claude_team_codex_native_runtime_plan`

Branch:
- `spike/codex-native-runtime-plan`

Related plan:
- [codex-app-server-account-feature-plan.md](./codex-app-server-account-feature-plan.md)

## Scope

This signoff covers the app-server-backed Codex account feature work implemented in this repo:

- shared Codex app-server transport extraction
- `codex-account` feature slice
- Codex `preferredAuthMode` config migration and validation
- renderer/runtime integration for managed ChatGPT account plus API key truth
- per-launch `forced_login_method` overrides for native Codex execution
- lazy rate-limits support
- login lifecycle wiring in the real UI path

## Automated Verification

### Targeted tests

Command:

```bash
pnpm vitest run \
  test/features/codex-account/core/evaluateCodexLaunchReadiness.test.ts \
  test/features/codex-account/main/CodexAccountEnvBuilder.test.ts \
  test/features/codex-account/main/createCodexAccountFeature.test.ts \
  test/features/codex-account/main/CodexLoginSessionManager.test.ts \
  test/features/codex-account/preload/createCodexAccountBridge.test.ts \
  test/features/codex-account/renderer/useCodexAccountSnapshot.test.ts \
  test/main/services/runtime/providerAwareCliEnv.test.ts \
  test/main/services/runtime/ProviderConnectionService.test.ts \
  test/main/services/runtime/ClaudeMultimodelBridgeService.test.ts \
  test/main/services/schedule/ScheduledTaskExecutor.test.ts \
  test/main/services/team/TeamProvisioningServicePrepare.test.ts \
  test/main/services/team/TeamProvisioningServicePrompts.test.ts \
  test/main/services/infrastructure/ConfigManager.codexMigration.test.ts \
  test/renderer/api/httpClient.codexAccount.test.ts \
  test/renderer/api/httpClient.exactTaskLogs.test.ts \
  test/renderer/components/runtime/ProviderRuntimeSettingsDialog.test.ts \
  test/renderer/components/runtime/providerConnectionUi.test.ts \
  test/renderer/components/cli/CliStatusVisibility.test.ts \
  test/renderer/components/team/dialogs/ProvisioningProviderStatusList.test.ts \
  test/main/ipc/configValidation.test.ts \
  test/features/recent-projects/main/infrastructure/CodexAppServerClient.test.ts \
  test/features/recent-projects/main/adapters/output/CodexRecentProjectsSourceAdapter.test.ts \
  test/features/recent-projects/core/application/ListDashboardRecentProjectsUseCase.test.ts \
  test/features/recent-projects/contracts/normalizeDashboardRecentProjectsPayload.test.ts \
  test/features/recent-projects/renderer/adapters/RecentProjectsSectionAdapter.test.ts
```

Result:

- `25` test files passed
- `204` tests passed

### Typecheck

Command:

```bash
pnpm exec tsc -p tsconfig.json --noEmit
```

Result:

- passed

### Targeted lint

Command:

```bash
pnpm exec eslint \
  src/main/services/infrastructure/ConfigManager.ts \
  src/main/services/runtime/ProviderConnectionService.ts \
  src/main/services/runtime/providerAwareCliEnv.ts \
  src/main/services/schedule/ScheduledTaskExecutor.ts \
  src/features/codex-account/preload/createCodexAccountBridge.ts \
  src/features/codex-account/renderer/hooks/useCodexAccountSnapshot.ts \
  src/renderer/api/httpClient.ts \
  src/renderer/components/runtime/ProviderRuntimeSettingsDialog.tsx \
  test/main/services/infrastructure/ConfigManager.codexMigration.test.ts \
  test/features/codex-account/preload/createCodexAccountBridge.test.ts \
  test/features/codex-account/renderer/useCodexAccountSnapshot.test.ts \
  test/main/services/runtime/ProviderConnectionService.test.ts \
  test/main/services/runtime/providerAwareCliEnv.test.ts \
  test/renderer/api/httpClient.codexAccount.test.ts \
  test/renderer/components/runtime/ProviderRuntimeSettingsDialog.test.ts
```

Result:

- passed

## Live Read-Only Signoff

### 1. Real `codex app-server account/read`

Probe result:

```json
{
  "account": {
    "type": "chatgpt",
    "email": "quantjumppro@gmail.com",
    "planType": "pro"
  },
  "requiresOpenaiAuth": true
}
```

What this proves:

- installed Codex binary supports the stable app-server initialize flow used by the extracted transport
- ChatGPT account autodetect works on the real machine
- managed account truth is available without touching legacy transport

### 2. Real `codex app-server account/rateLimits/read`

Probe result summary:

```json
{
  "rateLimits": {
    "limitId": "codex",
    "primary": {
      "usedPercent": 77,
      "windowDurationMins": 300
    },
    "secondary": {
      "usedPercent": 45,
      "windowDurationMins": 10080
    },
    "credits": {
      "hasCredits": false,
      "unlimited": false,
      "balance": "0"
    },
    "planType": "pro"
  }
}
```

What this proves:

- live rate-limit payload shape matches the feature assumptions
- plan/rate-limit surface can be driven from the real app-server contract

### 3. Real feature-facade snapshot

Command path:

- `createCodexAccountFeature(...).refreshSnapshot({ includeRateLimits: true })`

Observed summary:

```json
{
  "preferredAuthMode": "chatgpt",
  "effectiveAuthMode": "chatgpt",
  "appServerState": "healthy",
  "managedAccount": {
    "type": "chatgpt",
    "email": "quantjumppro@gmail.com",
    "planType": "pro"
  },
  "apiKey": {
    "available": true,
    "source": "environment",
    "sourceLabel": "Detected from OPENAI_API_KEY"
  },
  "launchAllowed": true,
  "launchReadinessState": "ready_chatgpt",
  "planType": "pro",
  "rateLimitPrimaryUsedPercent": 77
}
```

What this proves:

- the real feature composition builds the expected snapshot
- app-server truth, API-key availability merge, readiness evaluation, and rate-limit shaping all work together

### 4. Live preference-resolution checks through the feature facade

Observed summary:

```json
{
  "preferredAuthMode": "auto",
  "effectiveAuthMode": "chatgpt",
  "launchAllowed": true,
  "launchReadinessState": "ready_both",
  "managedAccountType": "chatgpt",
  "apiKeyAvailable": true
}
```

```json
{
  "preferredAuthMode": "api_key",
  "effectiveAuthMode": "api_key",
  "launchAllowed": true,
  "launchReadinessState": "ready_api_key",
  "managedAccountType": "chatgpt",
  "apiKeyAvailable": true
}
```

What this proves:

- `auto` mode prefers ChatGPT when both auth sources exist
- `api_key` preference still resolves correctly even when a managed account is also present

### 5. Live execution env sanitization check through `ProviderConnectionService`

With a connected managed-account snapshot and `preferredAuthMode = "chatgpt"`, observed result:

```json
{
  "OPENAI_API_KEY": null,
  "CODEX_API_KEY": null
}
```

What this proves:

- ChatGPT-mode execution sanitizes ambient API-key env vars when managed-account launch is selected

### 6. Live provider-aware launch override check

Command path:

- `providerConnectionService.setCodexAccountFeature(createCodexAccountFeature(...))`
- `buildProviderAwareCliEnv({ binaryPath: "codex", providerId: "codex" })`

Observed summary:

```json
{
  "providerArgs": [
    "-c",
    "forced_login_method=\"chatgpt\""
  ],
  "connectionIssues": {}
}
```

What this proves:

- the native Codex launch policy now emits a deterministic `forced_login_method` override
- the override is available through the shared provider-aware execution seam used by runtime launch paths

## Definition Of Done Cross-Check

1. Previously logged-in ChatGPT Codex account autodetects automatically.
   Status: yes - proven by live `account/read`.

2. UI clearly distinguishes managed account and API key availability.
   Status: yes - implemented in the Codex panel and covered by renderer tests.

3. `auto` mode works and prefers ChatGPT when available.
   Status: yes - proven by live feature-facade check.

4. Launch policy no longer falsely requires API key when managed account exists.
   Status: yes - feature readiness plus live snapshot show `launchAllowed = true` in ChatGPT mode.

5. ChatGPT-mode execution sanitizes API-key env vars.
   Status: yes - covered by tests and live `ProviderConnectionService` probe.

6. API-key mode still works.
   Status: yes - covered by tests and live preference-resolution probe.

7. Login, cancel, and logout work from the real UI.
   Status: code path and tests are implemented; live destructive signoff was intentionally not executed in this document to avoid mutating the active local Codex account session.

8. Codex terminal-login path is no longer used in normal UI flows.
   Status: yes - normal Codex settings flow uses feature IPC actions, not terminal modal auth.

9. `recent-projects` remains green.
   Status: yes - targeted recent-projects safety suites passed.

10. Existing non-Codex provider UX remains unchanged.
   Status: targeted Anthropic/Gemini runtime and renderer tests passed.

## Conclusion

For this repo, the planned app-server account feature work is in signoffable shape:

- architecture is aligned with the feature-slice plan
- renderer/runtime behavior is covered by targeted automated tests
- live app-server read and rate-limit contracts were verified on the installed Codex binary
- provider-aware native launch paths now receive deterministic Codex auth-mode overrides
