# Codex App-Server Model Catalog Plan

**Date**: 2026-04-21  
**Status**: implementation complete in feature worktrees, pending final review/commit  
**Worktree**: `/Users/belief/dev/projects/claude/claude_team_codex_model_catalog_plan`  
**Branch**: `spike/codex-model-catalog-plan`  
**Primary repo**: `claude_team`  
**Secondary repo worktree**: `/Users/belief/dev/projects/claude/agent_teams_orchestrator_codex_native_spike`  
**Architecture reference**: [FEATURE_ARCHITECTURE_STANDARD.md](../FEATURE_ARCHITECTURE_STANDARD.md)

## Executive Summary

Codex model selection should move from hardcoded local lists to the official Codex app-server `model/list` catalog.

Chosen implementation:

- Add a dedicated `src/features/codex-model-catalog` feature in `claude_team`.
- Use `codex app-server` JSON-RPC `model/list` as the primary source for Codex models.
- Keep the existing static Codex catalog only as a bounded fallback when app-server is unavailable.
- Add rich, additive model metadata to `CliProviderStatus` while keeping `models: string[]` for backwards compatibility.
- Use per-model `supportedReasoningEfforts` and `defaultReasoningEffort` for the Codex model picker and launch validation.
- Keep Anthropic and Gemini behavior unchanged by default.
- Update `agent_teams_orchestrator` so Codex launches pass reasoning effort through Codex config key `model_reasoning_effort`, not through an invented `--effort` flag.

Decision score:

- `🎯 9   🛡️ 9   🧠 6`
- estimated implementation size: `1200-2400` lines across `claude_team` and `agent_teams_orchestrator`

Why this is the safest path:

- It follows the real Codex client contract instead of chasing static releases.
- It solves future model releases like `gpt-5.5` without an app release, as long as Codex app-server already exposes the model.
- It avoids breaking Anthropic by making the new catalog contract additive and provider-scoped.
- It handles `xhigh` correctly as Codex-specific reasoning effort, not as Anthropic `max`.

Current implementation state:

- `claude_team` has the dedicated Codex model catalog feature, app-server JSON-RPC client, static fallback, provider status integration, Codex model picker integration, provider-aware effort UI, launch validation, launch identity persistence, and targeted tests.
- `agent_teams_orchestrator_codex_native_spike` exposes runtime capabilities for dynamic Codex models and Codex reasoning config pass-through, and its Codex native exec runner passes effort through `-c model_reasoning_effort="value"`.
- Anthropic remains isolated from Codex-only effort values. Anthropic launch UI still uses `low | medium | high`; Codex can use per-model `minimal | low | medium | high | xhigh` only where catalog/runtime policy allows it.
- Future Codex app-server models can appear immediately in UI. Launch is allowed only when the local runtime declares dynamic Codex model support; otherwise they remain visible with upgrade/policy copy instead of failing late during spawn.
- `Default` Codex selection is resolved to a concrete model immediately before provisioning and stored as additive launch identity metadata.
- The remaining work before merge is review/signoff, not more architecture discovery.

## Sources And Verification

Official sources checked:

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex CLI command line options](https://developers.openai.com/codex/cli/reference)
- [Codex Configuration Reference](https://developers.openai.com/codex/config-reference)

Important official facts:

- `model/list` is explicitly intended for rendering model and personality selectors.
- `model/list` returns `id`, `model`, `displayName`, `hidden`, `defaultReasoningEffort`, `supportedReasoningEfforts`, `inputModalities`, `supportsPersonality`, `isDefault`, `upgrade`, and `upgradeInfo`.
- `includeHidden: false` returns picker-visible models by default.
- `codex exec` has `--model` and `-c, --config key=value`.
- `codex exec` does not expose a first-class `--effort` flag.
- Codex config key `model_reasoning_effort` supports `minimal | low | medium | high | xhigh`.
- `xhigh` is model-dependent.
- `config/read` exists in app-server and returns effective configuration after configuration layering.
- Codex loads user config from `~/.codex/config.toml` and can also load project-scoped `.codex/config.toml` only for trusted projects.
- `model_catalog_json` can override the model catalog, including profile-level overrides.
- `codex exec` supports `--cd` and `--profile`, and `-c key=value` overrides take precedence for one invocation.

Local probe:

- binary: `codex-cli 0.117.0`
- method: `codex app-server` over JSON-RPC stdio
- transport: newline-delimited JSON-RPC over stdio, not `Content-Length` framing
- request: `model/list` with `{ "limit": 20, "includeHidden": false }`
- result: 8 visible models, `gpt-5.4` marked default, `nextCursor: null`
- visible models returned: `gpt-5.4`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`, `gpt-5.1-codex-mini`
- `xhigh` is already returned for most models.
- `gpt-5.1-codex-mini` only returned `medium | high`, so effort options must be per-model.
- `gpt-5.3-codex-spark` returned default effort `high`, so default effort must not be global.
- `codex exec --help` locally confirms `--cd`, `--profile`, `--model`, `--oss`, `--local-provider`, and repeatable `-c key=value`.
- local help confirms `--oss` is equivalent to `-c model_provider=oss`, so provider scope can differ from subscription-backed OpenAI Codex if not guarded.
- live `config/read` probe returned `{ config, origins }`.
- live `config/read` probe requires `params` object; missing `params` returns JSON-RPC error `-32600`.
- live `config/read` probe accepted `{ cwd }` and `{ profile }` without error, so the implementation should feature-detect and test scoped reads instead of assuming only global config.
- final live smoke on this worktree confirmed `model/list` returns 8 visible models, default `gpt-5.4`, `xhigh` for most models, and `medium | high` only for `gpt-5.1-codex-mini`.

Combined app-server session probe:

- one initialized app-server process successfully handled `account/read`, `account/rateLimits/read`, and `model/list` sequentially
- `account/read` returned a ChatGPT account shape in the local environment
- `account/rateLimits/read` returned `primary.windowDurationMins = 300` and `secondary.windowDurationMins = 10080`
- `model/list` returned the same 8 visible models in that same session
- conclusion: provider refresh should use a combined control-plane session when it needs account, limits, and catalog truth

## Lowest-Confidence Areas And Decisions

### 1. Auth-scoped catalog truth

`🎯 7   🛡️ 9   🧠 6`  
Estimated implementation impact: `180-350` lines

Uncertainty:

- app-server `model/list` may return different catalogs depending on active Codex auth state, account plan, org policy, API-key mode, or future Codex rollout flags.
- The local probe only proves one logged-in environment, not all account modes.

Decision:

- treat Codex model catalog as auth-scoped, not global
- cache key must include binary path, Codex home, preferred auth mode, effective auth mode, managed account stable identity when available, and API-key availability source
- never reuse a ChatGPT-account catalog as API-key-mode catalog
- never reuse an API-key-mode catalog as ChatGPT-account catalog
- when auth mode changes, keep previous catalog visible only as stale UI while refresh is in flight, then replace it

Implementation rule:

```text
catalogCacheKey =
  binaryPath
  + binaryVersion
  + codexHome
  + preferredAuthMode
  + effectiveAuthMode
  + managedAccountHash or "no-chatgpt-account"
  + apiKey.source or "no-api-key"
```

The hash should use a per-process salt and should not be persisted. Do not persist raw email solely for catalog cache.

### 2. Default model determinism

`🎯 8   🛡️ 9   🧠 6`  
Estimated implementation impact: `220-420` lines

Uncertainty:

- current UI can represent model as empty string meaning `Default`
- Codex app-server default can change after a Codex release
- launch logs, relaunch, replay, and team metadata need to stay explainable

Decision:

- keep `Default` as a UI selection
- resolve `Default` to a concrete `resolvedLaunchModel` immediately before launch
- persist both user selection and resolved runtime truth in launch metadata
- never silently rewrite old team config from one concrete model to another
- if a team stored `Default`, relaunch should show that it will resolve to the current Codex default before launch

Required persisted launch identity:

```ts
export interface ProviderModelLaunchIdentity {
  providerId: TeamProviderId;
  providerBackendId: TeamProviderBackendId | null;
  selectedModel: string | null;
  selectedModelKind: 'default' | 'explicit';
  resolvedLaunchModel: string;
  catalogId: string | null;
  catalogSource: 'app-server' | 'static-fallback' | 'unavailable';
  catalogFetchedAt: string | null;
  selectedEffort: string | null;
  resolvedEffort: string | null;
}
```

This identity should be written into exact logs and launch-derived metadata. It should not replace existing fields in Phase 1, but it should become the canonical explanation layer for Codex relaunch/replay.

### 3. Effort transport through orchestrator

`🎯 8   🛡️ 9   🧠 5`  
Estimated implementation impact: `180-320` lines

Uncertainty:

- Agent Teams exposes a generic `--effort` concept today
- Codex CLI does not expose `--effort`
- Codex uses config key `model_reasoning_effort`

Decision:

- UI and main process may accept provider-aware effort strings
- orchestrator public Agent Teams CLI can continue accepting `--effort`
- Codex executor must translate Codex effort to `codex exec -c model_reasoning_effort='"value"'`
- Anthropic executor must not see Codex-only effort values
- Codex executor must not see Anthropic `max`

No implementation phase may ship `xhigh` as selectable until this pass-through is tested.

### 4. Catalog availability vs team-agent safety policy

`🎯 8   🛡️ 9   🧠 5`  
Estimated implementation impact: `160-280` lines

Uncertainty:

- app-server `model/list` says a model is available to Codex
- our team-agent contract can still make a model unsafe for Agent Teams if it breaks task/reply/bootstrap conventions
- current UI has local disabled policy for `gpt-5.3-codex-spark`, `gpt-5.2-codex`, and `gpt-5.1-codex-mini`

Decision:

- model catalog answers "can Codex offer this model"
- team policy answers "can Agent Teams safely launch this model"
- keep these as separate layers
- do not remove current disabled policies just because app-server returns a model
- show clear disabled copy: `Available in Codex, disabled for Agent Teams`
- disabled models can still display catalog metadata and effort metadata for transparency

### 5. Codex binary version and app-server method compatibility

`🎯 7   🛡️ 9   🧠 6`  
Estimated implementation impact: `220-420` lines

Uncertainty:

- `codex app-server` is documented as an app-server integration surface, but local users can have older Codex binaries.
- `model/list` may be missing, renamed, or return a narrower shape in older binaries.
- Current `JsonRpcStdioClient` collapses JSON-RPC errors to `Error(message)`, which loses method, code, and structured details needed to distinguish `method not found` from auth/network/timeout.
- Current `CodexBinaryResolver` caches only binary path, not binary version.

Decision:

- make binary version part of catalog cache identity
- add structured JSON-RPC error metadata before implementing catalog fallback
- treat `method not found` as `static-fallback`, not as account failure
- treat malformed model rows as catalog degradation, not app-server runtime failure
- clear catalog cache when resolved Codex binary path or version changes

Required implementation detail:

```ts
export class JsonRpcRequestError extends Error {
  readonly method: string;
  readonly code: number | null;
  readonly details: unknown;
}
```

The app-server model client should classify:

- `method_not_found`: fallback to static catalog and show upgrade hint
- `timeout`: stale cache if available, then fallback
- `malformed_response`: fallback plus diagnostics
- `process_exit`: shared app-server failure for all sub-results in combined snapshot
- `auth_required`: account/read decides auth truth; model/list must not invent auth truth

### 6. `auto` auth resolution for model catalog

`🎯 7   🛡️ 9   🧠 6`  
Estimated implementation impact: `180-320` lines

Uncertainty:

- UI lets users pick `auto`, `chatgpt`, or `api_key`.
- Catalog can differ between ChatGPT subscription and API key.
- The model picker must preview the catalog for the mode that launch will actually use, not only the configured preference.

Decision:

- `preferredAuthMode=auto` is not a catalog scope by itself
- resolve `auto` into `effectiveAuthMode` using the same readiness logic as launch
- catalog request should be scoped to the effective launch mode
- Provider Settings can show both preference and effective catalog scope when they differ
- if effective mode flips from ChatGPT to API key because ChatGPT becomes unavailable, keep stale ChatGPT catalog visually stale and refresh API-key catalog

UX copy rule:

- do not say `Detected from OPENAI_API_KEY` as the primary model catalog source when ChatGPT account is the effective mode
- show API-key availability only as fallback/secondary when selected auth is ChatGPT or auto resolves to ChatGPT

### 7. App-server notifications and refresh cadence

`🎯 8   🛡️ 8   🧠 5`  
Estimated implementation impact: `160-260` lines

Uncertainty:

- account login flow has notifications
- current docs and local probe do not establish a dedicated model-catalog changed notification
- keeping a long-lived app-server just for model catalog would increase lifecycle complexity

Decision:

- do not introduce a long-lived model catalog subscription in this rollout
- use short-lived app-server sessions for refresh
- trigger catalog refresh after login success, logout, auth mode change, API-key source change, manual refresh, and provider status refresh
- do not poll `model/list` aggressively from renderer
- use `10 minute` success TTL and stale cache for UI continuity

If a future app-server release adds model catalog notifications, integrate them later behind the catalog feature port without changing renderer contracts.

### 8. Backup, restore, and relaunch compatibility

`🎯 7   🛡️ 9   🧠 7`  
Estimated implementation impact: `240-520` lines

Uncertainty:

- team launch metadata already persisted provider/model/effort/backend in several places
- adding dynamic defaults and resolved model identity can make old backups ambiguous
- old teams may contain no `modelCatalog` metadata

Decision:

- new `ProviderModelLaunchIdentity` is additive
- old teams without it remain readable
- relaunch derives missing identity from existing provider/model/effort/backend fields
- restore does not require the old catalog to be available
- if restored explicit model is missing from current catalog, UI preserves the explicit model with a warning instead of silently replacing it with current default
- if restored model was `Default`, relaunch preview resolves it against current catalog and says so before launch

Migration rule:

```text
old explicit model -> selectedModelKind="explicit", resolvedLaunchModel=old model
old empty model -> selectedModelKind="default", resolvedLaunchModel=current default at next launch
missing effort -> selectedEffort=null, resolvedEffort=current model default at next launch
```

### 9. UI and orchestrator version skew

`🎯 7   🛡️ 10   🧠 7`  
Estimated implementation impact: `280-620` lines

Uncertainty:

- `claude_team` and `agent_teams_orchestrator` can be updated at different times.
- UI can learn about `xhigh`, `minimal`, or a future model like `gpt-5.5` before the installed orchestrator can launch it safely.
- The current orchestrator static Codex helpers can reject a model that Codex app-server already exposed.

Decision:

- catalog visibility and launch capability are separate contracts
- UI may display app-server catalog metadata as soon as it is available
- UI must not enable launch controls that require new orchestrator behavior until runtime capability says that behavior exists
- provider-explicit Codex model strings can be accepted only after orchestrator declares dynamic Codex model support
- Codex `xhigh` can be shown as metadata before Phase 4, but it is disabled for launch until Codex effort pass-through is available

Required runtime capability contract:

```ts
export interface ProviderRuntimeCapabilities {
  providerId: TeamProviderId;
  codex?: {
    supportsDynamicAppServerModels: boolean;
    supportsCodexReasoningEffortConfig: boolean;
    supportedCodexReasoningEfforts: Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>;
    acceptsProviderExplicitFutureModels: boolean;
  };
}
```

Compatibility rule:

```text
catalog says model/effort exists
+ team policy says model is not disabled
+ runtime capability says launch path supports it
= launch control enabled
```

If any part is missing, the picker can still display the model, but launch must be disabled with explicit copy.

Recommended copy:

- `Available in Codex, waiting for Agent Teams runtime support`
- `This Codex effort is visible in Codex, but this Agent Teams runtime cannot launch it yet`
- `Upgrade the Agent Teams runtime to use this model`

This avoids a bad state where the user selects `xhigh` successfully in UI and then gets a late `codex exec` failure.

### 10. Future model policy, including `gpt-5.5`

`🎯 8   🛡️ 8   🧠 6`  
Estimated implementation impact: `240-520` lines

Uncertainty:

- app-server can expose a new model immediately after OpenAI releases it.
- the user goal is that new Codex models appear without us shipping a new static list.
- Agent Teams still needs a safety layer so one unexpected model row does not break team launch flows.

Top 3 policies:

1. Allow every app-server-visible model immediately: `🎯 8   🛡️ 5   🧠 3`, `80-180` lines. This best solves future releases, but it can route unverified models into team launch without product copy or rollback clarity.
2. Show every app-server-visible model immediately, launch with capability gate plus "new model" warning: `🎯 9   🛡️ 8   🧠 5`, `240-520` lines. This keeps future models visible without app releases, but still blocks only real launch incompatibilities.
3. Hide or disable unknown models until a code release updates policy: `🎯 4   🛡️ 9   🧠 2`, `60-120` lines. This is safe but defeats the reason to use `model/list`.

Chosen policy: option 2.

Implementation rule:

- app-server-visible, non-hidden models appear in the picker immediately
- known disabled Agent Teams models remain disabled
- new unknown models are selectable only if runtime capabilities support dynamic Codex models
- new unknown models get a `New from Codex catalog` note until a successful launch or explicit policy promotion marks them `verified`
- if the new model does not expose usable text input or any supported effort we can launch, it is shown but disabled
- hidden models are never introduced into new-team pickers by default

Policy statuses:

```ts
export type CodexTeamModelPolicyStatus =
  | 'verified'
  | 'new-from-codex-catalog'
  | 'disabled-for-agent-teams'
  | 'requires-runtime-upgrade'
  | 'missing-from-current-catalog';
```

This means `gpt-5.5` can appear the day app-server returns it, but the UI will not pretend the full Agent Teams launch path is verified unless the local runtime can actually handle provider-explicit dynamic Codex models.

### 11. Hidden, upgraded, and persisted models

`🎯 8   🛡️ 9   🧠 5`  
Estimated implementation impact: `160-340` lines

Uncertainty:

- official docs say `includeHidden: false` returns picker-visible models by default.
- persisted teams can reference a model that later becomes hidden, upgraded, renamed, or unavailable.
- app-server exposes `upgrade` and `upgradeInfo`, but we do not know every future migration shape.

Decision:

- normal picker uses `includeHidden: false`
- if a persisted explicit Codex model is not found in the visible catalog, run one scoped refresh with `includeHidden: true`
- if hidden lookup finds the model, show it as `Hidden in Codex catalog` and keep relaunch possible only if runtime capability and team policy allow it
- if `upgrade` points to a visible replacement, show a non-destructive migration suggestion
- never auto-rewrite persisted model ids during restore or relaunch

Relaunch behavior:

```text
visible model found -> normal relaunch
hidden model found -> relaunch allowed only with warning and policy pass
upgrade available -> show "Switch to recommended model" action
missing model -> keep value visible, require user to choose another model before launch
```

This avoids both failure modes: silently changing a user's team model, or breaking old teams because a model moved out of the default picker.

### 12. Stored effort schema and non-dialog launch paths

`🎯 7   🛡️ 9   🧠 7`  
Estimated implementation impact: `320-760` lines

Uncertainty:

- effort is not used only in launch dialogs.
- team metadata, member metadata, backup/restore, draft retry, localStorage launch params, and scheduled/provisioned flows can all carry `effort`.
- current normalizers in team data paths may silently discard anything outside `low | medium | high`.

Decision:

- provider-aware effort parsing must be added at every inbound boundary, not only in React components
- old persisted `low | medium | high` values stay valid
- new Codex-specific values are preserved only with provider/model context
- if provider context is missing, parse as legacy effort and do not invent Codex-specific meaning
- scheduled launches and automation-like flows must either be updated in the same phase or explicitly block Codex-only efforts until updated

High-risk code paths to audit during implementation:

- `src/main/services/team/TeamMembersMetaStore.ts`
- `src/main/services/team/TeamDataService.ts`
- `src/main/services/team/TeamBackupService.ts`
- `src/main/services/team/TeamProvisioningService.ts`
- `src/shared/types/schedule.ts`
- `src/main/ipc/teams.ts`
- `src/main/http/teams.ts`
- renderer launch prefill and draft retry localStorage state

Migration rule:

```text
legacy effort with no provider context -> keep if low | medium | high
codex effort with provider=codex -> validate against selected model catalog
codex effort with provider missing -> store as selected string only, resolve before launch
unsupported restored effort -> show warning, do not silently downgrade
```

### 13. Renderer stale state, HMR, and out-of-order refreshes

`🎯 8   🛡️ 9   🧠 5`  
Estimated implementation impact: `180-380` lines

Uncertainty:

- previous provider settings work showed transient wrong states after HMR and slow refreshes.
- catalog, account, and rate limits can refresh with different timings.
- a stale app-server response can arrive after a newer auth-mode change.

Decision:

- every provider status refresh should carry a monotonic `requestId` or `snapshotVersion`
- renderer stores the latest accepted version per provider
- responses older than the latest accepted version are ignored
- `modelCatalog.schemaVersion` is required and future versions are treated as degraded, not fatal
- HMR should keep last ready provider status visible while a refresh is in flight
- a catalog refresh cannot overwrite account connected state unless it came from the same combined snapshot

Required stale-write guard:

```text
if incoming.providerId != current.providerId -> reject
if incoming.requestId < current.requestId -> reject
if incoming.authScope != current.authScope and incoming.status is not from current auth selection -> keep as stale diagnostics only
```

This directly targets flicker like `Codex native unavailable` followed by ready state, or fallback API-key copy appearing while ChatGPT account mode is selected.

### 14. Privacy, logs, and diagnostics

`🎯 8   🛡️ 9   🧠 4`  
Estimated implementation impact: `120-260` lines

Uncertainty:

- account-scoped cache keys need stable identity, but raw email should not leak into exact logs, runtime snapshots, or persistent diagnostics.
- API-key source is useful for UX, but no secret or env value should be logged.

Decision:

- hash managed account identity in memory for cache keys
- use a per-process salt for volatile cache keys
- do not persist raw account email solely for model catalog cache
- exact logs can record `authScope=chatgpt` or `authScope=api_key`, not raw account identity
- diagnostics can record `apiKeySource=OPENAI_API_KEY` but never the value
- error messages preserve method/code/timeout, but redact command env and tokens

Required diagnostic fields:

```ts
export interface CodexModelCatalogDiagnostics {
  source: 'app-server' | 'static-fallback' | 'unavailable';
  status: 'ready' | 'stale' | 'degraded' | 'unavailable';
  method?: 'model/list';
  errorCode?: string | number | null;
  errorCategory?: string | null;
  binaryVersion?: string | null;
  effectiveAuthMode?: 'chatgpt' | 'api_key' | null;
  cacheAgeMs?: number | null;
}
```

No UI surface should show `Unknown error` for catalog failures after this feature.

### 15. Rollout ordering across repos

`🎯 8   🛡️ 10   🧠 6`  
Estimated implementation impact: `120-260` lines

Uncertainty:

- `claude_team` can ship UI before the user has a compatible `agent_teams_orchestrator` runtime in cache.
- the app can point to `CLAUDE_DEV_RUNTIME_ROOT`, bundled runtime cache, or a user-installed runtime binary.

Decision:

- implement orchestrator support first or behind a UI capability gate
- Provider Settings can show catalog metadata before launch support exists
- Create/Launch dialogs must consult runtime capabilities before enabling new Codex models or new Codex efforts
- the runtime health check should expose a version/capability payload, not force UI to infer support from binary version strings
- if capabilities are unavailable, default to safe: display metadata, disable launch-only features

Rollout sequence:

1. Add orchestrator dynamic Codex model and effort capability support.
2. Add `claude_team` catalog feature and provider status metadata.
3. Show catalog in UI with capability gates.
4. Enable launch when capability and catalog agree.
5. Remove any temporary guard only after bundled runtime and dev runtime both report capabilities in CI/smoke.

This is the cleanest way to avoid UI and runtime getting out of sync.

### 16. Codex config/profile/cwd catalog mismatch

`🎯 6   🛡️ 10   🧠 8`  
Estimated implementation impact: `360-900` lines

Uncertainty:

- official config docs allow `model_catalog_json`, and profile-level `profiles.<name>.model_catalog_json` can override it.
- Codex loads project-scoped `.codex/config.toml` only when a project or worktree is trusted.
- `codex exec` can run with a different `cwd`, profile, and inline `-c` overrides than the short-lived app-server preview session.
- current `CodexAppServerSessionFactory` starts `codex app-server` without an explicit `cwd` or profile.

Failure mode:

- Provider Settings shows catalog A from global config.
- Launch runs `codex exec` in project cwd with project-scoped or profile config and effectively uses catalog B.
- The user selects a model that preview says is valid, but launch resolves against a different provider/catalog.

Top 3 policies:

1. Global-only catalog preview: `🎯 7   🛡️ 5   🧠 3`, `80-180` lines. Fast and simple, but wrong for project-scoped Codex configs.
2. Project-scoped catalog preview for launch flows, global preview for dashboard: `🎯 9   🛡️ 9   🧠 7`, `360-900` lines. More work, but it matches actual `codex exec` launch context.
3. Ignore config and force a static OpenAI Codex provider always: `🎯 5   🛡️ 8   🧠 4`, `200-420` lines. Safer than mismatch, but it discards legitimate user Codex config and can surprise power users.

Chosen policy: option 2.

Decision:

- dashboard/provider card can show a global Codex catalog snapshot
- Create/Launch dialogs must fetch or resolve catalog for the selected launch `cwd`
- if profile selection exists or is introduced, catalog cache key must include profile name
- if we pass inline config overrides to `codex exec`, equivalent preview scope must include those overrides or launch must be marked "not preview-verified"
- if project trust/config cannot be resolved, launch UI falls back to global catalog but shows `Catalog may differ for this project`

Required preview scope:

```ts
export interface CodexModelCatalogScope {
  codexHome: string;
  binaryPath: string;
  binaryVersion: string | null;
  cwd: string | null;
  projectTrust: 'trusted' | 'untrusted' | 'unknown';
  profileName: string | null;
  configFingerprint: string | null;
  preferredAuthMode: 'auto' | 'chatgpt' | 'api_key' | null;
  effectiveAuthMode: 'chatgpt' | 'api_key' | null;
  launchOverridesFingerprint: string | null;
}
```

Cache key correction:

```text
catalogCacheKey =
  binaryPath
  + binaryVersion
  + codexHome
  + cwd or "global"
  + projectTrust
  + profileName or "default-profile"
  + configFingerprint or "unknown-config"
  + launchOverridesFingerprint or "no-launch-overrides"
  + preferredAuthMode
  + effectiveAuthMode
  + forcedLoginMethod or "no-forced-login-method"
  + forcedWorkspaceHash or "no-forced-workspace"
  + managedAccountHash or "no-chatgpt-account"
  + apiKey.source or "no-api-key"
```

Implementation notes:

- use app-server `config/read` when available to get effective config fingerprints for the same scope that launch will use
- do not parse arbitrary TOML as the primary config source if app-server can resolve effective configuration
- if app-server cannot scope `config/read` by cwd/profile, keep that uncertainty visible in diagnostics
- do not use raw config file contents as a cache key or log payload; hash only the relevant effective keys

Relevant effective keys:

- `model`
- `model_provider`
- `model_catalog_json`
- `profiles.<name>.model_catalog_json`
- `model_reasoning_effort`
- `forced_login_method`
- `forced_chatgpt_workspace_id`
- `openai_base_url`
- `model_providers.*` only as a redacted structural fingerprint
- `projects.<path>.trust_level`

Acceptance:

- a team launch from project A and project B can have different Codex catalog cache entries
- a trusted project `.codex/config.toml` changing `model_catalog_json` invalidates preview for that project
- global dashboard status does not claim to be launch-exact for every project
- exact logs record the catalog scope fingerprint, not raw config values

### 17. Built-in OpenAI Codex provider vs custom/OSS Codex config

`🎯 7   🛡️ 9   🧠 7`  
Estimated implementation impact: `260-620` lines

Uncertainty:

- Codex config supports `model_provider`, custom providers, `oss_provider`, and provider auth settings.
- Agent Teams "Codex" provider is intended to mean native Codex through OpenAI/ChatGPT subscription or API-key billing, not arbitrary custom provider execution.
- app-server `model/list` can be influenced by configuration, but our product copy currently talks about Codex subscription.

Decision:

- this cutover should keep Agent Teams Codex scoped to the built-in OpenAI Codex provider
- custom provider and OSS provider support should be a separate provider feature, not silently mixed into `provider=codex`
- if effective config says `model_provider` is not built-in OpenAI for the launch scope, show a clear warning and block subscription-mode launch unless the user intentionally switches to a future custom-provider flow
- when launching Agent Teams Codex, pass or enforce provider config consistently so `codex exec` uses the same provider class previewed by the catalog

Recommended launch guard:

```text
if provider=codex and effective model_provider is neither missing nor "openai":
  status = degraded
  launch = blocked
  copy = "This project config points Codex at a custom/local provider. Agent Teams Codex currently supports the built-in OpenAI Codex provider only."
```

If the team wants to support custom providers later:

- add a separate `provider=codex-custom` or generic OpenAI-compatible provider
- do not reuse subscription UX or rate-limit UI
- do not show ChatGPT account limits for custom provider launches

This prevents a confusing case where UI says "Codex subscription" but runtime actually routes to local OSS or a custom endpoint.

### 18. Modalities and personality support

`🎯 8   🛡️ 9   🧠 4`  
Estimated implementation impact: `120-280` lines

Uncertainty:

- app-server model rows expose `inputModalities` and `supportsPersonality`.
- Agent Teams launch prompts are text-first today, but future UI can attach images or personality-like instructions.
- older model catalogs can omit `inputModalities`, and docs say missing modalities should be treated as `["text", "image"]` for backward compatibility.

Decision:

- launchability requires `text` input support
- image support is displayed as capability metadata, not required for normal team launch
- `supportsPersonality=false` must not disable normal team launch, but the UI must not claim `/personality` or personality-specific behavior for that model
- missing `inputModalities` uses the documented backward-compatible default

Validation rule:

```text
if inputModalities exists and does not include "text":
  show model, disable launch, copy "This Codex model is not text-launch compatible for Agent Teams"

if supportsPersonality=false:
  hide personality controls for this model if those controls exist
```

This keeps model picker truthful without overfitting to the current text-only launch flow.

### 19. Stable app-server surface vs experimental fields

`🎯 8   🛡️ 9   🧠 4`  
Estimated implementation impact: `80-180` lines

Uncertainty:

- app-server has an `experimentalApi` capability.
- `model/list` itself is documented on the stable API overview, but adjacent methods and future richer fields can be experimental.
- opting into experimental API globally can change response surface and error behavior.

Decision:

- keep `experimentalApi=false` for the model catalog rollout
- rely only on stable `model/list` fields listed in the docs
- treat extra fields as diagnostics only
- add a later explicit spike before using experimental catalog, plugin, or app-server thread features in this path

Acceptance:

- catalog tests run with `experimentalApi=false`
- no Phase 1-5 task depends on experimental fields
- if a future field appears, normalization ignores it unless we add a typed, tested use case

### 20. App-server preview vs native exec signoff

`🎯 8   🛡️ 10   🧠 6`  
Estimated implementation impact: `180-420` lines

Uncertainty:

- `model/list` is the correct picker source, but the actual launch surface remains `codex exec --json`.
- a model can appear in app-server before `codex exec` in the installed binary handles it correctly.
- effort config can be accepted syntactically but rejected by the model/provider at runtime.

Decision:

- app-server catalog is necessary for UI, but not the only release gate for enabling new launch capability
- Phase 4 must include a live or mocked native-exec compatibility probe for the selected launch path
- native exec signoff should test model, provider scope, cwd, profile, and non-default effort together
- if live signoff is not available in CI, use a fixture-based unit test plus one documented local smoke command before merging

Required signoff matrix:

```text
default model + default effort + selected cwd
explicit gpt-5.4 + xhigh + selected cwd
gpt-5.1-codex-mini + high + selected cwd
gpt-5.1-codex-mini + xhigh -> blocked before exec
synthetic future model + capability disabled -> blocked before exec
synthetic future model + capability enabled -> argv accepted by orchestrator test
custom model_provider config -> blocked or explicit custom-provider copy
```

This prevents the plan from treating app-server catalog presence as proof that the full Agent Teams runtime path is healthy.

### 21. `config/read` scope contract is only partially documented

`🎯 7   🛡️ 9   🧠 6`  
Estimated implementation impact: `180-420` lines

Uncertainty:

- docs list `config/read`, but the detailed request/response shape is not as explicit as `model/list`.
- local probe confirms `config/read` returns `{ config, origins }` and accepts `params`.
- local probe confirms missing `params` returns `-32600`, so callers must always send `{}` at minimum.
- local probe confirms `{ cwd }` and `{ profile }` are accepted, but we still need tests around whether they fully mirror `codex exec --cd/--profile` in all installations.

Decision:

- treat `config/read` as a feature-detected helper, not as a hard dependency for model catalog availability
- always call `config/read` with an object, never with missing params
- include `config/read` method/code/details in diagnostics
- if scoped `config/read` fails but global succeeds, mark launch catalog as `scope_unverified`, not `ready`
- if `config/read` is missing on older binaries, fall back to global catalog and require runtime capability plus explicit degraded copy before launch enablement

Recommended DTO:

```ts
export interface CodexAppServerConfigReadParams {
  cwd?: string | null;
  profile?: string | null;
}

export interface CodexAppServerConfigReadResponse {
  config: Record<string, unknown>;
  origins: Record<string, unknown>;
}
```

Feature-detect result:

```ts
export type CodexConfigReadSupport =
  | 'supported-scoped'
  | 'supported-global-only'
  | 'method-missing'
  | 'failed';
```

Acceptance:

- unit tests cover missing `params`, method-not-found, global success, scoped success, and scoped failure
- `config/read` failure never breaks account/rate-limit/model-list reads
- launch UI does not present a project-scoped catalog as verified unless config scope was actually checked

### 22. Forced login method and ChatGPT workspace scope

`🎯 7   🛡️ 10   🧠 6`  
Estimated implementation impact: `180-420` lines

Uncertainty:

- effective Codex config can include `forced_login_method`.
- effective Codex config can include `forced_chatgpt_workspace_id`.
- workspace/account policy can affect available models, rate limits, and whether ChatGPT subscription mode is valid.
- previous Codex account work already had a real bug around forced login method, so this is not theoretical.

Decision:

- auth scope must include forced login method and forced workspace identity when present
- if UI-selected auth mode conflicts with `forced_login_method`, effective auth mode wins and UI must explain why
- forced workspace id must be hashed before cache/log usage
- rate-limit, account, and model catalog snapshots must be scoped together so workspace changes cannot reuse stale catalog

Auth scope correction:

```ts
export interface CodexCatalogAuthScope {
  preferredAuthMode: 'auto' | 'chatgpt' | 'api_key' | null;
  effectiveAuthMode: 'chatgpt' | 'api_key' | null;
  forcedLoginMethod: 'chatgpt' | 'api_key' | null;
  managedAccountHash: string | null;
  forcedWorkspaceHash: string | null;
  apiKeySource: string | null;
}
```

UX rules:

- if user selected ChatGPT but config forces API key, show `Codex config forces API key mode for this scope`
- if user selected API key but config forces ChatGPT, show `Codex config forces ChatGPT account mode for this scope`
- if workspace id changes, show `Codex workspace changed, refreshing subscription limits and model catalog`
- never show raw workspace id in UI unless Codex app-server provides a display name that is intended for users

Cache invalidation:

- forced login method change invalidates both auth and catalog cache
- forced workspace hash change invalidates ChatGPT-scoped rate limits and catalog
- account logout clears all ChatGPT workspace-scoped entries

### 23. Model catalog file trust and local file changes

`🎯 6   🛡️ 9   🧠 7`  
Estimated implementation impact: `220-520` lines

Uncertainty:

- `model_catalog_json` can point to a local JSON file.
- app-server resolves effective config, but our app may not know if that JSON file changed unless config fingerprint includes enough origin data.
- project-scoped `.codex/config.toml` only applies for trusted projects, so a file can exist but not be active.

Decision:

- treat `model_catalog_json` as part of effective config, not as a file we parse directly by default
- if `config/read.origins` exposes enough origin/path data, hash only path and mtime for invalidation, not file contents
- if origin/path data is unavailable, rely on manual refresh and short TTL
- never read arbitrary `model_catalog_json` file contents into logs or diagnostics
- do not apply project-scoped model catalog unless Codex effective config says the project is trusted and the catalog is active

Top 3 invalidation policies:

1. TTL/manual-refresh only: `🎯 7   🛡️ 6   🧠 2`, `40-100` lines. Simple but stale after local file edits.
2. Hash effective config plus optional mtime for active catalog file: `🎯 8   🛡️ 9   🧠 5`, `220-520` lines. Best balance without parsing arbitrary catalog files ourselves.
3. Parse and watch every possible catalog file: `🎯 5   🛡️ 7   🧠 8`, `500-1000` lines. Too much responsibility and security surface for this feature.

Chosen policy: option 2.

Acceptance:

- active `model_catalog_json` path change invalidates cache
- active catalog file mtime change invalidates cache when path is available
- inactive untrusted project `.codex/config.toml` does not affect the trusted/global catalog

## Top 3 Implementation Options

### 1. Dedicated Codex model catalog feature - chosen

`🎯 9   🛡️ 9   🧠 6`  
Estimated size: `1200-2400` lines

Core idea:

- create `src/features/codex-model-catalog`
- keep model catalog rules isolated from account UI, provider status plumbing, and Electron transport
- reuse existing `CodexAppServerSessionFactory`
- expose a small feature facade to provider status and renderer model picker
- update orchestrator only where runtime status and launch effort transport require it

Why it wins:

- best SOLID alignment
- clean domain rules for model visibility, effort validation, fallback, and default selection
- does not make `codex-account` responsible for model policy
- least risk to Anthropic
- easiest to test without full app startup

Main tradeoff:

- needs small integration glue in existing provider status and team launch flows

### 2. Fold catalog into `codex-account`

`🎯 7   🛡️ 7   🧠 5`  
Estimated size: `800-1600` lines

Core idea:

- extend `src/features/codex-account` with `model/list`
- use account snapshot as the only Codex control-plane snapshot
- merge account, rate limits, and model catalog in one feature

Why it is tempting:

- fewer new folders
- account feature already owns app-server account/rate-limit reads
- easier to fetch account plus model catalog in one app-server session

Why I do not recommend it:

- model catalog is not account management
- the feature becomes a broad Codex control-plane catch-all
- future provider catalog work would have to pull model rules back out
- more risk of account UI churn when only model picker changes are needed

### 3. Full provider model catalog for all providers now

`🎯 7   🛡️ 8   🧠 9`  
Estimated size: `2500-4500` lines

Core idea:

- build one provider-agnostic model catalog for Anthropic, Codex, Gemini, and future providers
- move static renderer catalog policy into a shared feature
- expose one rich contract for all provider model pickers

Why it is attractive:

- cleanest long-term abstraction
- one UI model for labels, availability, capabilities, and efforts
- reduces future duplication

Why not now:

- too much surface area while Codex runtime cutover is still fresh
- Anthropic model behavior is already stable and should not be reworked for a Codex catalog issue
- would delay the concrete Codex model release problem

## Current Code Reality

### `claude_team`

Existing app-server infrastructure:

- `src/main/services/infrastructure/codexAppServer/JsonRpcStdioClient.ts`
- `src/main/services/infrastructure/codexAppServer/CodexAppServerSessionFactory.ts`
- `src/main/services/infrastructure/codexAppServer/protocol.ts`
- `src/features/codex-account/main/infrastructure/CodexAccountAppServerClient.ts`

Current account client behavior:

- `readAccount()` opens one app-server session.
- `readRateLimits()` opens another app-server session.
- `logout()` opens another app-server session.
- no `model/list` protocol types exist yet.
- `CodexAppServerSessionFactory` starts `codex app-server` with no explicit `cwd` or profile option.
- app-server initialize response includes `codexHome`, but the current protocol types do not expose effective config or config fingerprint.

Current shared provider status:

- `CliProviderStatus.models` is only `string[]`.
- `CliProviderStatus.modelAvailability` has per-model verification status but no rich model metadata.
- renderer model selector can already prefer runtime-provided `providerStatus.models`.

Current effort type:

```ts
export type EffortLevel = 'low' | 'medium' | 'high';
```

Risk:

- adding `xhigh` directly without provider-specific validation would let Anthropic UI accidentally offer unsupported choices.

Current persistence and non-dialog launch paths:

- team metadata and member metadata normalize launch-derived provider/model/effort in multiple services.
- backup/restore copies metadata but restore-time launch preview must still tolerate missing catalog metadata.
- draft retry and launch prefill can reuse old localStorage state.
- scheduled launch types can reference the shared effort type.

Risk:

- updating only the visible launch dialogs would leave hidden paths that silently drop Codex-only efforts or relaunch with stale default semantics.

### `agent_teams_orchestrator`

Current Codex model catalog:

- `src/utils/model/codex.ts`
- static `CODEX_MODELS`
- static `DEFAULT_CODEX_MODEL`
- `isCodexModel()` checks only static ids

Current runtime status:

- `getUnifiedRuntimeStatusPayload('codex')` returns static Codex model ids.

Current CLI effort:

- top-level `--effort <level>` currently accepts `low | medium | high | max`.
- Codex native execution is ultimately `codex exec --json`.
- installed `codex exec --help` shows no `--effort` flag.

Risk:

- if we send `--effort xhigh` through current orchestrator, it fails before Codex can use it.
- if we map Anthropic `max` to Codex `xhigh`, the semantics are wrong.
- if we show `xhigh` in UI before the launch path supports it, the picker becomes misleading.

## Target Architecture

### Feature folder

```text
src/features/codex-model-catalog/
  contracts/
    codexModelCatalog.dto.ts
    index.ts
  core/
    domain/
      codexModelCatalog.ts
      codexReasoningEffort.ts
      codexModelCatalogFallback.ts
      normalizeCodexAppServerModel.ts
    application/
      GetCodexModelCatalogUseCase.ts
      CodexModelCatalogPorts.ts
  main/
    composition/
      createCodexModelCatalogFeature.ts
    adapters/
      output/
        CodexAppServerModelCatalogSource.ts
        StaticCodexModelCatalogSource.ts
    infrastructure/
      CodexModelCatalogAppServerClient.ts
      InMemoryCodexModelCatalogCache.ts
  preload/
    index.ts
  renderer/
    adapters/
      codexModelCatalogViewModel.ts
    hooks/
      useCodexModelCatalog.ts
    ui/
      CodexModelEffortHint.tsx
```

Rules:

- `core/domain` has all normalization and validation rules.
- `main/infrastructure` is the only layer that knows JSON-RPC method names.
- renderer never receives raw app-server rows.
- app shell imports only public feature entrypoints.

### App-server lifecycle

Use the existing `CodexAppServerSessionFactory`.

Request sequence:

1. Spawn `codex app-server`.
2. Send `initialize` with `clientInfo` and capabilities.
3. Send `initialized`.
4. Request `model/list`.
5. Drain or ignore notifications safely.
6. Close stdin and terminate the process on completion or timeout.

Recommended timeouts:

- initialize: `6000ms`
- `model/list`: `4500ms`
- total model catalog read: `9000ms`

Recommended pagination:

- request `limit: 100`, `includeHidden: false` for normal UI
- follow `nextCursor` until `null`
- hard-stop after 5 pages to avoid runaway loops
- log a degraded catalog warning if the hard-stop is hit

### Single-session snapshot policy

Provider status currently risks multiple sequential app-server starts:

- account read
- rate limits read
- future model list read

This caused slow provider loading in earlier UI work, so the plan should not add another app-server spawn in the hot path.

Preferred design:

- keep `codex-model-catalog` as a separate feature for ownership
- add an optional combined Codex control-plane read in composition
- when provider status refresh needs account plus rate limits plus model catalog, use one app-server session and issue all three requests inside it
- each sub-result has independent soft-failure state
- total snapshot can be partially healthy

Snapshot shape:

```ts
export interface CodexControlPlaneSnapshot {
  binary: {
    path: string;
    version: string | null;
  };
  account: CodexAccountSnapshotResult;
  rateLimits: CodexRateLimitsSnapshotResult;
  modelCatalog: CodexModelCatalogSnapshotResult;
  configScope: {
    cwd: string | null;
    profileName: string | null;
    projectTrust: 'trusted' | 'untrusted' | 'unknown';
    configReadSupport: CodexConfigReadSupport;
    effectiveConfigFingerprint: string | null;
    launchOverridesFingerprint: string | null;
    activeModelCatalogFileFingerprint: string | null;
  };
  initialize: {
    codexHome: string;
    platformFamily: string;
    platformOs: string;
  };
  fetchedAt: string;
}
```

Soft-failure rules:

- account failure must not erase a fresh cached model catalog
- model catalog failure must not mark ChatGPT account disconnected
- rate-limit failure must not hide model picker options
- if app-server initialize fails, all three sub-results are degraded from the same root cause

Required correction to the existing account flow:

- current `CodexAccountAppServerClient.readAccount()` and `readRateLimits()` each open their own app-server process
- adding a third standalone `readModelCatalog()` would be a Provider Settings latency regression
- implement a combined app-server read path before wiring catalog into provider refresh
- keep separate methods for mutations and focused tests, but use the combined path for normal status refresh
- enrich `JsonRpcStdioClient` errors before catalog integration so the combined reader can classify `model/list` method failures without losing account truth

Recommended application service shape:

```ts
export interface CodexControlPlaneReader {
  readSnapshot(options: CodexControlPlaneReadOptions): Promise<CodexControlPlaneSnapshot>;
}
```

This can live in `codex-model-catalog` composition or in a small shared Codex control-plane composition module. Do not put model normalization inside `codex-account`.

Read scope:

- Provider Settings global refresh can pass `cwd=null`.
- Create/Launch dialogs should pass the selected absolute `cwd`.
- Relaunch/restore should pass the team's persisted project path.
- Scheduled launch validation should pass `schedule.launchConfig.cwd`.
- If a future UI supports Codex profile selection, the same profile must be passed to preview and launch.

## Contracts

### App-server protocol types

Add protocol DTOs to `src/main/services/infrastructure/codexAppServer/protocol.ts`:

```ts
export type CodexAppServerReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface CodexAppServerReasoningEffortOption {
  reasoningEffort: CodexAppServerReasoningEffort;
  description?: string | null;
}

export type CodexAppServerInputModality = 'text' | 'image' | string;

export interface CodexAppServerModel {
  id: string;
  model: string;
  displayName: string;
  description?: string | null;
  hidden: boolean;
  supportedReasoningEfforts: CodexAppServerReasoningEffortOption[];
  defaultReasoningEffort: CodexAppServerReasoningEffort;
  inputModalities?: CodexAppServerInputModality[] | null;
  supportsPersonality?: boolean | null;
  isDefault: boolean;
  upgrade?: string | null;
  upgradeInfo?: unknown;
  availabilityNux?: unknown;
}

export interface CodexAppServerModelListParams {
  cursor?: string | null;
  limit?: number | null;
  includeHidden?: boolean | null;
}

export interface CodexAppServerModelListResponse {
  data: CodexAppServerModel[];
  nextCursor: string | null;
}

export interface CodexAppServerConfigReadParams {
  cwd?: string | null;
  profile?: string | null;
}

export interface CodexAppServerConfigReadResponse {
  config: Record<string, unknown>;
  origins: Record<string, unknown>;
}
```

`config/read` caller rule:

- always pass a params object, even when empty
- call global config as `config/read` with `{}`
- call project scope as `config/read` with `{ cwd }`
- call profile scope as `config/read` with `{ profile }`
- if both cwd and profile are needed, test `{ cwd, profile }` in Phase 1 and record the behavior before enabling profile-aware UI

### Domain model

Use separate ids:

- `catalogId`: app-server `id`, stable identity for React keys, telemetry, and dedupe
- `launchModel`: app-server `model` when non-empty, otherwise `id`

Reason:

- local probe currently returned equal values, but official schema exposes both fields, so they can diverge later.
- using `id` for launch would be a latent bug if Codex introduces a display/catalog alias.

```ts
export interface CodexCatalogModel {
  catalogId: string;
  launchModel: string;
  displayName: string;
  description: string | null;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: CodexReasoningEffort[];
  defaultReasoningEffort: CodexReasoningEffort | null;
  inputModalities: CodexInputModality[];
  supportsPersonality: boolean;
  upgrade: string | null;
  source: 'app-server' | 'static-fallback';
}
```

Normalization rules:

- reject rows without a usable `id`
- derive `launchModel` from `model || id`
- default missing `inputModalities` to `['text', 'image']` for older catalogs
- default missing `supportsPersonality` to `false`
- accept documented `supportedReasoningEfforts` objects with `reasoningEffort`
- defensively accept string effort entries in tests, because older generated local types and live clients can drift
- drop duplicate `catalogId` rows after the first visible row
- drop duplicate `launchModel` rows after the first visible row unless a hidden row is the only available row
- keep unknown effort strings out of the selectable UI, but preserve them in diagnostics
- if no model is marked `isDefault`, choose static fallback default only as degraded fallback and label it as such

### Provider status contract

Add an optional rich catalog to `CliProviderStatus`:

```ts
export interface CliProviderModelCatalog {
  schemaVersion: 1;
  source: 'app-server' | 'static-fallback' | 'unavailable';
  status: 'ready' | 'stale' | 'degraded' | 'unavailable';
  fetchedAt: string | null;
  staleAt: string | null;
  binary?: {
    path: string | null;
    version: string | null;
  };
  authScope?: {
    preferredAuthMode: 'auto' | 'chatgpt' | 'api_key' | null;
    effectiveAuthMode: 'chatgpt' | 'api_key' | null;
    forcedLoginMethod?: 'chatgpt' | 'api_key' | null;
    managedAccountHash?: string | null;
    forcedWorkspaceHash?: string | null;
    apiKeySource?: string | null;
  };
  launchScope?: {
    cwd: string | null;
    profileName: string | null;
    projectTrust: 'trusted' | 'untrusted' | 'unknown';
    configFingerprint: string | null;
    launchOverridesFingerprint: string | null;
  };
  errorMessage?: string | null;
  defaultModelId?: string | null;
  defaultLaunchModel?: string | null;
  models: CliProviderModelInfo[];
}

export interface CliProviderModelInfo {
  catalogId: string;
  launchModel: string;
  displayName: string;
  description?: string | null;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: CliProviderReasoningEffort[];
  defaultReasoningEffort?: CliProviderReasoningEffort | null;
  inputModalities?: string[];
  supportsPersonality?: boolean;
  upgrade?: string | null;
}

export type CliProviderReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface CliProviderRuntimeCapabilities {
  schemaVersion: 1;
  codex?: {
    supportsDynamicAppServerModels: boolean;
    supportsCodexReasoningEffortConfig: boolean;
    supportedCodexReasoningEfforts: Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh'>;
    acceptsProviderExplicitFutureModels: boolean;
  };
}
```

Backwards compatibility:

- keep `CliProviderStatus.models: string[]`
- add `CliProviderStatus.runtimeCapabilities?: CliProviderRuntimeCapabilities`
- for Codex, derive `models` from `modelCatalog.models.map(model => model.launchModel)`
- for Anthropic and Gemini, do not require `modelCatalog`
- old renderers continue to work from `models`
- new renderers prefer `modelCatalog` when present
- never put team-agent disabled policy directly into `CliProviderModelCatalog`; catalog describes Codex availability, while Agent Teams policy is applied by renderer and launch validators
- never infer launch capability only from catalog presence

Renderer integration hotspot:

- update `TeamModelRuntimeProviderStatus` in `src/renderer/utils/teamModelAvailability.ts` to include `modelCatalog`
- update `getRuntimeSelectorModels()` to use `modelCatalog.models[*].launchModel` for Codex
- update `getAvailableTeamProviderModelOptions()` to map rich Codex options with display labels, default badge, and catalog diagnostics
- keep Anthropic path on `getFallbackTeamProviderModelOptions()`
- keep Gemini path on existing `models: string[]` until Gemini has a richer catalog

### Team launch effort contract

Do not add a separate per-provider lane for this feature.

Use existing team-level model/provider selection, but make effort provider-aware.

Recommended implementation:

- keep persisted field name `effort`
- widen internal effort type to `ProviderReasoningEffort`
- add provider/model validators at every launch boundary
- Anthropic UI only shows `low | medium | high`
- Codex UI shows only the selected model's `supportedReasoningEfforts`
- orchestrator accepts `minimal | low | medium | high | xhigh` for Codex and `low | medium | high | max` for Anthropic paths

Existing validator hotspots:

- `src/shared/types/team.ts` currently defines `EffortLevel = 'low' | 'medium' | 'high'`
- `src/main/ipc/teams.ts` currently validates only `low | medium | high`
- `src/main/http/teams.ts` currently validates only `low | medium | high`
- `src/renderer/components/team/dialogs/EffortLevelSelector.tsx` currently hardcodes only `Default | Low | Medium | High`
- `LaunchTeamDialog`, `CreateTeamDialog`, member draft rows, and member editor utilities currently cast strings with `as EffortLevel`

Required migration:

- replace unsafe `as EffortLevel` casts with a provider-aware normalization function
- parse provider before parsing effort in IPC and HTTP paths
- validate lead effort against lead provider/model
- validate member effort against each member's resolved provider/model
- keep old persisted `low | medium | high` values readable without migration

Validation rule:

```text
provider=codex:
  effort must be in selectedModel.supportedReasoningEfforts

provider=anthropic:
  effort must be low | medium | high

provider=gemini:
  keep current behavior unless Gemini gets a richer effort contract
```

Important:

- do not map Anthropic `max` to Codex `xhigh`
- do not map Codex `xhigh` to Anthropic `max`
- if selected Codex model changes and old effort is unsupported, reset to the new model's `defaultReasoningEffort`
- if catalog is unavailable, only allow static fallback efforts that are proven launchable

Launch identity rule:

- `effort` is user selection
- `resolvedEffort` is what launch sends to runtime
- if user selection is empty/default, `resolvedEffort` comes from app-server `defaultReasoningEffort`
- if resolved effort equals app-server default, runtime transport may omit `model_reasoning_effort`, but exact logs still record the resolved value

## Runtime Launch Transport

This was the highest-risk area in the earlier plan. The corrected plan is explicit.

Facts:

- `codex exec` has `--model`.
- `codex exec` has `-c, --config key=value`.
- `codex exec` has no documented `--effort`.
- Codex config has `model_reasoning_effort`.
- `model_reasoning_effort` supports `minimal | low | medium | high | xhigh`.

Therefore:

- Codex native launch must not pass `--effort xhigh` to Codex CLI.
- Orchestrator may keep accepting `--effort` as its public Agent Teams flag.
- When provider is Codex native, orchestrator must translate accepted effort into `codex exec -c model_reasoning_effort="value"`.
- When no effort is selected, omit `model_reasoning_effort` and let Codex use its model default.
- When effort equals the selected model's app-server default, either omit it or pass it consistently, but pick one policy and test it.

Recommended policy:

- omit effort when it equals app-server `defaultReasoningEffort`
- pass effort only when user explicitly selected a non-default value

Reason:

- this tracks Codex defaults as Codex evolves
- exact logs remain cleaner
- future app-server default changes are not blocked by stale persisted values

Live signoff command shape:

```bash
codex exec --json --model gpt-5.4 -c model_reasoning_effort='"xhigh"' --skip-git-repo-check --ephemeral "Return only: ok"
```

Quoting requirement:

- command builder must pass `-c` and `model_reasoning_effort="xhigh"` as separate argv entries
- shell-rendered exact logs can show `-c model_reasoning_effort='"xhigh"'`
- tests should assert argv arrays, not only shell strings
- never concatenate user-controlled effort into a shell string without argv escaping

Prelaunch validation must block:

- `gpt-5.1-codex-mini` with `low`
- `gpt-5.1-codex-mini` with `xhigh`
- unknown effort strings from app-server until explicitly supported by our UI and orchestrator type

## Static Fallback

Fallback stays necessary because:

- user may have an older Codex binary
- app-server may fail to initialize
- app-server may start but not support `model/list`
- offline usage should not make the entire model picker empty
- tests should not depend on live Codex availability

Fallback rules:

- fallback source is explicitly marked `static-fallback`
- fallback never claims to be current
- fallback has a short visible warning in Provider Settings only when user is choosing Codex models
- fallback model list should be minimal and conservative
- fallback must not include newly guessed future models
- fallback caused by missing `model/list` should include an upgrade hint tied to the detected Codex binary version when available

Recommended fallback models:

- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.3-codex`
- `gpt-5.2`
- `gpt-5.1-codex-mini`

Fallback effort rules:

- use `medium | high` for `gpt-5.1-codex-mini`
- use `low | medium | high | xhigh` for known models only if live signoff confirms `model_reasoning_effort` pass-through
- otherwise fallback UI can show richer metadata but disable non-launchable options

API-key mode note:

- do not use OpenAI `/v1/models` as the primary Codex picker for subscription-backed Codex
- optional API `/v1/models` fallback is allowed only for explicit API-key mode diagnostics
- if API `/v1/models` disagrees with Codex app-server `model/list`, Codex app-server wins for native Codex execution
- reason: the actual runtime surface is `codex exec`, and app-server describes what Codex clients should show

## Cache And Refresh

Goal:

- make model updates feel fresh without making Provider Settings slow or flaky.

Main-process cache:

- key: Codex binary path plus Codex binary version plus Codex home plus launch cwd/profile/config fingerprint plus preferred auth mode plus effective auth mode plus managed account hash plus API-key source
- success TTL: `10 minutes`
- stale TTL: `24 hours`
- in-flight dedupe: one live `model/list` request per key
- manual refresh bypasses success TTL but still dedupes in-flight work
- auth mode change invalidates the ready cache for UI selection purposes
- `forced_login_method` and forced workspace changes invalidate the affected auth/catalog scope
- logout clears ChatGPT-scoped catalog cache
- API key source change clears API-key-scoped catalog cache
- project `.codex/config.toml`, global `config.toml`, or `model_catalog_json` changes clear the affected scope when detected by fingerprint change
- binary path or version change clears all Codex model catalog cache entries

Renderer cache:

- consume `CliProviderStatus.modelCatalog`
- no independent polling loop in the model picker
- refresh through existing provider status refresh action

Dashboard policy:

- do not run `model/list` on every dashboard render
- use existing provider status refresh cadence
- model catalog stale state can be shown only inside settings/model picker, not as a scary dashboard error
- dashboard catalog is a global/default-scope summary, not a promise that every project cwd has the same catalog

Provider Settings policy:

- open dialog with cached provider status immediately
- refresh in background
- show `Checking...` only for the area still being refreshed
- never replace a ready catalog with empty state during a refresh

Avoid this bug:

- do not set global provider status to `unavailable` while only the model catalog refresh is pending
- do not replace a ChatGPT-ready account state with a catalog timeout
- do not show generic `Unknown error`; preserve app-server method, timeout, and fallback source in diagnostics
- if `auto` resolves to ChatGPT, API-key detection copy stays secondary
- if `auto` resolves to API key because ChatGPT is unavailable, show why ChatGPT was skipped before showing API-key catalog

## UI Behavior

### Model picker

When `provider=codex`:

- prefer `providerStatus.modelCatalog.models`
- option value is `launchModel`
- React key can use `catalogId`
- label uses `displayName`
- default badge uses `isDefault`
- hidden app-server models are excluded from normal selector unless already persisted in a team
- disabled state uses existing Agent Teams policy plus app-server `upgrade` hints
- runtime-capability state controls whether a visible model is launchable
- fallback badge says `Using fallback catalog` only when source is fallback
- if app-server says a model is available but Agent Teams disables it, show `Available in Codex, disabled for Agent Teams`
- if app-server says a future model exists but runtime capability is missing, show `Available in Codex, waiting for Agent Teams runtime support`
- if a persisted model is missing from current catalog, show it as `Unavailable in current Codex catalog` and require user confirmation before relaunch
- if the dialog has a selected cwd and only a global catalog is available, show global options as provisional until project-scoped catalog finishes
- if project-scoped catalog differs from global catalog, keep the user's explicit selection only if it exists in the project-scoped catalog or is a preserved persisted value

When catalog is loading:

- keep previous options visible
- show a subtle "Refreshing models" state
- do not show an empty Codex picker unless no cached or fallback models exist
- label provisional global catalog rows as `Checking this project...` when launch cwd is known

When catalog fails:

- use stale cache if present
- otherwise use static fallback
- show the app-server error in diagnostics, not as a generic unknown error

### Effort selector

When `provider=codex` and selected model has catalog metadata:

- show efforts from `supportedReasoningEfforts`
- mark `defaultReasoningEffort` as default
- include `xhigh` if returned by app-server and runtime capability says Codex effort config pass-through is supported
- if runtime capability is missing, show Codex-only efforts as metadata or disabled rows, not selectable launch values
- if selected effort is no longer valid, reset to default with a small explanation
- if model is Agent Teams-disabled, keep effort selector read-only or disabled to avoid suggesting launchability

When selected model has no catalog metadata:

- show only safe fallback efforts
- do not show `xhigh` unless launch pass-through is implemented and tested

When `provider=anthropic`:

- keep current selector behavior
- do not show Codex-only `minimal`, `none`, or `xhigh`
- do not change Anthropic copy

### Default model

Recommended behavior:

- app-server `isDefault` defines the Codex default in UI
- "Default" label can render as `Default (gpt-5.4)` or `Default (GPT-5.4)` when catalog is ready
- new Codex teams can display `Default`, but launch must resolve it to a concrete `resolvedLaunchModel`
- existing teams keep their persisted model unless user changes it
- do not rewrite old team metadata just because app-server default changed
- exact logs and team metadata should record both selected `Default` and concrete resolved model

Reason:

- new teams benefit from current Codex defaults
- existing teams remain explainable even if Codex default changes later

## Orchestrator Changes

### Model status

Short term:

- keep static `CODEX_MODELS` for standalone fallback and non-app UI compatibility
- add richer status only if orchestrator can read app-server directly without slowing CLI startup

Recommended first cut:

- `claude_team` owns app-server model catalog for UI
- orchestrator keeps static runtime status until a dedicated orchestrator catalog source is added
- launch validation accepts provider-explicit Codex model strings even if not in static `CODEX_MODELS`
- orchestrator exposes runtime capabilities for dynamic Codex model ids and Codex reasoning effort config pass-through

Reason:

- UI is where the dynamic picker is needed immediately
- orchestrator should not reject a future model that Codex app-server already exposed and `claude_team` selected
- UI should not guess whether the current runtime can launch that future model

### Validation

Update validation so:

- provider-explicit `codex` launches can use model strings from app-server catalog
- unknown model strings are not guessed as Codex without provider context
- static `isCodexModel()` remains valid for generic detection, not authoritative for provider-explicit launches
- if provider context is missing, keep existing conservative static validation

### Effort transport

Update orchestrator:

- accept Codex efforts `minimal | low | medium | high | xhigh`
- preserve Anthropic `max`
- in Codex native executor, convert Codex effort to `-c model_reasoning_effort='"value"'`
- do not pass unsupported effort values to `codex exec`
- exact logs should show the selected effort as normalized Agent Teams metadata and the actual Codex config override

Required tests:

- Codex native `xhigh` becomes `-c model_reasoning_effort='"xhigh"'`
- no effort omits `model_reasoning_effort`
- Anthropic `max` remains Anthropic-only
- Codex `max` is rejected
- Anthropic `xhigh` is rejected

## Concrete Implementation Touchpoints

`claude_team`:

- `src/main/services/infrastructure/codexAppServer/protocol.ts` - add app-server model DTOs
- `src/main/services/infrastructure/codexAppServer/JsonRpcStdioClient.ts` - preserve JSON-RPC error code, method, and details
- `src/main/services/infrastructure/codexAppServer/CodexBinaryResolver.ts` or a nearby service - expose binary version for cache invalidation
- `src/features/codex-model-catalog` - new feature for catalog domain, use case, app-server source, fallback source, and cache
- `src/features/codex-account/main/composition/createCodexAccountFeature.ts` - coordinate combined control-plane snapshot or delegate to shared reader
- `src/features/codex-account/renderer/mergeCodexProviderStatusWithSnapshot.ts` - preserve account truth while merging model catalog truth
- `src/shared/types/cliInstaller.ts` - add optional provider model catalog
- `src/shared/types/team.ts` - widen provider-aware effort types without breaking old persisted values
- `src/shared/types/schedule.ts` - prevent scheduled launches from dropping Codex-specific efforts
- `src/main/services/team/TeamDataService.ts` - preserve provider-aware effort and launch identity when reconstructing team state
- `src/main/services/team/TeamMembersMetaStore.ts` - stop filtering Codex efforts down to legacy `low | medium | high`
- `src/main/services/team/TeamBackupService.ts` and restore paths - preserve additive launch identity and tolerate old backups
- `src/main/services/runtime/CliProviderModelAvailabilityService.ts` - keep runtime verification compatible with `launchModel` values and do not verify hidden/catalog-only rows by accident
- `src/main/ipc/teams.ts` and `src/main/http/teams.ts` - parse provider first, then validate effort
- `src/renderer/utils/teamModelAvailability.ts` - consume rich Codex catalog
- `src/renderer/utils/teamModelCatalog.ts` - demote Codex static list to fallback and labels only
- `src/renderer/components/team/dialogs/EffortLevelSelector.tsx` - make options provider/model-aware
- `src/renderer/components/team/dialogs/LaunchTeamDialog.tsx` and `CreateTeamDialog.tsx` - remove unsafe effort casts and persist resolved launch identity
- member draft/editor components - validate per-member resolved provider/model/effort
- renderer launch prefill and draft retry storage - add a versioned launch identity payload and tolerate old entries

`agent_teams_orchestrator`:

- `src/entrypoints/sdk/runtimeTypes.ts` - add provider-aware Codex effort support
- `src/main.tsx` - update `--effort` parser or provider-specific validation path
- `src/utils/effort.ts` and `src/utils/providerEffort.ts` - separate Anthropic `max` from Codex `xhigh`
- Codex native executor path - convert effort to `-c model_reasoning_effort`
- `src/utils/model/codex.ts` - rename static list semantics to fallback/static detection
- `src/utils/model/validateModel.ts` - allow provider-explicit Codex app-catalog models
- runtime status/capability endpoint - expose dynamic Codex model and effort pass-through support
- exact-log/runtime status code - record selected model, resolved model, selected effort, resolved effort, and config override

## Phased Implementation

### Phase 0 - contracts and live spike

Commit boundary: `docs(codex): plan app-server model catalog`

Tasks:

- add this plan
- keep live probe output in signoff notes or test fixture
- confirm installed Codex supports `model/list`
- confirm one app-server session can read account, rate limits, and model catalog
- confirm docs support `model_reasoning_effort`
- decide exact shell quoting for `-c model_reasoning_effort`
- capture fixtures for at least two catalog shapes: current live shape and synthetic `id !== model`
- capture current Codex binary version and document cache invalidation expectations

Acceptance:

- plan exists in the dedicated worktree
- no code behavior changes
- weak areas are explicitly called out

### Phase 1 - app-server model catalog feature

Commit boundary: `feat(codex): add app-server model catalog source`

Tasks:

- add structured JSON-RPC request errors with method/code/details
- expose or probe Codex binary version for catalog cache keys
- add effective config fingerprint support using app-server `config/read` when available
- add `config/read` support detection and always send `{}` params at minimum
- add `src/features/codex-model-catalog`
- add app-server protocol types
- add `CodexModelCatalogAppServerClient`
- add normalization domain rules
- add static fallback source
- add in-memory cache with TTL and in-flight dedupe
- include launch scope fields in cache keys: cwd, profile, trust, config fingerprint, launch override fingerprint
- include forced login method and forced workspace hash in auth-scoped cache keys
- normalize both documented effort option objects and defensive string effort values
- classify `method not found`, timeout, malformed response, and empty catalog separately
- add structured diagnostics without raw account email or secret-bearing env values
- expose feature facade from main composition

Acceptance:

- JSON-RPC `method not found` can be detected in tests
- binary version changes invalidate catalog cache
- config fingerprint changes invalidate catalog cache for that scope
- forced login/workspace changes invalidate account, limits, and catalog cache for that scope
- unit tests cover normalization, fallback, pagination, duplicate ids, missing modalities, unknown effort strings, and `id !== model`
- app-server client tests cover `model/list` request params and timeout labels
- method-not-found falls back without marking account disconnected
- diagnostics include source, status, method, error category, binary version, effective auth mode, and cache age
- no renderer behavior changes yet

### Phase 2 - provider status integration

Commit boundary: `feat(runtime): expose codex model catalog metadata`

Tasks:

- add optional `modelCatalog` to `CliProviderStatus`
- add optional `runtimeCapabilities` to `CliProviderStatus`
- merge Codex model catalog into provider status
- keep `models: string[]` derived from `launchModel`
- make provider refresh use cached, auth-scoped catalog
- implement combined account/rate-limits/catalog app-server read for normal refresh
- avoid extra app-server session in hot paths where account snapshot already refreshes
- clear ChatGPT-scoped catalog on logout and API-key-scoped catalog when API key source changes
- clear all catalog entries when Codex binary path or version changes
- ensure `auto` catalog scope follows effective launch auth mode, not just configured preference
- add request/snapshot versioning so stale refresh responses cannot overwrite newer auth state
- support global provider refresh and project-scoped launch refresh as different catalog scopes
- preserve Anthropic provider status shape

Acceptance:

- Codex provider status includes `modelCatalog`
- Codex provider status includes runtime capability metadata when available
- old `models` still works
- `auto` with ChatGPT ready uses ChatGPT-scoped catalog even if API key is detected
- `auto` with ChatGPT unavailable and API key ready uses API-key-scoped catalog with clear degraded copy
- forced login method overrides are reflected in effective auth copy and cache scope
- one normal Codex provider refresh does not spawn separate app-server processes for account, limits, and catalog
- Anthropic snapshots are byte-for-byte equivalent except ordering noise already present
- provider dashboard does not block on a slow catalog refresh when stale cache exists
- older refresh results are ignored after auth mode or runtime capability changes
- global dashboard catalog and project launch catalog do not overwrite each other

### Phase 3 - dynamic UI model picker and effort selector

Commit boundary: `feat(codex): use dynamic model catalog in team launch UI`

Tasks:

- update Codex model picker to prefer rich catalog
- show app-server labels, default badge, and fallback source state
- update effort selector to be provider/model-aware
- show `xhigh` metadata only for Codex models that return it
- make `xhigh` selectable only when runtime capability says Codex effort config pass-through is supported
- hide Codex-only efforts for Anthropic
- reset invalid effort on model change
- preserve missing persisted models as visible warning rows instead of silently clearing selection
- keep Agent Teams disabled policy separate from Codex app-server availability
- show future app-server models immediately, with `New from Codex catalog` status when policy has not verified them yet
- when cwd is selected, refresh project-scoped Codex catalog before enabling launch-only controls

Acceptance:

- `gpt-5.1-codex-mini` shows only `medium | high`
- `gpt-5.3-codex-spark` defaults to `high`
- `gpt-5.4` shows `low | medium | high | xhigh` as catalog metadata
- `xhigh` is disabled with runtime-upgrade copy until capability support is present
- app-server-visible but Agent Teams-disabled model shows disabled copy, not unavailable copy
- synthetic future `gpt-5.5` fixture appears without touching static catalog
- persisted model missing from current catalog is visible with a warning
- Anthropic UI remains `low | medium | high`
- static fallback still renders when app-server is unavailable
- global catalog can be displayed provisionally, but launch enablement waits for project-scoped catalog or explicit degraded confirmation

### Phase 4 - launch validation and Codex effort pass-through

Commit boundary: `feat(runtime): pass codex reasoning effort through native exec`

Tasks:

- widen team launch effort validation with provider-specific rules
- update IPC and HTTP validators
- update `TeamProvisioningService` request shaping
- persist additive `ProviderModelLaunchIdentity` into team metadata, exact-log metadata, and backup/restore payloads where launch identity is reconstructed
- update orchestrator parser and runtime types
- expose orchestrator runtime capability metadata for dynamic Codex models and Codex effort config
- translate Codex effort to argv entries `['-c', 'model_reasoning_effort="value"']`
- keep Anthropic `max` separate
- add exact-log metadata for selected model, resolved launch model, catalog source, selected effort, and resolved effort
- resolve `Default` to concrete launch model before provisioning
- update scheduled/provisioned launch paths or block Codex-only efforts in those paths until updated
- enforce built-in OpenAI Codex provider scope or block custom/OSS provider configs with clear copy
- pass profile/cwd/config overrides consistently between preview and `codex exec`

Acceptance:

- Codex `xhigh` launch reaches `codex exec` as `model_reasoning_effort`
- Codex `max` is rejected before launch
- Anthropic `xhigh` is rejected before launch
- unsupported model-effort pairs are blocked before provisioning
- provider-explicit synthetic future model is accepted only when runtime capability says dynamic Codex models are supported
- member metadata, team metadata, draft retry, and backup/restore preserve provider-aware effort
- replay/exact logs show what was selected, what default resolved to, and what was passed to Codex
- exact logs include catalog scope fingerprint and provider scope, but not raw config values

### Phase 5 - cleanup and fallback tightening

Commit boundary: `refactor(codex): demote static model catalog to fallback`

Tasks:

- rename static Codex catalog helpers to make fallback status explicit
- remove UI assumptions that static list is authoritative
- make future provider-explicit Codex ids launchable when selected from app-server catalog
- add diagnostics for catalog source and staleness
- document fallback behavior
- add a fixture/test with synthetic future model `gpt-5.5`
- remove any remaining hardcoded Codex model order from the primary Codex UI path
- add hidden-model fixture and upgrade-suggestion fixture
- add one migration test for old localStorage launch prefill without provider model launch identity
- add project-scoped catalog fixture with `model_catalog_json`
- add custom-provider config fixture
- add forced login method and forced workspace fixtures
- add `config/read` method-missing and invalid-params fixtures

Acceptance:

- new app-server model can appear in UI without code changes
- static fallback is visible as fallback in diagnostics
- no code path treats static `CODEX_MODELS` as the only valid Codex provider model list
- synthetic `gpt-5.5` appears through app-server fixture and can be selected without touching static catalog
- hidden persisted model is preserved with warning and is not introduced into new-team picker
- project-scoped catalog differences are visible and do not corrupt global provider status
- forced login method changes are visible and do not reuse stale catalog/rate-limit scope

## Test Plan

### `claude_team` unit tests

Add tests for:

- structured JSON-RPC error classification
- binary version cache invalidation
- effective config fingerprint cache invalidation
- `config/read` support detection, including invalid missing params
- project-scoped `model_catalog_json` fixture
- app-server model normalization
- `id` vs `model` split
- default model selection
- per-model effort options
- unknown effort filtering
- auth-scoped catalog cache keys
- `auto` auth resolving to ChatGPT vs API-key catalog scope
- combined app-server snapshot partial failures
- method-not-found fallback for older Codex app-server
- fallback catalog source
- stale cache behavior
- stale refresh response is ignored after newer auth-scope request
- global catalog and project-scoped catalog use separate cache entries
- forced login method and forced workspace hash use separate cache entries
- custom/OSS `model_provider` config is blocked or marked unsupported for Agent Teams Codex
- raw managed account email does not appear in catalog diagnostics or exact-log metadata
- provider status `models` compatibility
- provider status runtime capabilities compatibility
- provider model availability uses `launchModel`, not `catalogId`
- renderer model picker with rich catalog
- renderer effort selector with Codex and Anthropic providers
- renderer disables Codex-only efforts when runtime capability is missing
- renderer shows synthetic future model as `New from Codex catalog`
- renderer preserves hidden persisted model after `includeHidden: true` recovery
- persisted missing model warning row
- Agent Teams disabled policy overlay for app-server-visible models
- backup/restore reads old metadata and preserves new launch identity when present
- draft retry and launch prefill read old localStorage entries without dropping provider/model identity
- scheduled launch validation either supports Codex-specific effort or blocks it with explicit error
- launch preview with selected cwd does not enable launch from global-only catalog when project-scoped catalog is still unknown

Suggested commands:

```bash
pnpm vitest run \
  test/features/codex-model-catalog \
  test/features/codex-account \
  test/renderer/components/team \
  test/renderer/utils/teamModelCatalog.test.ts
```

### `agent_teams_orchestrator` tests

Add tests for:

- provider-explicit Codex model validation
- Codex effort parser accepts `minimal | low | medium | high | xhigh`
- Anthropic effort parser keeps existing behavior
- Codex native executor emits `-c model_reasoning_effort`
- Codex native executor builds argv entries, not unsafe shell concatenation
- no effort omits Codex effort config
- `max` is not accepted for Codex
- synthetic `gpt-5.5` passes when provider is explicitly Codex and model came from app catalog
- capability payload reports dynamic Codex model support and effort config support
- provider-explicit future model fails closed when capability is disabled
- Codex native exec argv includes cwd/profile/config override semantics that match preview scope
- custom provider config is not silently routed through subscription Codex UX

Suggested command:

```bash
pnpm test -- runtimeBackends providerEffort spawnMultiAgent codex
```

### live smoke

Run only when developer has Codex login/API available:

```bash
codex app-server
```

JSON-RPC smoke:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "model/list", "params": { "limit": 20, "includeHidden": false } }
```

Native exec effort smoke:

```bash
codex exec --json --model gpt-5.4 -c model_reasoning_effort='"xhigh"' --skip-git-repo-check --ephemeral "Return only: ok"
```

Failure smoke:

```bash
codex exec --json --model gpt-5.1-codex-mini -c model_reasoning_effort='"xhigh"' --skip-git-repo-check --ephemeral "Return only: ok"
```

Expected:

- our app should block the second case before launch once catalog metadata is available
- if run manually, Codex may return model/provider-specific error, but product UX should not rely on that late failure

## Risks And Mitigations

### Risk 1 - app-server startup slows provider settings

`🎯 8   🛡️ 8   🧠 5`

Mitigation:

- cache model catalog in main process
- dedupe in-flight refreshes
- use stale cache while refreshing
- combine account/rate-limit/catalog reads where possible
- never clear ready UI while refresh is pending

### Risk 2 - effort values leak into Anthropic

`🎯 9   🛡️ 9   🧠 4`

Mitigation:

- provider-specific effort validation
- renderer selector branches by provider and selected model
- tests for Anthropic not showing `xhigh`, `minimal`, or `none`
- orchestrator rejects invalid provider-effort pairs

### Risk 3 - `id` and `model` diverge later

`🎯 8   🛡️ 9   🧠 3`

Mitigation:

- use `catalogId` for identity
- use `launchModel` for runtime
- tests with fixture where `id !== model`

### Risk 4 - app-server catalog has unknown fields or new efforts

`🎯 8   🛡️ 8   🧠 5`

Mitigation:

- tolerant protocol DTOs
- unknown efforts preserved in diagnostics but not selectable
- add one small allow-list update when product intentionally supports a new effort
- no hard crash on unknown `inputModalities`

### Risk 5 - static fallback becomes accidentally authoritative again

`🎯 7   🛡️ 8   🧠 4`

Mitigation:

- name fallback helpers clearly
- include `source` in model catalog
- tests assert app-server source wins over fallback
- UI diagnostics expose fallback source

### Risk 6 - launch path accepts model from UI but orchestrator rejects it

`🎯 8   🛡️ 8   🧠 6`

Mitigation:

- provider-explicit Codex launch validation should trust `provider=codex` plus app-server-selected model
- static `isCodexModel()` remains only a generic detector
- exact tests with a future-model fixture like `gpt-5.5`

### Risk 7 - auth-scoped catalog leaks between modes

`🎯 7   🛡️ 9   🧠 6`

Mitigation:

- include auth scope in catalog cache key
- clear scoped cache on logout and API-key source changes
- tests for ChatGPT catalog not being reused in API-key mode
- UI labels catalog source and auth scope in diagnostics

### Risk 8 - Default becomes nondeterministic across relaunch

`🎯 8   🛡️ 9   🧠 6`

Mitigation:

- persist selected model kind and resolved launch model in launch identity
- exact logs record both `Default` and concrete model
- relaunch preview shows current default resolution before launch
- do not silently rewrite old explicit models

### Risk 9 - older Codex binary lacks `model/list`

`🎯 7   🛡️ 9   🧠 5`

Mitigation:

- preserve JSON-RPC error code and method
- classify method-not-found separately from app-server failure
- show static fallback with Codex upgrade hint
- cache key includes binary version so upgrades refresh the catalog

### Risk 10 - `auto` auth shows the wrong catalog

`🎯 7   🛡️ 9   🧠 6`

Mitigation:

- resolve effective auth mode before catalog scope
- keep ChatGPT and API-key catalogs separate
- UI copy distinguishes selected preference, effective launch mode, and fallback credentials
- tests cover ChatGPT-ready + API-key-present and ChatGPT-missing + API-key-ready cases

### Risk 11 - UI enables a capability the installed runtime cannot launch

`🎯 7   🛡️ 10   🧠 7`

Mitigation:

- add explicit runtime capability metadata
- display catalog metadata separately from launch enablement
- fail closed when capability is missing or stale
- test Phase 3 UI against a pre-Phase-4 runtime fixture

### Risk 12 - future models appear but break team-agent behavior

`🎯 8   🛡️ 8   🧠 6`

Mitigation:

- split Codex catalog availability from Agent Teams policy status
- show new models as `New from Codex catalog`
- block only hard incompatibilities: runtime capability missing, unsupported modality, disabled policy, unsupported effort
- exact logs record new-model status for later debugging

### Risk 13 - hidden or upgraded persisted models are silently lost

`🎯 8   🛡️ 9   🧠 5`

Mitigation:

- run one `includeHidden: true` lookup for persisted explicit models missing from visible catalog
- preserve model value during restore and relaunch preview
- show upgrade suggestions without auto-rewriting metadata
- test hidden-model and upgrade fixtures

### Risk 14 - non-dialog launch path drops Codex effort

`🎯 7   🛡️ 9   🧠 7`

Mitigation:

- audit team metadata, members metadata, backup/restore, draft retry, launch prefill, and schedule types
- parse provider before parsing effort at every main-process boundary
- block Codex-only effort in any path not updated in the same phase
- add tests outside React launch dialogs

### Risk 15 - HMR or slow refresh overwrites correct provider state

`🎯 8   🛡️ 9   🧠 5`

Mitigation:

- add request/snapshot versioning
- ignore out-of-order provider status responses
- do not let catalog failures overwrite account truth
- keep last ready state visible while a refresh is pending

### Risk 16 - global catalog preview differs from project launch catalog

`🎯 6   🛡️ 10   🧠 8`

Mitigation:

- include cwd, profile, trust, config fingerprint, and launch override fingerprint in catalog scope
- use app-server `config/read` when available to derive effective config
- keep dashboard/global catalog separate from launch/project catalog
- require project-scoped catalog before enabling launch-only controls when cwd is known

### Risk 17 - custom or OSS Codex config is mistaken for subscription Codex

`🎯 7   🛡️ 9   🧠 7`

Mitigation:

- keep Agent Teams Codex scoped to built-in OpenAI Codex provider
- detect effective `model_provider` when possible
- block or degrade custom/OSS provider configs with explicit copy
- do not show ChatGPT account limits for custom provider execution

### Risk 18 - non-text model row appears in catalog

`🎯 8   🛡️ 9   🧠 4`

Mitigation:

- require `text` input modality for Agent Teams launch
- treat missing `inputModalities` with the documented backward-compatible default
- do not claim personality support when `supportsPersonality=false`

### Risk 19 - experimental app-server surface changes behavior

`🎯 8   🛡️ 9   🧠 4`

Mitigation:

- keep `experimentalApi=false`
- rely only on documented stable `model/list` fields
- ignore unknown fields unless a typed use case is added

### Risk 20 - app-server catalog passes but native exec fails

`🎯 8   🛡️ 10   🧠 6`

Mitigation:

- treat app-server catalog as picker truth, not full launch proof
- require Phase 4 native exec argv tests and live smoke where possible
- test model, effort, cwd, profile, and provider scope together
- block unsupported model-effort pairs before `codex exec`

### Risk 21 - `config/read` behavior differs across Codex versions

`🎯 7   🛡️ 9   🧠 6`

Mitigation:

- feature-detect `config/read`
- always send `{}` params at minimum
- classify method-missing, invalid-params, scoped-failure, and global-success separately
- never make config-read failure disconnect the Codex account

### Risk 22 - forced login/workspace reuses stale catalog

`🎯 7   🛡️ 10   🧠 6`

Mitigation:

- include forced login method and forced workspace hash in auth scope
- invalidate account, limits, and catalog together when either changes
- display forced auth copy instead of showing conflicting selected auth copy
- redact workspace ids in logs and diagnostics

### Risk 23 - local `model_catalog_json` changes without config change

`🎯 6   🛡️ 9   🧠 7`

Mitigation:

- hash effective config and optionally active catalog file mtime when app-server exposes enough origin data
- keep TTL/manual refresh fallback when origin data is unavailable
- do not parse or log arbitrary catalog file contents
- do not apply untrusted project-scoped catalog files unless effective config says they are active

## Definition Of Done

The feature is done when:

- Codex model picker uses app-server `model/list` when available.
- New app-server-visible Codex models appear without app code changes.
- `supportedReasoningEfforts` and `defaultReasoningEffort` drive Codex effort UI.
- `xhigh` appears only where Codex reports it.
- Anthropic UI and launch behavior are unchanged.
- Codex launches pass effort through `model_reasoning_effort`.
- UI launch controls are gated by runtime capabilities, not by catalog metadata alone.
- Future app-server-visible models appear without code changes and are marked as new until policy/runtime support is clear.
- `Default` Codex selection resolves to concrete launch identity before provisioning.
- Auth changes do not reuse stale model catalogs across ChatGPT and API-key modes.
- Project-scoped Codex config and `model_catalog_json` cannot make launch use a different catalog than preview without explicit degraded copy.
- Custom or OSS Codex provider config is not silently presented as ChatGPT subscription-backed Agent Teams Codex.
- `config/read` compatibility is feature-detected and never breaks account truth on older binaries.
- Forced login method and forced workspace changes cannot reuse stale account, rate-limit, or catalog cache.
- Codex binary upgrades invalidate stale catalog cache and retry `model/list`.
- Older Codex binaries without `model/list` fall back without breaking account state.
- Static Codex catalog is clearly fallback, not primary truth.
- Hidden persisted models are preserved with explicit warnings.
- Backup/restore, draft retry, launch prefill, member metadata, and scheduled paths do not drop provider-aware effort.
- Exact logs and diagnostics do not persist raw account identifiers or secret values.
- Exact logs include catalog scope and provider scope fingerprints for debugging preview vs launch mismatch.
- HMR and out-of-order refreshes do not replace ready provider status with stale fallback/error state.
- Provider Settings remains fast and does not show transient empty/error states during refresh.
- Tests cover catalog source, fallback, effort validation, and launch pass-through.

## Final Signoff And Handoff

The implementation is now ready for review after these checks stay green:

1. `claude_team`: `pnpm typecheck`
2. `claude_team`: targeted catalog/runtime/team provisioning Vitest suites
3. `agent_teams_orchestrator_codex_native_spike`: targeted Codex native exec and runtime capability Bun suites
4. Live `codex app-server model/list` smoke against the installed Codex binary
5. Optional UI smoke with `CLAUDE_DEV_RUNTIME_ROOT=/Users/belief/dev/projects/claude/agent_teams_orchestrator_codex_native_spike`

Merge requirement:

- merge/pair the `claude_team` branch with the `agent_teams_orchestrator_codex_native_spike` runtime capability change.
- if the UI branch is merged without the runtime capability change, the feature remains safe but conservative: dynamic future Codex models and `xhigh` are visible as catalog metadata but blocked for launch.
- if the runtime capability change is merged without the UI branch, existing Codex native behavior remains unchanged except for the explicit runtime status payload and `xhigh` exact argv support already covered by tests.

Recommended final manual smoke:

```bash
CLAUDE_DEV_RUNTIME_ROOT=/Users/belief/dev/projects/claude/agent_teams_orchestrator_codex_native_spike pnpm dev
```

Then verify:

- Provider Settings Codex model list is populated from app-server catalog.
- `gpt-5.1-codex-mini` shows only `medium | high`.
- `gpt-5.4` shows `low | medium | high | xhigh`.
- Anthropic does not show `minimal`, `none`, or `xhigh`.
- A synthetic or newly released Codex model is not silently hidden by static UI code.
- Launch logs include selected model, resolved launch model, selected effort, resolved effort, catalog source, and runtime capability truth.
