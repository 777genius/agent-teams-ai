# Claude Multimodel Integration Plan

## Summary

`claude_team` will integrate with a single CLI runtime: `claude-multimodel`.

Inside that runtime, the app will track multiple provider states independently:

- `anthropic`
- `codex`

The dashboard will show one grouped status banner for the runtime and its providers.
That grouped banner should replace the current single-runtime dashboard banner, not sit beside a second provider banner.

Provider and model selection will happen at process launch time, not in the banner.

This avoids duplicating auth logic in `claude_team` and keeps `claude-multimodel` responsible
for provider login, token storage, and provider capability reporting.

## Core Decisions

### 1. Runtime model

There is one runtime:

- `claude-multimodel`

There are not multiple runtime binaries for this feature.
`Anthropic` and `Codex` are providers inside the same runtime.

Important consequence:

- there is no separate `Codex` binary to install
- there is no separate `Codex` version to display
- there is no separate `Codex` updater flow

### 2. Provider model

Provider status must be tracked independently.

Supported initial providers:

- `anthropic`
- `codex`

The user may be authenticated with both at the same time.
The UI must show both statuses independently without trying to choose a global active provider.

This provider model must also remain compatible with future providers that expose
multiple internal backend paths under one public provider id.

Example:

- public provider: `gemini`
- internal runtime backend: `api` or `cli`

In that scenario, `claude_team` should still treat `gemini` as one provider row.
Backend choice is diagnostic/runtime metadata inside the provider, not a second provider id.

Provider support must be treated per execution mode, not just globally.
At minimum, the integration needs to distinguish:

- interactive team launch / resume
- scheduled one-shot execution

Internal naming rule:

- app-level provider id: `codex`
- runtime/provider label in UI: `Codex`
- this maps to the OpenAI/Codex path inside `claude-multimodel`
- during migration, runtime-internal naming may still use `openai`; the bridge layer must normalize that to app-level `codex`

Backward-compatibility rule:

- existing persisted launches/schedules/teams that do not yet have `providerId` must default safely to `anthropic`
- missing `providerId` in old metadata must never block resume, launch, or schedule execution

### 3. Launch-time selection

Banner state is informational only.

Provider selection happens when launching a task/team/process:

- selected provider
- selected model

Future extension:

- per-teammate provider
- per-teammate model

Defaulting rule:

- for backward compatibility, flows with no explicit provider should default to `anthropic`
- provider defaulting must be explicit in code and persistence, not inferred from whichever UI tab/control happened to be last open
- model defaults must be provider-aware rather than using a single global default such as `opus`
- if a provider later adds internal backend selection, backend resolution must not silently change the app-level `providerId`

## Goals

- Show runtime status for `claude-multimodel`
- Show separate provider status for `Anthropic` and `Codex`
- Support login/logout/status checks through the runtime CLI
- Reuse the existing binary resolver and terminal-based login modal flow where possible
- Avoid reading runtime token/config internals directly from `claude_team`
- Keep current team launch flow extensible for provider/model selection

## Non-Goals

- No separate `Codex` installer
- No fake `Codex` download flow in the UI
- No separate `Codex` runtime version
- No full runtime abstraction layer right now
- No per-teammate model/provider implementation in this phase

## Architecture

### Runtime ownership

`claude-multimodel` owns:

- provider auth flows
- provider token storage
- provider auth verification
- provider model availability reporting

`claude_team` owns:

- UI rendering
- caching and refreshing status
- launch-time provider/model selection
- mapping runtime status into app-friendly DTOs
- reusing shared CLI probing helpers instead of duplicating binary/version logic
- ensuring per-process provider env/args are isolated and do not leak across parallel launches
- validating provider support for the concrete execution mode before spawn

### Service boundary in `claude_team`

Add a new main-process service:

- `src/main/services/runtime/ClaudeMultimodelBridgeService.ts`

Responsibilities:

- resolve runtime binary path
- get runtime version
- get provider auth status
- get provider model lists
- aggregate banner DTO
- trigger provider login/logout commands

This service should be separate from `CliInstallerService`.
Installer/update concerns and provider/auth concerns are different responsibilities.

However, the implementation should reuse existing low-level pieces where possible:

- `ClaudeBinaryResolver`
- existing terminal modal login pattern
- existing CLI version probing helpers, if they are extracted into a shared utility

But existing Claude-specific auth/model logic must not be reused as-is for provider rows:

- current installer auth probing is Anthropic-oriented
- current model parsing and display utilities are Claude-oriented
- provider rows must be driven by runtime provider data, not inferred from Claude-only helpers

The service should also enforce bounded status-check behavior:

- use timeouts for each runtime CLI command
- keep partial results if one command fails
- cache recent successful results briefly to avoid noisy repeated probes

## Required CLI Contract in `claude-multimodel`

The runtime should expose machine-readable commands.

### 1. Runtime version

Already available:

```bash
claude-multimodel --version
```

Used for:

- runtime version display in banner header

Version display rule:

- the app should normalize dev/build suffixes before rendering the banner header
- example:
  - raw: `2.1.87-dev.20260401.t145625.sha38c09970 (Claude Code)`
  - shown: `Claude 2.1.87`

### 2. Provider auth status

Add:

```bash
claude-multimodel auth status --json --provider all
```

Contract requirements:

- non-interactive only
- must never open a browser or prompt for user input
- must be side-effect free:
  - no provider switching
  - no token mutation unless the runtime explicitly performs a safe read-only refresh internally
- should return partial provider results when possible instead of failing the entire command on one provider-specific check

Example response:

```json
{
  "schemaVersion": 1,
  "providers": {
    "anthropic": {
      "supported": true,
      "authenticated": true,
      "authMethod": "oauth",
      "verificationState": "verified",
      "canLoginFromUi": true,
      "capabilities": {
        "teamLaunch": true,
        "oneShot": true
      }
    },
    "codex": {
      "supported": true,
      "authenticated": false,
      "authMethod": null,
      "verificationState": "verified",
      "canLoginFromUi": true,
      "capabilities": {
        "teamLaunch": true,
        "oneShot": true
      }
    }
  }
}
```

Notes:

- no global `active` provider state belongs in this contract
- provider choice happens per launch request, not in global status
- `authenticated` means the runtime considers usable credentials/session state present for that provider
- `verificationState` must distinguish `verified` from `unknown` / `offline` / `error`
- `supported` means the current runtime build knows how to use that provider
- `capabilities` means the current runtime build knows which execution modes can use that provider

### 3. Provider model lists

Add:

```bash
claude-multimodel model list --json --provider all
```

Example response:

```json
{
  "schemaVersion": 1,
  "providers": {
    "anthropic": {
      "models": ["opus", "sonnet", "haiku"]
    },
    "codex": {
      "models": ["gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini"]
    }
  }
}
```

This is intentionally separate from auth status so auth and capability failures can be handled independently.

Model listing should be available even when the provider is not currently authenticated, whenever the runtime can determine the model set statically.

### 4. Provider login

Add:

```bash
claude-multimodel auth login --provider anthropic
claude-multimodel auth login --provider codex
```

```bash
claude-multimodel auth logout --provider anthropic
claude-multimodel auth logout --provider codex
```

This allows `claude_team` to reuse runtime-managed login flows instead of implementing OAuth directly.

## Status Model in `claude_team`

Recommended DTO:

```ts
type ProviderId = 'anthropic' | 'codex';

interface ProviderStatus {
  providerId: ProviderId;
  displayName: string;
  supported: boolean;
  authenticated: boolean;
  authMethod: 'oauth' | 'api_key' | 'external' | 'unknown' | null;
  verificationState: 'verified' | 'unknown' | 'offline' | 'error';
  statusMessage?: string | null;
  models: string[];
  canLoginFromUi: boolean;
  capabilities: {
    teamLaunch: boolean;
    oneShot: boolean;
  };
  backend?: {
    kind: string;
    label: string;
    endpointLabel?: string | null;
    projectId?: string | null;
    authMethodDetail?: string | null;
  } | null;
}

interface ClaudeMultimodelDashboardStatus {
  runtime: {
    id: 'claude-multimodel';
    installed: boolean;
    version: string | null;
  };
  providers: ProviderStatus[];
}
```

## Dashboard Banner

One grouped banner should be shown.
It should replace the current dashboard runtime banner, not add a second top-level banner.

### Header

- runtime name/version, for example: `Claude 2.1.87`
- runtime auth-independent actions like `Extensions`

For `claude-multimodel` mode:

- keep the runtime version in the header
- hide runtime self-update UI
- hide binary path UI

### Provider rows

One row per provider:

- `Anthropic`
- `Codex`

Each row may show:

- authenticated state
- auth method
- verification state when status is uncertain
- model list if available
- backend diagnostics when the provider has internal backend resolution
- actions:
  - `Login` when unauthenticated
  - `Logout` when authenticated
  - `Re-check` always

### Important UI rules

- Do not show a fake `Codex version`
- Do not show a separate `Codex installer`
- Do not show a fake `Download Codex` action
- Do not force a global provider choice from the banner
- If a provider has multiple internal backends, show them as provider diagnostics, not as separate provider rows
- Partial success must be visible:
  - Anthropic ok, Codex missing
  - Codex ok, Anthropic missing

## Launch Flow Changes

Current launch flow already supports a team-level `model`.
Current UI also already has a provider affordance in [TeamModelSelector.tsx](../../src/renderer/components/team/dialogs/TeamModelSelector.tsx), but its logic is still placeholder/coming-soon. That placeholder currently uses `openai`; it should be normalized or mapped to the app-level provider id `codex` during implementation.

Current code paths that must be kept in sync:

- shared types in [team.ts](../../src/shared/types/team.ts)
- HTTP launch parsing in [teams.ts](../../src/main/http/teams.ts)
- IPC launch/create validation in [teams.ts](../../src/main/ipc/teams.ts)
- persisted draft metadata in [TeamMetaStore.ts](../../src/main/services/team/TeamMetaStore.ts)
- scheduled one-shot config in [schedule.ts](../../src/shared/types/schedule.ts)
- scheduled execution in [ScheduledTaskExecutor.ts](../../src/main/services/schedule/ScheduledTaskExecutor.ts)
- provider/model UI helpers in [TeamModelSelector.tsx](../../src/renderer/components/team/dialogs/TeamModelSelector.tsx)
- model display parsing in [modelParser.ts](../../src/shared/utils/modelParser.ts)
- launch dialog state persistence in [LaunchTeamDialog.tsx](../../src/renderer/components/team/dialogs/LaunchTeamDialog.tsx)
- create dialog state persistence in [CreateTeamDialog.tsx](../../src/renderer/components/team/dialogs/CreateTeamDialog.tsx)
- saved draft restore in [teams.ts](../../src/main/ipc/teams.ts)
- launch param persistence in the renderer store
- slash-command metadata in [slashCommands.ts](../../src/shared/utils/slashCommands.ts)

Next step is to extend launch requests to include provider selection:

```ts
interface TeamLaunchRequest {
  providerId?: 'anthropic' | 'codex';
  model?: string;
}
```

Future-compatible extension for providers with internal backend preference:

```ts
interface TeamLaunchRequest {
  providerId?: 'anthropic' | 'codex' | 'gemini';
  model?: string;
  providerOptions?: {
    geminiBackendPreference?: 'auto' | 'api' | 'cli';
  };
}
```

Provider selection must be applied only to the spawned child process environment/args.
It must not mutate a global app-wide runtime provider state.

This launch-time provider/model selection must be honored consistently across all spawn paths:

- manual team launch
- draft team launch that redirects into `createTeam`
- scheduled/background execution
- resume/retry/restart flows
- any other non-interactive process launch path that currently inherits team/model settings

Implementation rule:

- provider choice must be expressed via child-process-scoped args/env only
- conflicting provider env vars must be cleared for that child process
- one run using `codex` must not affect another run using `anthropic`

Future-compatible shape:

```ts
interface TeamLaunchRequest {
  providerId?: 'anthropic' | 'codex';
  model?: string;
  memberProviders?: Record<string, 'anthropic' | 'codex'>;
  memberModels?: Record<string, string>;
}
```

This allows future per-teammate routing without redesigning the API again.

Launch-time preflight validation should fail fast before spawning the child process when possible:

- selected provider is unsupported by the current runtime build
- selected provider is clearly unauthenticated
- selected model is clearly incompatible with the selected provider

These checks should produce actionable errors for the user, while still treating cached banner model lists as advisory rather than authoritative.

The same provider/model fields must also be added to the data that currently persists launch intent:

- `TeamLaunchRequest`
- `TeamCreateRequest` for draft-team fallback
- `TeamMetaFile` in `team.meta.json`
- `ScheduleLaunchConfig`

Migration rule:

- when old persisted data has no `providerId`, treat it as `anthropic`
- new writes should persist `providerId` explicitly

UI persistence rule:

- provider selection must be persisted independently from model selection
- remembered model state must be namespaced by provider, or reset safely on provider switch
- a previously remembered Anthropic model must not be auto-applied to Codex, and vice versa

Launch source-of-truth rule:

- explicit values from the current launch request win
- persisted metadata is fallback only
- banner/provider status is informational and must never silently override a launch request
- provider-internal backend resolution may inform diagnostics, but it must not overwrite explicit launch-time provider options

Runtime observation rule:

- launch-time `providerId` / `model` are the requested starting configuration
- observed runtime message metadata may later reflect a different actual model after in-session commands such as `/model`
- the app must not conflate "requested at launch" with "currently observed in session"

## Edge Cases

### Provider auth combinations

Must support all of these without breaking the banner:

- Anthropic authenticated, Codex unauthenticated
- Codex authenticated, Anthropic unauthenticated
- both authenticated
- neither authenticated

All of these must remain first-class supported states in the banner.

The same rule extends to future providers with internal backends:

- one provider row may be authenticated while one backend path is degraded
- the banner should show provider-level health plus backend diagnostics without splitting into two pseudo-providers

### Provider supported, but not for this execution mode

A provider may be authenticated and generally supported, but still unavailable for a specific path:

- available for one-shot scheduler runs, but not Agent Teams
- available for Agent Teams, but not one-shot

The banner and preflight validation must not flatten these into a single boolean.
Capability checks must use the concrete execution mode being launched.

For providers with internal backends, capability checks may also depend on the resolved backend:

- provider supported, backend `api` unsupported for this path
- provider supported, backend `cli` supported for this path

That still remains one provider decision surface in `claude_team`.

### Runtime ok, provider verify uncertain

If network verification fails:

- do not downgrade directly to `authenticated = false`
- prefer `verificationState = unknown` or `offline`

### No global active provider

Because provider choice happens per launch:

- the status contract must not imply one provider is globally selected
- a user can keep both `Anthropic` and `Codex` signed in simultaneously
- the banner is informational, not a provider selector

### Provider selection must not leak between runs

If one team/process launches with `codex` and another launches with `anthropic`:

- this must not mutate the banner into a single globally active provider state
- launch-specific provider state should stay attached to the launched process/team metadata
- dashboard status should continue to reflect provider availability/auth only
- child process env must explicitly clear incompatible provider-selection variables before spawn

### Managed flags vs custom CLI args

`claude_team` already supports raw `extraCliArgs` / custom CLI args.

Those args must not be allowed to silently override app-managed launch intent such as:

- provider selection
- model selection
- permission mode defaults owned by the app
- any future provider-routing flags/env

The implementation should either:

- reject conflicting custom args with a validation error, or
- define a strict precedence rule where app-managed provider/model flags always win

but it must not allow ambiguous mixed configuration.

### Provider-specific model normalization

Current UI and launch code contain Claude-specific model assumptions, including:

- `limitContext`
- automatic `[1m]` suffixing
- defaulting to Claude-family model ids such as `opus[1m]`

These rules must become provider-aware:

- Anthropic may keep Claude-specific context/model normalization
- Codex must not inherit Claude-only suffix rules
- switching provider must not silently rewrite a selected model into an invalid format for that provider

### Provider-specific selector state

Current selector state is Anthropic-biased:

- provider UI is currently hardcoded to Anthropic
- model options are static Anthropic options
- launch/create dialogs remember one global last-selected model

The implementation must make selector state provider-aware:

- provider list must come from supported runtime providers, with unsupported placeholders still disabled
- model options must come from the selected provider, not a shared static list
- switching provider must either preserve a valid provider-local previous choice or clear to that provider's default
- the UI must not display a stale Anthropic label/model when `codex` is selected

### Resume and restart semantics

If a team/run is resumed, retried, or restarted later:

- the persisted launch-time `providerId` and `model` must remain the default for that resumed run
- changing banner status or current UI defaults must not silently rewrite old run configuration
- explicit user overrides during a new launch are allowed, but implicit fallback to a different provider is not

The same rule applies to edited schedules and stored drafts:

- opening an old schedule/draft in a newer UI must not silently rewrite provider/model until the user explicitly saves changes

If a running session changes model interactively after launch:

- launch metadata should remain the historical requested starting state
- observed session model should come from runtime output/log parsing
- resume should continue from the actual session state instead of blindly reimposing old defaults unless the user explicitly requests a fresh launch

### Draft-team launch fallback

`claude_team` can redirect a launch request into `createTeam` when only `team.meta.json` exists.

That fallback must preserve the same provider/model intent:

- `providerId` must survive the launch -> create redirect
- draft metadata must not drop provider selection
- create-time validation must match launch-time validation

### Models unavailable

If model listing fails but auth status succeeds:

- keep provider visible
- show auth state
- omit or gray out model list

If model listing succeeds for an unauthenticated provider:

- still show the model list
- do not block model visibility on login state

### Provider-specific model display parsing

Current shared model display utilities are Claude-oriented.

The integration must not assume:

- every model id starts with `claude-`
- every provider model can be parsed into Claude family/version semantics

For non-Claude providers, the UI should fall back to generic provider/model labels unless a provider-specific parser is added intentionally.

This also applies to in-session command output:

- `/model` command output or equivalent runtime messages may describe state transitions differently per provider
- the UI should not assume Anthropic-specific phrasing when interpreting provider/model changes

If model lists differ by execution mode in a future runtime build:

- the contract should evolve via `schemaVersion`
- old app versions should continue to degrade safely instead of assuming one global model set

If model lists are temporarily unavailable for the selected provider in the launch dialog:

- the UI should still allow safe fallback behavior for backward-compatible Anthropic flows
- Codex flows should avoid inventing a default model id that did not come from the runtime or explicit user choice

### Model list is advisory, not launch authority

Provider model lists in the banner are helpful capability hints only:

- the actual launch path must still validate provider/model compatibility at spawn time
- cached model lists must not be treated as proof that a launch will succeed
- auth changes, subscription changes, or runtime updates may change model availability between refresh and launch

### Older runtime build

If the runtime does not yet support the new JSON commands:

- show runtime status normally
- show provider section as unavailable
- include a message like `Provider status not supported by current claude-multimodel build`

### Login/logout refresh behavior

After a login or logout flow in the terminal modal:

- the app must invalidate cached provider status
- the banner must refresh automatically
- a canceled login must not be treated as auth failure

Refresh handling must also be race-safe:

- older async refresh results must not overwrite newer ones
- concurrent login/logout/re-check actions must not leave the banner in a stale mixed state
- provider rows should expose a temporary loading/pending state while a provider-specific action is in flight

### Running teams during auth changes

If the user logs in, logs out, or changes provider credentials while teams are already running:

- the banner should refresh to reflect the new provider status
- already-running teams must not be implicitly reconfigured by the dashboard refresh itself
- launch-time provider/model metadata for existing runs should remain attached to those runs

Provider status changes should also avoid leaking sensitive details into UI logs:

- no token values
- no raw OAuth payloads
- only high-level auth method / verification state / actionable error text

### Runtime missing

If `claude-multimodel` is missing or not executable:

- show runtime-level failure in the banner header
- provider rows should be disabled or shown as unavailable
- do not render stale provider state as if it were fresh

### Slow or hanging status commands

If one or more runtime CLI status commands are slow or hang:

- the dashboard must not block indefinitely
- show the last good known state when available
- mark uncertain sections as stale/unknown instead of replacing them with false negatives

### Mixed command support during rollout

During migration, some runtime builds may support:

- version probing
- auth status JSON
- but not model list JSON

The app should degrade gracefully per capability instead of requiring all commands to work at once.

### Provider-specific status degradation

If one provider status check succeeds and another degrades:

- keep the successful provider row fully usable
- mark only the failing provider row as `unknown` / `error`
- do not collapse the whole banner into a global failure state

## Implementation Phases

### Phase 1. Runtime CLI contract

In `claude-multimodel`:

- add `auth status --json --provider all`
- add `model list --json --provider all`
- add `auth login --provider anthropic|codex`
- add `auth logout --provider anthropic|codex`

### Phase 2. Bridge service in `claude_team`

Add:

- `src/main/services/runtime/ClaudeMultimodelBridgeService.ts`

Implement:

- `getRuntimeVersion()`
- `getProviderAuthStatus()`
- `getProviderModels()`
- `getDashboardStatus()`
- `login(providerId)`
- `logout(providerId)`

The service should aggregate the banner DTO from multiple runtime CLI calls while keeping partial results usable.

### Phase 3. Banner integration

Refactor the dashboard CLI banner into a grouped runtime/provider banner:

- runtime header
- Anthropic provider row
- Codex provider row

This phase should also explicitly hide runtime path/update controls for `claude-multimodel` mode.

### Phase 4. Launch integration

Extend launch/create dialogs and IPC payloads:

- add `providerId`
- wire provider choice into spawned CLI args/env
- reuse the existing provider affordance in `TeamModelSelector` instead of creating a second provider selector

This phase must explicitly define the child-process env mapping for provider selection, including clearing conflicting provider flags.
It must also persist launch-time `providerId` alongside `model` in team/run metadata so existing runs remain inspectable after refresh.
It must update both the interactive team runtime path and the scheduler one-shot path.

Phase 4 should also explicitly hide or keep disabled unsupported placeholder providers in `TeamModelSelector` until their runtime support actually exists. In Phase 1/2/3, only `Anthropic` and `Codex` should move out of placeholder behavior.

### Phase 5. Future teammate-level routing

Later extension:

- `memberProviders`
- `memberModels`

This phase should happen only after team-level provider/model selection is stable.
It will likely require both `claude_team` changes and runtime support in `claude-multimodel` for teammate-level routing.

## Why This Plan

This plan keeps the ownership boundary clean:

- `claude-multimodel` remains the source of truth for auth and provider capabilities
- `claude_team` remains a UI/orchestration layer

It also avoids the two bad extremes:

- no duplicated OAuth/token logic in `claude_team`
- no premature heavy runtime abstraction layer

This is the smallest architecture that is still robust enough for:

- multi-provider status
- launch-time provider selection
- future per-agent provider/model routing
- shared runtime ownership without duplicating auth logic in `claude_team`
