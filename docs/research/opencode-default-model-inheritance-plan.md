# OpenCode Default Model Inheritance UX Implementation Plan

Status: implemented and verified on 2026-08-20
Primary issue: `777genius/agent-teams-ai#446`
Target outcome: any usable live OpenCode route, including `openrouter/openrouter/free`, can be selected as the inherited OpenCode default without exposing configuration-scope mechanics to the user.

## Summary

Replace the current `All projects / This project` scope switch and limited configured-model list with an explicit inheritance view:

1. A base `Default model` row used by projects without an override.
2. A contextual project row that either inherits the base default or shows its own override.
3. One provider-faceted model picker that can select live routes from connected/configured providers.
4. An explicit `Use default` action that removes a project override instead of copying the current base model into project state.
5. A resolved `Default - <model>` presentation in Create Team, while preserving explicit per-team model choices as a separate concept.

The implementation must also remove the hidden provider-row side effect that currently stores a model for future Create Team dialogs.

Estimated implementation size, including focused tests and transport wiring: **900-1,500 changed lines across the desktop and runtime repositories**.

### Lean implementation decision

Do not build a second model-browsing surface. The existing Providers tab already owns lazy provider loading, model search, filters, pagination, virtualization, access state, and execution results. Reuse it as the model picker:

- `Change` on an inheritance row records the destination and opens the Providers tab.
- A compact banner says which default is being changed and provides `Cancel`.
- Model rows expose an explicit `Test and use` action for that destination.
- Outside an active change flow, model rows expose only `Test`. Default changes always start from the inheritance card, so the destination never has to be chosen twice.

This keeps the inherited UX while avoiding duplicate catalog state, duplicate model-list components, and three new modal state machines.

## Current understanding

### Confirmed root causes

- The live OpenRouter connection exposes 352 models and includes:
  - display route: `openrouter/free`
  - full OpenCode model id: `openrouter/openrouter/free`
- The provider catalog renders this route, but its row only exposes `Test`.
- Clicking the whole provider-model row silently calls `useModelForNewTeams()` and writes a Create Team preference. It does not change the OpenCode default.
- The Models tab renders only `view.configuredModels`. The runtime intentionally limits that collection to configured-local, built-in-free, and current-default routes, so a normal connected-provider route is missing until it is already the default.
- The runtime `setDefaultModel` use case already accepts any usable model found in the live provider catalog, probes it, and persists either a project or all-projects preference.
- The view already contains the inheritance data needed by the renderer:
  - `projectDefaultModel`
  - `allProjectsDefaultModel`
  - `defaultModelSource`
  - effective `defaultModel`
- There is no command or contract for removing a project override. Copying the base model into project preferences would look correct initially but would break inheritance when the base default changes later.
- All-projects mutation currently uses the selected project as its probe context. Project configuration can therefore make a global route appear usable or unusable for the wrong reason.
- Create Team separately persists its last explicit model selection in renderer storage. That preference can legitimately override the OpenCode default, but the current UI does not make the distinction obvious.

### Canonical ownership

- Runtime managed preferences are the source of truth for base and project defaults.
- `RuntimeProviderManagementViewDto` is the renderer read model for effective inheritance.
- Create Team renderer storage remains the source of truth only for the last explicit Create Team selection.
- Provider catalog state is discovery data. It must not mutate Create Team preferences from a row click.

### Effective selection rule

For an OpenCode team launch:

```text
explicit team model
  ?? project OpenCode override
  ?? base OpenCode default
  ?? existing OpenCode fallback
```

The renderer must explain this precedence without exposing internal terms such as `scope` or `validation context`.

## Fixed product decisions

### User-facing vocabulary

- Do not show `All projects` as a standalone scope label. It is inaccurate when project overrides exist.
- Use `Default model` with helper text: `Used by projects that do not have their own model.`
- Use `This project: <name>` for the contextual row.
- When inherited, show `Uses default model: <resolved model>` and action `Use another model`.
- When overridden, show the override and actions `Change` and `Use default`.
- Do not show `Validation context` in the normal UI.

### Mutation behavior

- `Change` on the base row opens the picker with the destination fixed to the base default.
- `Use another model` or `Change` on the project row opens the picker with the destination fixed to that project.
- The user is not asked to choose scope again inside the picker.
- A provider-catalog model row does not expose scope-specific writes without an active inheritance-card destination.
- Selecting a model is non-mutating. The only write action is `Test and use`.
- `Test and use` uses the runtime's atomic probe-before-write operation. Do not run a separate probe followed by an unrelated save.
- A failed, cancelled, timed-out, or stale operation leaves the stored default unchanged.
- `Use default` removes the project override. It must never write a snapshot of the current base model into the project preference.

### Free Models Router presentation

For `openrouter/openrouter/free`, show:

- `Free Models Router`
- `OpenRouter`, `Free`, and connection/verification badges
- advisory text: `Chooses an available free model for each request. The underlying model may change.`

Do not use the generic `Not recommended` label as the only explanation. The route remains selectable; the advisory describes the real trade-off.

### Create Team behavior

- Preserve the existing last-selection persistence behavior in this slice.
- Make the state visible:
  - inherited option: `Default - Free Models Router` or a resolved fallback label
  - explicit option/summary: `Explicit choice - <model>`
- Changing OpenCode defaults must not silently overwrite an intentional explicit Create Team choice.
- Provider Settings must no longer change the Create Team choice except through an explicitly worded onboarding action that already owns that behavior.

## Non-goals

- Do not launch teams, agents, terminals, tasks, or provisioning flows during verification.
- Do not redesign provider authentication or onboarding.
- Do not change the recommendation matrix for unrelated models.
- Do not add a general cross-provider search backend. The picker may remain provider-faceted and use the existing lazy provider-model API.
- Do not add global-default clearing unless a concrete UI requirement appears. This plan only needs project override clearing.
- Do not rewrite the existing Create Team persistence model.
- Do not broaden browser-mode support for runtime provider mutations; maintain the existing explicit unsupported response.
- Do not opportunistically refactor unrelated oversized legacy files.

## Architecture and minimum edit set

### Runtime repository: clear project override

Repository: the sibling `agent_teams_orchestrator` runtime repository

Add a narrow `clear project default` vertical slice:

1. Add `ClearProjectDefaultModelInput` to the runtime provider-management domain.
2. Add `clearProjectDefaultModel()` to `ProviderManagementCommandPort`.
3. Add the application delegator next to `setProviderDefaultModel`.
4. Extend managed preferences with an explicit atomic clear function that:
   - preserves model-limit overrides;
   - writes `defaultModelId: null`;
   - updates `updatedAt`;
   - uses the existing per-file queue and lock.
5. Extend `OpenCodeProviderManagementAdapter` with `clearProjectDefaultModel()`:
   - require a real project path/profile;
   - perform no model execution probe;
   - clear only the project managed preference;
   - invalidate directory/inventory caches;
   - refresh the inventory and return a view resolving to the base default/fallback.
6. Add `runtime providers clear-project-default` to both CLI entry paths:
   - source launcher argument parser;
   - Commander registration;
   - JSON response shape identical to other view mutations.
7. Do not overload `set-default` with empty model ids or magic sentinel values.

### Desktop contracts and transport

Repository: this desktop repository (`agent-teams-ai`)

1. Add `RuntimeProviderManagementClearProjectDefaultInput`.
2. Add `clearProjectDefaultModel()` to `RuntimeProviderManagementApi`.
3. Add a dedicated IPC channel and preload bridge method.
4. Validate:
   - runtime is `opencode`;
   - project path is a non-empty bounded string;
   - no provider/model id is accepted because clearing is not model-specific.
5. Delegate through the feature facade and port.
6. Add the browser adapter's explicit `unsupported-action` response.
7. Extend `AgentTeamsRuntimeProviderManagementCliClient` to invoke `clear-project-default`, invalidate model/view caches before and after mutation, and preserve structured diagnostics.
8. Detect scoped-default support from the additive response fields. Until the bundled runtime exposes them, fail closed to the legacy configured-model UI and never call the new scoped mutation or clear command.

### Neutral base-default validation

Implement neutral probing in the desktop main-process CLI client, not in renderer state:

1. For `scope: all_projects`, ensure one stable app-owned directory under the desktop app-data root.
2. Reuse that directory as both CLI cwd and `--project-path` for every base-default command.
3. Continue using the same runtime binary, managed data root, and provider authentication.
4. Keep the directory across success and failure so the neutral project identity is deterministic and cannot create duplicate managed profiles.
5. If directory creation fails, fail before running the mutation.
6. Project-scoped mutations continue using the selected project path.
7. Do not repurpose `HOME` or other broad environment variables.

The stable directory is infrastructure state, not a user project. Do not copy user project files or
credentials into it. Runtime-created context files stay isolated under the app-owned path and may be
removed only by a dedicated reset/uninstall operation when no provider command is running, never as
per-operation cleanup.

The global mutation response represents the neutral directory, so the renderer must not replace its current project view wholesale with that response.

### Renderer view model

Add a small pure presentation module under `renderer/view-models/` or `renderer/utils/` that derives:

```ts
type OpenCodeDefaultModelPresentation = {
  baseModelId: string | null;
  baseDisplayName: string;
  projectPath: string | null;
  projectName: string | null;
  projectOverrideModelId: string | null;
  projectEffectiveModelId: string | null;
  projectInherits: boolean;
  effectiveSource: RuntimeProviderDefaultModelSourceDto | null;
};
```

Rules:

- Base row uses `allProjectsDefaultModel`, then the existing OpenCode config/fallback only for readout when no managed base exists.
- Project override exists only when `projectDefaultModel` is non-null.
- Project effective model is `projectDefaultModel ?? allProjectsDefaultModel ?? defaultModel`.
- A project override remains visibly effective when the base default changes.
- Unknown/stale model ids remain visible as raw ids with an `Unavailable` advisory; they are not silently dropped.

Add pure mutation projection helpers so a persisted write can update scoped state even if the post-write refresh fails:

- set base default while preserving a project override;
- set project override;
- clear project override and resolve the inherited model.

### Renderer hook behavior

Extend `useRuntimeProviderManagement` with:

- a picker target: `base` or `project` plus the bound project snapshot;
- `clearProjectDefaultModel()` action;
- separate busy state for clearing the project override;
- scoped optimistic/read-model projection after successful persistence;
- a follow-up refresh for the currently active project.

Concurrency rules:

- Project mutations are bound to the project generation captured at start. A response for project A must never update project B.
- Base mutation is independent of the selected project. If the project changes while it runs, apply the base result and refresh the latest active project.
- Closing the picker cancels only picker-owned model probes and ignores late results.
- Only one default mutation may be active at a time.
- A saved mutation followed by refresh failure produces a warning, not a failure claim.
- Busy state must clear even if project context changes during a base mutation.

### Renderer UI extraction

The existing production files are frozen above the source-size limit:

- `RuntimeProviderManagementPanelView.tsx`: 3309 lines
- `useRuntimeProviderManagement.ts`: 2118 lines
- `TeamModelSelector.tsx`: 3881 lines
- `CreateTeamDialog.tsx`: 3160 lines

Do not grow them materially. Extract cohesive units and reduce their line counts where practical.

Planned new units:

- `OpenCodeDefaultModelInheritanceCard.tsx`
  - base row;
  - current-project inheritance/override row;
  - project chooser only when there is no active project or the user explicitly changes context;
  - direct, reversible `Use default` action for removing an override.
- `openCodeDefaultModelPresentation.ts`
  - pure read-model projection and mutation merge rules.

The existing provider/model catalog remains the picker. Add only:

- a target banner above the catalog while a default change is active;
- explicit row actions for base/project default selection;
- route-specific advisory content.

Reuse existing Radix-backed Dialog, AlertDialog, Select, Checkbox, Tabs, and Tooltip primitives. Do not add native `title` tooltips or hand-rolled modal controls.

### Provider model catalog

1. Make model rows non-mutating containers; remove `role=button`, `aria-pressed`, whole-row click, and keyboard save behavior.
2. Keep `Test` as an explicit action.
3. Show `Test and use` only while the inheritance card has bound the picker to a destination.
4. Do not require a project merely to set the base default; the main process supplies a neutral probe directory.
5. Require an actual project only for a project override.
6. Remove `Save for team picker` from the defaults/models management surface. Model choice for a team belongs in Create Team.
7. Keep onboarding's explicit verified-model acceptance behavior, but ensure its label states that it affects new teams.

### Models tab

Replace `OpenCodeModelScopeControls` and `ConfiguredOpenCodeModelsPanel` as the primary default-editing UI with `OpenCodeDefaultModelInheritanceCard`.

The existing configured-routes list may remain below as an advanced diagnostics/limits section only if local model-limit controls still need it. It must not be the default picker and must not contain `Save for team picker` or duplicate default actions.

### Create Team

1. Resolve the effective OpenCode default from the project-scoped runtime catalog already loaded by Create Team.
2. Show the resolved model directly in the default option label.
3. Show an explicit-selection indicator when a non-empty model value is active.
4. Keep empty string as the launch contract for `use runtime default`.
5. Preserve legacy stored values, including `__default__` normalization.
6. If the saved explicit model is stale or unavailable, retain the existing fail-safe behavior and explain why it cannot be selected; do not silently reinterpret it as default before the catalog is authoritative.

### Localization

- Reuse existing keys where their meaning remains accurate.
- Add the minimum new keys for inheritance, clear override, picker destination, explicit choice, and Free Models Router advisory.
- Because catalog validation enforces source-locale key parity, add every new key to every configured locale or use an established generic key that already exists.
- Regenerate `resources.d.ts` with the project's i18n type command.
- Run catalog validation after changes.

## Detailed implementation phases

# Phase 0 - Preflight and ownership

## Steps

1. Confirm the desktop and runtime repository checkouts and their ownership boundaries.
2. Confirm the owned edit set in each repository before implementation.
3. Create or switch to a correctly named feature branch only when implementation starts, following each repository's branch rules.
4. Confirm the desktop dev runtime points to the runtime repository's `cli-source` launcher for source verification.
5. Re-run the read-only `dev:mcp` reproduction to capture the before state if a fresh comparison is useful.

## Exit criteria

- Owned edit set is explicit.
- Files outside the owned edit set will not be reverted, staged, or reformatted.

# Phase 1 - Runtime inheritance contract

## Steps

1. Implement atomic project preference clearing.
2. Add runtime domain/port/application method.
3. Add adapter behavior and view refresh.
4. Add both CLI entry paths.
5. Add focused runtime tests.

## Exit criteria

- Clearing a project override returns a view inherited from the base default.
- Model limits and global preferences are unchanged.
- No model probe is executed for clear.

# Phase 2 - Desktop transport and neutral validation

## Steps

1. Add desktop contracts, IPC channel, bridge, facade, port, browser stub, and CLI client method.
2. Add a stable app-owned neutral project context for base-default set.
3. Add defensive validation and cache invalidation.
4. Add focused main-process tests.

## Exit criteria

- Base set never uses the active user project as cwd/probe context.
- Project set and clear remain bound to the chosen project.
- The same neutral context is reused after success and failure and remains outside user projects.

# Phase 3 - Pure renderer model and hook orchestration

## Steps

1. Add inheritance presentation projector.
2. Add scoped mutation projection helpers.
3. Extend hook state/actions for picker target and clear.
4. Separate global-vs-project stale response rules.
5. Preserve saved-but-refresh-failed warnings.
6. Add hook and projector tests before UI replacement.

## Exit criteria

- Renderer state always reports the correct effective model and source.
- Changing base does not visually replace a project override.
- Clearing override immediately resolves to base/default fallback.

# Phase 4 - Inherited defaults UI and picker

## Steps

1. Extract the new defaults settings component.
2. Reuse the existing Providers tab and provider model list as the picker with a fixed-target banner.
3. Add one explicit `Test and use` provider-model action for the destination already selected in the inheritance card.
4. Remove hidden model-row writes and defaults-screen team-picker actions.
5. Add route-specific Free Models Router advisory.
6. Preserve local-model limits/diagnostics below the new primary UI where needed.
7. Add accessible labels, focus return, keyboard behavior, loading, empty, error, and cancellation states.

## Exit criteria

- `openrouter/openrouter/free` can be selected from the live OpenRouter model list and set as either base or project default.
- No standalone scope toggle or validation-context field remains.
- No model row click writes state.

# Phase 5 - Create Team clarity

## Steps

1. Add a pure resolved-default label helper.
2. Render `Default - <resolved model>` for OpenCode.
3. Render explicit-selection copy for non-empty values.
4. Add focused tests for default, project override, explicit saved model, pending catalog, and stale saved model.

## Exit criteria

- Users can tell whether Create Team will inherit the runtime default or launch an explicit model.
- Existing stored choices remain backward compatible.

# Phase 6 - Verification and E2E

Run focused verification first, then the Electron E2E.

## Static and focused checks

Desktop repository:

```text
pnpm lint:fast:files -- <changed desktop files>
pnpm typecheck
pnpm vitest run <focused runtime-provider and TeamModelSelector tests>
pnpm i18n:validate
pnpm guard:source-file-size
```

Runtime repository:

```text
bun test <focused managed-preferences, adapter, and runtime CLI tests>
bun run typecheck (or the repository's available pinned typecheck command)
```

Do not run broad formatting or `pnpm lint:fix`.

## Deterministic Electron E2E

Use `pnpm dev:mcp` with:

- a temporary `AGENT_TEAMS_ELECTRON_USER_DATA_DIR`;
- a new sandbox project directory;
- a temporary runtime-provider CLI fixture created outside the repository for this run only;
- CDP port 9222;
- no agent/team launch.

Scenario:

1. Open OpenCode Provider Settings -> Models.
2. Verify the base and project inheritance rows are visible.
3. Verify there is no `All projects / This project` segmented switch and no `Validation context` field.
4. Change the base default.
5. In the picker, select OpenRouter and search `openrouter/free`.
6. Verify `Free Models Router`, free/connected badges, and variable-model advisory.
7. Click `Test and use` and verify persisted base readout.
8. Set a different project override and verify it shadows the base.
9. Change the base again and verify the project remains unchanged.
10. Click `Use default` and verify the project inherits the new base.
11. Open Create Team for the sandbox project without launching it.
12. Verify the default option resolves to the inherited model.
13. Pick an explicit model and verify it is labelled as explicit.
14. Close dialogs, restart the isolated app if needed, and verify persisted base/project state.
15. Clean only the E2E-owned processes and temporary directories.

Do not commit a general fake-runtime framework for this issue. Focused tests cover the CLI client contracts; the temporary fixture only supplies deterministic state for the one Electron E2E run.

## Live OpenRouter compatibility smoke

After deterministic E2E passes, run a read-only/live-provider smoke with the already connected OpenRouter account:

1. Create a new sandbox project.
2. Start `dev:mcp` with the source runtime.
3. Open OpenRouter models and locate `openrouter/openrouter/free`.
4. Run `Test` in the sandbox context to confirm the real provider route remains executable.
5. Do not change the user's real base default.
6. Do not launch a team or agent.

This separates UI/transport mutation proof from external provider availability and avoids modifying real global preferences.

## Edge cases

- No project selected: base default remains editable; project row offers a project chooser or explains that a project is required.
- Deleted/missing project: disable project mutation, keep base mutation available.
- Base default missing: show the effective OpenCode fallback and allow creating a managed base.
- Project override model absent from live catalog: keep the raw id visible with an unavailable advisory and allow `Use default`.
- Provider disconnects while picker is open: mutation fails closed, picker keeps selection and shows the runtime error.
- Route becomes unavailable after successful test but before refresh: persisted response is shown with refresh warning; later refresh may mark it unavailable.
- Project switches during project mutation: ignore stale response for the new project.
- Project switches during base mutation: complete the base mutation, refresh the newest project, and clear busy state.
- Picker closes during model search/test: cancel request group and ignore late results.
- Double click on `Test and use`: one mutation only.
- Refresh failure after successful write: show `saved, refresh needed`, never claim the write failed.
- App restart: derive inheritance from runtime preferences, not ephemeral renderer state.
- Legacy `__default__` Create Team value: normalize to inherited empty-string model as today.
- Existing explicit Create Team value: preserve and visibly label it.
- Free Models Router returns a different underlying model between probes: treat the route id as the persisted identity; advisory explains variability.

## Rollback strategy

- Renderer rollback: restore the old scope/configured-model panel while leaving the additive runtime clear command unused.
- Runtime rollback: the clear command is additive; older desktop builds do not call it.
- Contract compatibility: keep existing `setDefaultModel` unchanged. Add a new method/channel/CLI command rather than changing its request shape. A newer desktop paired with an older bundled runtime uses the legacy model UI until a later runtime lock update exposes the additive fields.
- Persistence compatibility: both old and new builds continue reading schema version 2 preferences with nullable `defaultModelId`.
- No migration script is required.

## Verification result

- Desktop typecheck, source-size guard, diff check, and focused lint completed with no errors.
- 284 focused desktop tests passed.
- 115 focused runtime managed-preference and adapter tests passed.
- Deterministic Electron `dev:mcp` covered base change, project override, base/override independence, `Use default`, persistence, Create Team labels, standalone `Test`, and 800x600 layout without launching a team.
- Live source-runtime smoke reported OpenRouter connected, found `openrouter/openrouter/free`, and returned `Model probe passed` in the sandbox project without changing the real default.
- New localization keys exist in every configured locale and generated types compile. The repository-wide localization validator remains red only on its existing unrelated dashboard/team parity backlog.
- The reconstructed runtime repository's broad TypeScript command remains red on its existing missing snapshot modules and unrelated legacy errors; the focused runtime slice tests and live `cli-source` execution passed.

## Acceptance criteria

1. A connected OpenRouter user can find and set `openrouter/openrouter/free` as the base OpenCode default.
2. The same route can be set as a project-only override.
3. The UI shows inheritance directly and contains no standalone scope toggle.
4. Base selection does not require a user-visible validation project.
5. Base probing runs in a stable app-owned neutral directory under the desktop app-data root.
6. Project probing runs in the selected project.
7. `Use default` removes the project override and later base changes flow through automatically.
8. Provider model rows have no hidden persistence behavior.
9. Create Team visibly distinguishes inherited default from explicit selection.
10. Failed probes do not persist defaults.
11. Project/context races cannot apply stale results to another project.
12. Focused tests, desktop typecheck, source-size guard, deterministic Electron E2E, and live OpenRouter test pass; repository-wide pre-existing i18n/runtime-typecheck baselines are recorded separately.
13. E2E does not launch agents or mutate real user-project defaults.
